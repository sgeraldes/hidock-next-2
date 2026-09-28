// @vitest-environment node

/**
 * v60: index on transcription_queue(recording_id, created_at).
 *
 * getActionableQueueItems looks up the latest attempt per recording on every
 * Operations poll; without this index the lookup scans the whole queue once
 * per failed row on the main thread.
 *
 *  1. A fresh database has the index and the query plan uses it.
 *  2. A database at v59 gains the index on the next boot.
 *
 * Real temp database, real database.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbPath = join(tmpdir(), `hidock-v60-queue-index-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll, queryOne } from '../database'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

const hasIndex = () =>
  queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_queue_recording'"
  )?.name === 'idx_queue_recording'

beforeEach(async () => {
  try {
    closeDatabase()
  } catch {
    /* not open */
  }
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
})

afterEach(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
})

describe('v60 transcription_queue(recording_id) index', () => {
  it('is at the current schema version and the latest-attempt lookup uses the index', () => {
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
    expect(hasIndex()).toBe(true)
    const plan = queryAll<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT 1 FROM transcription_queue WHERE recording_id = 'r1' AND created_at > '2026-01-01'"
    ).map((r) => r.detail).join(' ')
    expect(plan).toContain('idx_queue_recording')
  })

  it('adds the index to a database at v59 on the next boot', async () => {
    run('DROP INDEX idx_queue_recording')
    run('DELETE FROM schema_version WHERE version >= 60')
    closeDatabase()
    await initializeDatabase()
    expect(hasIndex()).toBe(true)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })
})
