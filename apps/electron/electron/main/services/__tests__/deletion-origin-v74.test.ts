// @vitest-environment node

/**
 * v74: who asked for each deletion.
 *
 * deletion_journal and purged_files recorded what was deleted and when, never
 * who asked. The owner approved recording it (24-nov-2026): an origin ('user',
 * 'system' or 'sync'), the caller or feature, and the app version. Rows written
 * before v74 keep NULL in all three.
 *
 * The same boot also leaves the engine's schema_migration_audit row with this
 * app's version and the verified pre-migration backup.
 *
 * Real temp database, real database.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

const dbPath = join(tmpdir(), `hidock-v74-deletion-origin-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../sqlite-backup-host', () =>
  import('./helpers/in-process-sqlite-backup-host').then((m) => m.inProcessSqliteBackupHost())
)

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryAll,
  queryOne,
  deleteRecordingCascade,
  commitRecordingSplit,
  setGraphProvenanceCleanup,
  getDatabase,
} from '../database'
import { getTableColumns } from '@hidock/database'

const getTableColumnsForTest = (table: string): string[] => getTableColumns(getDatabase(), table)

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)
const ORIGIN_COLUMNS = ['requested_origin', 'requested_by', 'app_version']
const APP_VERSION = '2.0.0-v74-test'

function removeDbFiles(): void {
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  for (const file of readdirSync(dir)) {
    if (file === base || file === `${base}-wal` || file === `${base}-shm` || file.startsWith(`${base}.bak-`)) {
      rmSync(join(dir, file), { force: true })
    }
  }
}

function seedRecording(id: string): void {
  run(
    `INSERT INTO recordings
       (id, filename, original_filename, file_path, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported)
     VALUES (?, ?, ?, ?, '2026-01-01T10:00:00.000Z', 'none', 'local-only', 'none', 0, 1, 'hidock', 0)`,
    [id, `${id}.wav`, `${id}.hda`, `/data/${id}.wav`]
  )
}

const graphOk = () => ({
  ok: true,
  markersRemoved: 0,
  edgesRemoved: 0,
  edgeSourceRowsRemoved: 0,
  meetingNodesRemoved: 0,
  orphanNodesRemoved: 0,
})

beforeEach(async () => {
  try { closeDatabase() } catch { /* not open */ }
  removeDbFiles()
  await initializeDatabase({ appVersion: APP_VERSION })
  setGraphProvenanceCleanup(graphOk)
})

afterEach(() => {
  setGraphProvenanceCleanup(null)
  closeDatabase()
  removeDbFiles()
})

describe('v74 schema', () => {
  it('a fresh database has the origin columns on both tables', () => {
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
    expect(EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(74)
    for (const table of ['deletion_journal', 'purged_files']) {
      expect(getTableColumnsForTest(table)).toEqual(expect.arrayContaining(ORIGIN_COLUMNS))
    }
  })

  it('a database at v73 gains the columns, keeps old rows with NULL, and audits the migration', async () => {
    // Rebuild both tables in their v73 shape, with a row each.
    run('DROP TABLE deletion_journal')
    run(`CREATE TABLE deletion_journal (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('soft', 'hard')),
      recording_snapshot TEXT, removed_counts TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, restored_at TEXT)`)
    run('DROP TABLE purged_files')
    run('CREATE TABLE purged_files (filename TEXT PRIMARY KEY, purged_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    run("INSERT INTO deletion_journal (id, recording_id, mode) VALUES ('old-j', 'old-r', 'soft')")
    run("INSERT INTO purged_files (filename) VALUES ('old.hda')")
    run('DELETE FROM schema_version WHERE version >= 74')
    run('DROP TABLE IF EXISTS schema_migration_audit')
    closeDatabase()

    await initializeDatabase({ appVersion: APP_VERSION })

    for (const table of ['deletion_journal', 'purged_files']) {
      expect(getTableColumnsForTest(table)).toEqual(expect.arrayContaining(ORIGIN_COLUMNS))
    }
    expect(queryOne("SELECT requested_origin, requested_by, app_version FROM deletion_journal WHERE id = 'old-j'")).toEqual({
      requested_origin: null, requested_by: null, app_version: null,
    })
    expect(queryOne("SELECT requested_origin, requested_by, app_version FROM purged_files WHERE filename = 'old.hda'")).toEqual({
      requested_origin: null, requested_by: null, app_version: null,
    })
    const audit = queryAll<{ from_version: number; to_version: number; app_version: string; backup_made: number; backup_path: string; outcome: string }>(
      'SELECT * FROM schema_migration_audit'
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ from_version: 73, to_version: EXPECTED_SCHEMA_VERSION, app_version: APP_VERSION, backup_made: 1, outcome: 'completed' })
    expect(existsSync(audit[0].backup_path)).toBe(true)
  })

  it('refuses an origin outside user, system and sync', () => {
    expect(() =>
      run("INSERT INTO deletion_journal (id, recording_id, mode, requested_origin) VALUES ('x', 'r', 'soft', 'agent')")
    ).toThrow(/CHECK/)
  })
})

describe('deletion paths record who asked', () => {
  it('a soft delete journals the origin, the feature and the app version', () => {
    seedRecording('rec-soft')
    deleteRecordingCascade('rec-soft', { hard: false, origin: 'user', requestedBy: 'library:move-to-trash' })
    expect(queryOne("SELECT mode, requested_origin, requested_by, app_version FROM deletion_journal WHERE recording_id = 'rec-soft'")).toEqual({
      mode: 'soft', requested_origin: 'user', requested_by: 'library:move-to-trash', app_version: APP_VERSION,
    })
  })

  it('a hard purge journals it and stamps every tombstone it writes', () => {
    seedRecording('rec-hard')
    deleteRecordingCascade('rec-hard', { hard: true, origin: 'sync', requestedBy: 'test:hard' })
    expect(queryOne("SELECT mode, requested_origin, requested_by, app_version FROM deletion_journal WHERE recording_id = 'rec-hard'")).toEqual({
      mode: 'hard', requested_origin: 'sync', requested_by: 'test:hard', app_version: APP_VERSION,
    })
    const tombstones = queryAll<{ filename: string; requested_origin: string; requested_by: string; app_version: string }>(
      "SELECT filename, requested_origin, requested_by, app_version FROM purged_files WHERE filename LIKE 'rec-hard.%' ORDER BY filename"
    )
    expect(tombstones.map((t) => t.filename)).toEqual(['rec-hard.hda', 'rec-hard.mp3', 'rec-hard.wav'])
    for (const t of tombstones) {
      expect(t).toMatchObject({ requested_origin: 'sync', requested_by: 'test:hard', app_version: APP_VERSION })
    }
  })

  it('a split journals its parent with the split as the requester', () => {
    seedRecording('rec-split')
    const child = (id: string, part: number) => ({
      id,
      filename: `rec-split - Part ${part}.flac`,
      original_filename: 'rec-split.hda',
      file_path: `/data/rec-split - Part ${part}.flac`,
      file_size: 1000,
      duration_seconds: 60,
      date_recorded: `2026-01-01T1${part}:00:00.000Z`,
      status: 'ready',
      location: 'local-only' as const,
      transcription_status: 'none' as const,
      on_device: 0,
      on_local: 1,
      source: 'hidock' as const,
      is_imported: 0,
    })
    commitRecordingSplit('rec-split', [child('rec-split-a', 1), child('rec-split-b', 2)], {
      origin: 'user',
      requestedBy: 'recordings:split',
    })
    expect(queryOne("SELECT mode, requested_origin, requested_by, app_version FROM deletion_journal WHERE recording_id = 'rec-split'")).toEqual({
      mode: 'soft', requested_origin: 'user', requested_by: 'recordings:split', app_version: APP_VERSION,
    })
  })

  it('refuses a deletion that does not say who asked', () => {
    seedRecording('rec-anon')
    expect(() =>
      deleteRecordingCascade('rec-anon', { hard: false, origin: 'user', requestedBy: '' })
    ).toThrow(/requestedBy/)
    expect(() =>
      deleteRecordingCascade('rec-anon', { hard: false, origin: 'nobody' as 'user', requestedBy: 'x' })
    ).toThrow(/origin/)
    expect(queryOne("SELECT deleted_at FROM recordings WHERE id = 'rec-anon'")).toEqual({ deleted_at: null })
  })
})
