// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-manual-transcription-${randomUUID()}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, addToQueue, getQueueItems, updateQueueItem, queryOne } from '../database'
import { filterTranscribableRecordingIds } from '../recording-eligibility'

beforeAll(async () => {
  await initializeDatabase()
  for (const [id, personal, deleted] of [
    ['garbage', 0, null], ['personal', 1, null], ['deleted', 0, '2026-10-04']
  ] as const) {
    run('INSERT INTO recordings (id, filename, date_recorded, personal, deleted_at) VALUES (?, ?, ?, ?, ?)',
      [id, `${id}.wav`, '2026-10-04', personal, deleted])
    run('INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, quality_rating) VALUES (?, ?, ?, ?, ?)',
      [`cap-${id}`, id, '2026-10-04', id, 'garbage'])
  }
})
afterAll(() => closeDatabase())

describe('manual transcription value override', () => {
  it('bypasses only value exclusion and carries the owner request on the queue row', () => {
    const ids = ['garbage', 'personal', 'deleted', 'missing']
    expect([...filterTranscribableRecordingIds(ids).eligible]).toEqual([])
    expect([...filterTranscribableRecordingIds(ids, { ignoreValueExclusion: true }).eligible]).toEqual(['garbage'])
    expect(addToQueue('garbage')).toBe('')
    const queueId = addToQueue('garbage', undefined, { ownerRequested: true })
    expect(queueId).not.toBe('')
    expect(getQueueItems('pending').find((row) => row.id === queueId)?.owner_requested).toBe(true)
    for (const id of ['personal', 'deleted', 'missing']) {
      expect(addToQueue(id, undefined, { ownerRequested: true })).toBe('')
    }
  })

  it('fails closed on a lookup error even for an explicit request', () => {
    run('ALTER TABLE recordings RENAME TO recordings_unavailable')
    expect(filterTranscribableRecordingIds(['garbage'], { ignoreValueExclusion: true }).failClosed).toBe(true)
    expect(addToQueue('garbage', undefined, { ownerRequested: true })).toBe('')
    run('ALTER TABLE recordings_unavailable RENAME TO recordings')
  })

  it('persists owner intent through failure, retry, and database reopen', async () => {
    const queueId = getQueueItems('pending').find((row) => row.recording_id === 'garbage')!.id
    updateQueueItem(queueId, 'failed', 'Transient failure')
    expect(getQueueItems('failed').find((row) => row.id === queueId)?.owner_requested).toBe(true)
    updateQueueItem(queueId, 'pending')
    closeDatabase()
    await initializeDatabase()
    expect(getQueueItems('pending').find((row) => row.id === queueId)?.owner_requested).toBe(true)
    expect(queryOne<{ owner_requested: number }>('SELECT owner_requested FROM transcription_queue WHERE id = ?', [queueId])?.owner_requested).toBe(1)
    updateQueueItem(queueId, 'completed')
    expect(addToQueue('garbage')).toBe('')
    run("UPDATE knowledge_captures SET quality_rating = 'valuable' WHERE source_recording_id = 'garbage'")
    const automaticId = addToQueue('garbage')
    expect(automaticId).not.toBe(queueId)
    expect(getQueueItems('pending').find((row) => row.id === automaticId)?.owner_requested).toBe(false)
  })

  it('upgrades an existing automatic queue row when the owner requests it', () => {
    const automatic = getQueueItems('pending').find((row) => row.recording_id === 'garbage')!
    expect(addToQueue('garbage', undefined, { ownerRequested: true })).toBe(automatic.id)
    expect(queryOne<{ owner_requested: number }>('SELECT owner_requested FROM transcription_queue WHERE id = ?', [automatic.id])?.owner_requested).toBe(1)
  })

  it('migrates v71 queue history with a default of no owner request', async () => {
    const queueIds = getQueueItems().map((row) => row.id)
    // Retain the original column under another name to model the old schema
    // without discarding test data. v71 had no owner_requested column.
    run('ALTER TABLE transcription_queue RENAME COLUMN owner_requested TO owner_requested_before_migration')
    run('ALTER TABLE transcription_queue RENAME COLUMN explicit_request TO explicit_request_before_migration')
    run('ALTER TABLE schema_version RENAME TO schema_version_before_migration')
    run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    run('INSERT INTO schema_version (version) VALUES (71)')
    closeDatabase()
    await initializeDatabase()
    expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version).toBe(74)
    expect(getQueueItems().map((row) => row.id)).toEqual(queueIds)
    expect(getQueueItems().every((row) => row.owner_requested === false)).toBe(true)
    const column = queryOne<{ notnull: number; dflt_value: string }>(
      "SELECT [notnull], dflt_value FROM pragma_table_info('transcription_queue') WHERE name = 'owner_requested'"
    )
    expect(column).toEqual({ notnull: 1, dflt_value: '0' })
  })

  it.each([72, 73])('preserves durable owner intent when upgrading the v%s branch lineage', async (version) => {
    const id = `legacy-${version}`
    run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, CURRENT_TIMESTAMP)', [id, `${id}.wav`])
    const queueId = addToQueue(id, undefined, true)
    expect(queueId).not.toBe('')
    const missingColumn = version === 72 ? 'explicit_request' : 'owner_requested'
    run(`ALTER TABLE transcription_queue RENAME COLUMN ${missingColumn} TO ${missingColumn}_before_v${version}`)
    run(`ALTER TABLE schema_version RENAME TO schema_version_before_v${version}`)
    run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    run('INSERT INTO schema_version (version) VALUES (?)', [version])
    closeDatabase()
    await initializeDatabase()
    const restored = getQueueItems('pending').find(row => row.id === queueId)
    expect(restored).toMatchObject({ explicit_request: 1, owner_requested: true })
    expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version).toBe(74)
    for (const table of ['diarized_segments', 'transcript_withheld_metadata']) {
      expect(queryOne('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', table])).toEqual({ name: table })
    }
    expect(addToQueue(id, undefined, { ownerRequested: true })).toBe(queueId)
  })
})
