// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-manual-transcription-${randomUUID()}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, addToQueue, getQueueItems } from '../database'
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
})
