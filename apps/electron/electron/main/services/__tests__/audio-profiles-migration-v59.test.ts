// @vitest-environment node

/**
 * v59 — audio_profiles (recording checks).
 *
 *  1. A fresh database has the table with every column the store writes.
 *  2. A database at v58 gains the table on the next boot, and nothing else moves.
 *  3. A profile goes with its recording when the recording row is removed.
 *
 * Real temp database, real database.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbPath = join(tmpdir(), `hidock-v59-audio-profiles-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll, queryOne } from '../database'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

const COLUMNS = [
  'recording_id', 'version', 'method', 'file_size', 'file_mtime_ms', 'duration_seconds', 'sound_seconds',
  'sound_share', 'longest_sound_seconds', 'median_level', 'spike_count', 'category', 'ranges_json', 'computed_at',
]

const columns = () => queryAll<{ name: string }>("SELECT name FROM pragma_table_info('audio_profiles')").map((r) => r.name)

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

describe('v59 audio_profiles', () => {
  it('is at the current schema version with the table in place', () => {
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
    expect(columns().sort()).toEqual([...COLUMNS].sort())
  })

  it('adds the table to a database at v58 on the next boot', async () => {
    run('DROP TABLE audio_profiles')
    run('DELETE FROM schema_version WHERE version >= 59')
    closeDatabase()
    await initializeDatabase()
    expect(columns().sort()).toEqual([...COLUMNS].sort())
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })

  it('removes a profile with its recording', () => {
    run(
      `INSERT INTO recordings (id, filename, file_path, date_recorded, status, location, transcription_status,
          on_device, on_local, source, is_imported)
       VALUES ('r1', 'r1.wav', NULL, '2026-09-24T00:00:00.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0)`
    )
    run(
      `INSERT INTO audio_profiles (recording_id, version, method, category, computed_at)
       VALUES ('r1', 1, 'mp3-frame-gain', 'silent', '2026-09-24T00:00:00.000Z')`
    )
    run('DELETE FROM recordings WHERE id = ?', ['r1'])
    expect(queryOne('SELECT * FROM audio_profiles WHERE recording_id = ?', ['r1'])).toBeFalsy()
  })
})
