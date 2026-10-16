// @vitest-environment node

/**
 * The engine chain's attempt log against a real SQLite database: rows come
 * back oldest first, a long provider message is cut, and deleting the
 * recording removes its attempts (16-oct-2026).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-attempts-store-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-attempts-cache-${process.pid}-${Date.now()}`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
}))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }) }))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))

import { initializeDatabase, closeDatabase, run, queryOne } from '../database'
import { getTranscriptionAttempts, recordTranscriptionAttempt } from '../transcription-attempts-store'

function seed(id: string): void {
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, NULL, 600, '2026-10-14T09:15:58.000Z', 'complete', 'local-only', 'error', 0, 1, 'hidock', 0, 0)`,
    [id, `2026Oct14-091558-${id}.hda`]
  )
}

const base = { startedAt: '2026-10-16T10:00:00.000Z', durationMs: 1200, waitedSeconds: 0 }

beforeAll(async () => {
  await initializeDatabase()
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
  if (existsSync(paths.cache)) rmSync(paths.cache, { recursive: true, force: true })
})

describe('transcription attempts store', () => {
  it('keeps every attempt of a chain in order, with the reason of each failure', () => {
    seed('rec-a')
    recordTranscriptionAttempt('rec-a', 'q-1', { ...base, engine: 'gemini', attempt: 1, outcome: 'failed', errorClass: 'quota',
      message: '429 Rate limit exceeded. Please retry in 39s', waitedSeconds: 0 })
    recordTranscriptionAttempt('rec-a', 'q-1', { ...base, engine: 'gemini', attempt: 2, outcome: 'failed', errorClass: 'quota',
      message: '429 again', waitedSeconds: 41 })
    recordTranscriptionAttempt('rec-a', 'q-1', { ...base, engine: 'remote:moondream/parakeet-ultra', attempt: 1, outcome: 'succeeded' })

    const attempts = getTranscriptionAttempts('rec-a')
    expect(attempts.map((a) => `${a.engine}#${a.attempt}:${a.outcome}`)).toEqual([
      'gemini#1:failed', 'gemini#2:failed', 'remote:moondream/parakeet-ultra#1:succeeded',
    ])
    expect(attempts[1]).toMatchObject({ queueItemId: 'q-1', errorClass: 'quota', waitedSeconds: 41 })
    expect(attempts[2].errorClass).toBeUndefined()
  })

  it('cuts a long provider message and keeps only the most recent attempts when asked', () => {
    seed('rec-b')
    for (let i = 1; i <= 5; i++) {
      recordTranscriptionAttempt('rec-b', null, { ...base, engine: 'gemini', attempt: i, outcome: 'failed', errorClass: 'transient',
        message: 'x'.repeat(5000) })
    }
    const lastTwo = getTranscriptionAttempts('rec-b', 2)
    expect(lastTwo.map((a) => a.attempt)).toEqual([4, 5])
    expect(lastTwo[0].message).toHaveLength(2000)
  })

  it('removes the attempts with the recording', () => {
    seed('rec-c')
    recordTranscriptionAttempt('rec-c', null, { ...base, engine: 'gemini', attempt: 1, outcome: 'succeeded' })
    run('DELETE FROM recordings WHERE id = ?', ['rec-c'])
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM transcription_attempts WHERE recording_id = ?', ['rec-c'])?.n).toBe(0)
  })
})
