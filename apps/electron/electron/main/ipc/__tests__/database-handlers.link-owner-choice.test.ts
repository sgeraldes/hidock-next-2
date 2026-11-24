// @vitest-environment node

/**
 * CL-08: db:link-recording-to-meeting must say so when the database refuses the
 * link, instead of returning the unchanged row as if it had worked. REAL handler,
 * REAL SQLite (temp file, synthetic rows). Not Electron runtime evidence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-link-owner-choice-ipc-${process.pid}.sqlite`)
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../../services/org-reconciler', () => ({ autoLinkRecordingsToMeetings: () => {} }))

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) } }
}))

import { initializeDatabase, closeDatabase, run, getRecordingById } from '../../services/database'
import { registerDatabaseHandlers } from '../database-handlers'

function invoke(channel: string, ...args: any[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(fn({} as any, ...args))
}

beforeEach(async () => {
  handlers.clear()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
  registerDatabaseHandlers()
  for (const id of ['m-1', 'm-2']) {
    run(
      `INSERT INTO meetings (id, subject, start_time, end_time, is_recurring, created_at, updated_at)
       VALUES (?, 'Synthetic', '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z', 0, '2026-01-01', '2026-01-01')`,
      [id]
    )
  }
  run(
    `INSERT INTO recordings (id, filename, date_recorded, meeting_id, correlation_confidence, correlation_method)
     VALUES ('rec-owner', 'a.hda', '2026-10-07T15:10:00.000Z', 'm-1', 1, 'user_override')`
  )
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec-free', 'b.hda', '2026-10-07T15:10:00.000Z')`)
})

afterEach(() => {
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('db:link-recording-to-meeting', () => {
  it('rejects an automatic method over an owner choice and leaves the row as it was', async () => {
    await expect(invoke('db:link-recording-to-meeting', 'rec-owner', 'm-2', 0.99, 'jev_content_match')).rejects.toThrow(
      /not linked/
    )
    const rec = getRecordingById('rec-owner')!
    expect([rec.meeting_id, rec.correlation_method]).toEqual(['m-1', 'user_override'])
  })

  it('links with an automatic method when there is no owner choice, and returns the updated row', async () => {
    const rec = await invoke('db:link-recording-to-meeting', 'rec-free', 'm-2', 0.8, 'ai_transcript_match')
    expect([rec.meeting_id, rec.correlation_method]).toEqual(['m-2', 'ai_transcript_match'])
  })

  it('lets the owner change an owner choice with an explicit human method', async () => {
    const rec = await invoke('db:link-recording-to-meeting', 'rec-owner', 'm-2', 1, 'manual')
    expect([rec.meeting_id, rec.correlation_method]).toEqual(['m-2', 'manual'])
  })

  it('rejects a recording that does not exist instead of returning null as a success', async () => {
    await expect(invoke('db:link-recording-to-meeting', 'no-such', 'm-1', 1, 'manual')).rejects.toThrow(/not linked/)
  })
})
