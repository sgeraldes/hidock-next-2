// @vitest-environment node

/**
 * Voice-conflict suggestions (spec 2026-10-03, 2d) are written by applyKnownVoiceBindings into
 * identity_suggestions. The generic accept writes candidate_name as an alias, and a voice
 * conflict's candidate_name is a key (voice-conflict:<recording>:<label>), so the generic list
 * leaves them out and the generic accept and reject refuse them. People answers them through
 * identity:resolveVoiceConflict (identity-handlers.decisions.test.ts). REAL handlers, REAL DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-voice-conflict-ipc-${process.pid}.sqlite`)
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => dbPath }))

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) } }
}))

import {
  acceptIdentitySuggestion,
  closeDatabase,
  initializeDatabase,
  insertIdentitySuggestion,
  queryAll,
  queryOne,
  rejectIdentitySuggestion,
  run,
  runInTransaction
} from '../../services/database'
import { recordVoiceConflictNoSave } from '../../services/speaker-linking'
import { registerIdentityHandlers } from '../identity-handlers'

function invoke(channel: string, ...args: any[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(fn({} as any, ...args))
}

function contact(id: string, name: string): void {
  run(
    `INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
     VALUES (?, ?, 'unknown', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'user')`,
    [id, name]
  )
}

function seedConflict(): string {
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec', 'rec.wav', '2026-10-01T10:00:00Z')`)
  runInTransaction(() => {
    recordVoiceConflictNoSave({
      recordingId: 'rec',
      speakerLabel: 'Speaker 1',
      voiceClusterId: null,
      similarity: 0.93,
      voiceContactId: 'carl',
      boundContactId: 'dana',
      boundSource: 'manual'
    })
  })
  return queryOne<{ id: string }>("SELECT id FROM identity_suggestions WHERE candidate_name LIKE 'voice-conflict:%'")!.id
}

const aliases = () => queryAll<{ alias_norm: string }>('SELECT alias_norm FROM contact_aliases')
const status = (id: string) => queryOne<{ status: string }>('SELECT status FROM identity_suggestions WHERE id = ?', [id])!.status

beforeEach(async () => {
  handlers.clear()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
  registerIdentityHandlers()
  contact('carl', 'Carl Ruiz')
  contact('dana', 'Dana Soto')
})

afterEach(() => {
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('voice-conflict suggestions in the generic suggestion list', () => {
  it('are not listed there; the other suggestions still are', async () => {
    seedConflict()
    // A discovery straggler (name signal only), which the page lists today.
    insertIdentitySuggestion('person', 'Carlitos', 'carl', 0.7, {
      signals: { name: 0.7, email: 0, role: 0, graph: 0 },
      composite: 0.7
    })

    const res = await invoke('identity:getSuggestions', 'pending')

    expect(res.success).toBe(true)
    const names = (res.data as Array<{ candidate_name: string }>).map((s) => s.candidate_name)
    expect(names).toContain('Carlitos')
    expect(names.filter((n) => n.startsWith('voice-conflict:'))).toEqual([])
  })

  it('accept refuses one with a clear error and writes no alias', async () => {
    const id = seedConflict()

    const res = await invoke('identity:acceptSuggestion', id)

    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VOICE_CONFLICT')
    expect(res.error.message).toMatch(/voice conflict/i)
    expect(status(id)).toBe('pending')
    expect(aliases()).toEqual([])
  })

  it('reject refuses one too: it would write the key as a rejected alias', async () => {
    const id = seedConflict()

    const res = await invoke('identity:rejectSuggestion', id)

    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VOICE_CONFLICT')
    expect(status(id)).toBe('pending')
    expect(aliases()).toEqual([])
  })

  it('the service functions refuse it as well, whoever calls them', () => {
    const id = seedConflict()
    expect(() => acceptIdentitySuggestion(id)).toThrow(/voice conflict/i)
    expect(() => rejectIdentitySuggestion(id)).toThrow(/voice conflict/i)
    expect(status(id)).toBe('pending')
    expect(aliases()).toEqual([])
  })
})
