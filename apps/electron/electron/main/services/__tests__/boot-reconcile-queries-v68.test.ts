// @vitest-environment node

/**
 * The two queries that held the window at boot and after every calendar sync
 * (4-oct-2026, measured on a copy of the real library: 2,164 recordings, 6,615
 * meetings, 26,887 meeting links):
 *
 *  1. getEligibleRecordingIds checked each recording against knowledge_captures
 *     with no index on source_recording_id, a full scan per recording: 99 ms for
 *     400 ids, 2.3 ms with the v68 index. Every eligibility check in the app runs it.
 *  2. The bucket split's per-bucket recordings query started from every recording
 *     instead of from the bucket's meeting links: 336 ms for 40 buckets, 121 ms
 *     when it starts from idx_meeting_contacts_contact.
 *
 * Real temp database, real database.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbPath = join(tmpdir(), `hidock-v68-boot-queries-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll, queryOne, BUCKET_RECORDINGS_SQL } from '../database'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

const INDEX = 'idx_knowledge_captures_source_recording'
const hasIndex = () =>
  queryOne<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [INDEX])?.name === INDEX
const plan = (sql: string, params: unknown[] = []) =>
  queryAll<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
    .map((r) => r.detail)
    .join(' | ')

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

describe('v68 knowledge_captures(source_recording_id) index', () => {
  it('is on a fresh database, and the eligibility check looks captures up through it', () => {
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
    expect(hasIndex()).toBe(true)
    expect(plan('SELECT 1 FROM knowledge_captures kc WHERE kc.source_recording_id = ? AND kc.deleted_at IS NULL', ['r1'])).toContain(
      INDEX
    )
  })

  it('is added to a database at v67 on the next boot', async () => {
    run(`DROP INDEX ${INDEX}`)
    run('DELETE FROM schema_version WHERE version >= 68')
    closeDatabase()
    await initializeDatabase()
    expect(hasIndex()).toBe(true)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })
})

describe('the bucket split recordings query', () => {
  it("starts from the bucket's meeting links, not from every recording", () => {
    const detail = plan(BUCKET_RECORDINGS_SQL, ['c1'])
    expect(detail.split(' | ')[0]).toContain('idx_meeting_contacts_contact')
  })

  it('returns the bucket recordings, newest first, without personal or deleted ones', () => {
    run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('m1', 'Weekly', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z')`)
    run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('m2', 'Other', '2026-01-03T10:00:00Z', '2026-01-03T11:00:00Z')`)
    run(
      `INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at) VALUES ('c1', 'Sergio', 'unknown', '2026-01-01', '2026-01-01')`
    )
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES ('m1', 'c1', 'attendee', 'calendar')`)
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES ('m2', 'c1', 'attendee', 'calendar')`)
    const rec = (id: string, meetingId: string, date: string, extra = '') =>
      run(
        `INSERT INTO recordings (id, filename, file_path, date_recorded, meeting_id${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES (?, ?, ?, ?, ?${extra ? ', ' + extra.split('=')[1] : ''})`,
        [id, `${id}.hda`, `/x/${id}.hda`, date, meetingId]
      )
    rec('r-old', 'm1', '2026-01-02T10:05:00Z')
    rec('r-new', 'm2', '2026-01-03T10:05:00Z')
    rec('r-personal', 'm1', '2026-01-02T10:30:00Z', 'personal=1')
    rec('r-deleted', 'm2', '2026-01-03T10:30:00Z', "deleted_at='2026-01-04'")

    const rows = queryAll<{ recordingId: string; meetingId: string; subject: string }>(BUCKET_RECORDINGS_SQL, ['c1'])

    expect(rows.map((r) => [r.recordingId, r.meetingId, r.subject])).toEqual([
      ['r-new', 'm2', 'Other'],
      ['r-old', 'm1', 'Weekly']
    ])
  })
})
