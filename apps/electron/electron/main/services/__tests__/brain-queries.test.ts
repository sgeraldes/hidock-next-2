// @vitest-environment node

/**
 * brain-queries — what an agent can learn through the brain API, and above all
 * what it cannot.
 *
 * The owner marks a recording personal or deletes it, and from then on it and
 * everything derived from it are supposed to stay away from assistants. The old
 * CDP bridge broke that promise in one place: agents called
 * `recordings.getForMeeting`, which returns every recording of a meeting with
 * its full transcript and gates nothing, because it serves the owner's own
 * meeting page. These tests hold the brain to the promise on every route.
 * Real better-sqlite3 engine, real eligibility gate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-brainqueries-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
}))

import { initializeDatabase, closeDatabase, run, runWithMassDeleteAllowed } from '../database'
import {
  meetingsSince,
  meetingRecordings,
  transcriptForRecording,
  knowledgeByIds,
  knowledgeById,
  pendingActionablesSince,
  actionableById,
} from '../brain-queries'

function cleanupDbFiles(base: string): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${base}${suffix}`)) rmSync(`${base}${suffix}`, { force: true })
  }
}

const TABLES = ['actionables', 'transcripts', 'knowledge_captures', 'recordings', 'meetings']

function seedMeeting(id: string, start: string, end: string, allDay = 0): void {
  run('INSERT INTO meetings (id, subject, start_time, end_time, is_all_day) VALUES (?, ?, ?, ?, ?)', [
    id,
    `Meeting ${id}`,
    start,
    end,
    allDay,
  ])
}

function seedRecording(id: string, meetingId: string, opts: { personal?: boolean; deleted?: boolean } = {}): void {
  run(
    `INSERT INTO recordings
       (id, filename, file_path, date_recorded, duration_seconds, meeting_id, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal, deleted_at)
     VALUES (?, ?, ?, ?, 600, ?, 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, ?, ?)`,
    [
      id,
      `${id}.wav`,
      `/tmp/${id}.wav`,
      '2026-09-10T10:00:00.000Z',
      meetingId,
      opts.personal ? 1 : 0,
      opts.deleted ? '2026-09-11T00:00:00.000Z' : null,
    ]
  )
  run('INSERT INTO transcripts (id, recording_id, full_text, word_count) VALUES (?, ?, ?, ?)', [
    `t-${id}`,
    id,
    `the words of ${id}`,
    4,
  ])
}

function seedCapture(id: string, recordingId: string | null): void {
  run(
    `INSERT INTO knowledge_captures (id, title, summary, captured_at, source_recording_id)
     VALUES (?, ?, ?, ?, ?)`,
    [id, `Capture ${id}`, `summary of ${id}`, '2026-09-10T10:00:00.000Z', recordingId]
  )
}

function seedActionable(id: string, captureId: string, status = 'pending', createdAt = '2026-09-16T10:00:00.000Z'): void {
  run(
    `INSERT INTO actionables (id, type, title, source_knowledge_id, status, confidence, created_at)
     VALUES (?, 'follow_up', ?, ?, ?, 0.9, ?)`,
    [id, `Actionable ${id}`, captureId, status, createdAt]
  )
}

beforeAll(async () => {
  cleanupDbFiles(paths.db)
  await initializeDatabase()
})

afterAll(() => {
  try {
    closeDatabase()
  } catch {
    /* ignore */
  }
  cleanupDbFiles(paths.db)
})

beforeEach(() => {
  runWithMassDeleteAllowed(() => {
    for (const table of TABLES) run(`DELETE FROM ${table}`)
  })
  seedMeeting('m1', '2026-09-10T10:00:00.000Z', '2026-09-10T11:00:00.000Z')
  seedRecording('open', 'm1')
  seedRecording('private', 'm1', { personal: true })
  seedRecording('trashed', 'm1', { deleted: true })
  seedCapture('cap-open', 'open')
  seedCapture('cap-private', 'private')
  seedCapture('cap-trashed', 'trashed')
  seedActionable('act-open', 'cap-open')
  seedActionable('act-private', 'cap-private')
  seedActionable('act-trashed', 'cap-trashed')
})

describe('a meeting\'s recordings', () => {
  it('leaves out personal and deleted recordings, transcript and all', () => {
    // The one route where the old bridge leaked: getForMeeting gates nothing.
    const ids = meetingRecordings('m1').map((r) => (r as { id: string }).id)
    expect(ids).toEqual(['open'])
  })

  it('still attaches the transcript of the recordings it does return', () => {
    const [only] = meetingRecordings('m1') as Array<{ transcript?: { full_text?: string } }>
    expect(only.transcript?.full_text).toBe('the words of open')
  })

  it('returns nothing for an id that is not an id', () => {
    expect(meetingRecordings('')).toEqual([])
    expect(meetingRecordings('x'.repeat(500))).toEqual([])
    expect(meetingRecordings(42)).toEqual([])
  })
})

describe('a transcript', () => {
  it('is returned for an eligible recording', () => {
    expect((transcriptForRecording('open') as { full_text: string }).full_text).toBe('the words of open')
  })

  it('is withheld for a personal or deleted recording', () => {
    expect(transcriptForRecording('private')).toBeNull()
    expect(transcriptForRecording('trashed')).toBeNull()
  })
})

describe('knowledge captures', () => {
  it('omit the ones derived from excluded recordings', () => {
    const ids = knowledgeByIds(['cap-open', 'cap-private', 'cap-trashed']).map((k) => k.id)
    expect(ids).toEqual(['cap-open'])
  })

  it('answer null for a single excluded capture', () => {
    expect(knowledgeById('cap-open')?.summary).toBe('summary of cap-open')
    expect(knowledgeById('cap-private')).toBeNull()
  })

  it('come back in the camelCase shape the old bridge callers read', () => {
    const capture = knowledgeById('cap-open')
    expect(capture).toMatchObject({ id: 'cap-open', capturedAt: '2026-09-10T10:00:00.000Z', sourceRecordingId: 'open' })
  })
})

describe('actionables', () => {
  it('omit the ones whose source capture is excluded', () => {
    // This list feeds the board through coverage/ingest.py.
    const ids = pendingActionablesSince('2026-09-01').map((a) => a.id)
    expect(ids).toEqual(['act-open'])
  })

  it('respect the since bound and the pending status', () => {
    seedActionable('act-old', 'cap-open', 'pending', '2026-08-01T10:00:00.000Z')
    seedActionable('act-done', 'cap-open', 'dismissed')
    const ids = pendingActionablesSince('2026-09-01').map((a) => a.id)
    expect(ids).toEqual(['act-open'])
  })

  it('come back with the fields ingest.py reads', () => {
    const [a] = pendingActionablesSince('2026-09-01')
    expect(a).toMatchObject({
      id: 'act-open',
      title: 'Actionable act-open',
      type: 'follow_up',
      sourceKnowledgeId: 'cap-open',
      createdAt: '2026-09-16T10:00:00.000Z',
      status: 'pending',
    })
  })

  it('answer null for one by id when its source is excluded', () => {
    expect(actionableById('act-open')).not.toBeNull()
    expect(actionableById('act-private')).toBeNull()
  })
})

describe('meetings since a date', () => {
  it('leave out all-day events and meetings that have not started yet', () => {
    seedMeeting('allday', '2026-09-12T00:00:00.000Z', '2026-09-13T00:00:00.000Z', 1)
    seedMeeting('future', '2099-01-01T10:00:00.000Z', '2099-01-01T11:00:00.000Z')
    seedMeeting('before', '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z')
    const ids = meetingsSince('2026-09-01', new Date('2026-09-22T12:00:00.000Z')).map((m) => m.id)
    expect(ids).toEqual(['m1'])
  })
})
