// @vitest-environment node

/**
 * Transcript integrity against a real SQLite database: the verdict is stored
 * with every new transcript, the owner can accept it, a replaced transcript
 * loses that acceptance, and the backfill labels transcripts stored before the
 * check existed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-integrity-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
}))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  insertTranscript,
  backfillTranscriptIntegrity,
  refreshTranscriptIntegrity,
  setTranscriptIntegrityAccepted,
} from '../database'

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
}

/** A recording whose length was measured from its file. */
function seed(id: string, seconds: number): void {
  run(
    `INSERT INTO recordings
       (id, filename, file_path, date_recorded, status, location, transcription_status,
        on_device, on_local, source, is_imported, duration_seconds, duration_source)
     VALUES (?, ?, NULL, '2026-09-23T10:00:00.000Z', 'none', 'local-only', 'complete', 0, 1, 'hidock', 0, ?, 'file')`,
    [id, `${id}.hda`, seconds]
  )
}

const segs = (list: Array<[number, string]>) =>
  JSON.stringify(list.map(([start, text]) => ({ speaker: 'SPEAKER_00', start, end: start, text })))

function row(id: string) {
  return queryOne<{
    integrity_status: string
    integrity_json: string
    integrity_version: number
    integrity_accepted_at: string | null
  }>('SELECT integrity_status, integrity_json, integrity_version, integrity_accepted_at FROM transcripts WHERE id = ?', [id])!
}

describe('transcript integrity storage', () => {
  beforeAll(async () => {
    cleanup()
    await initializeDatabase()
  })

  afterAll(() => {
    try {
      closeDatabase()
    } catch {
      /* already closed */
    }
    cleanup()
  })

  it('stores a verdict with every new transcript', () => {
    seed('rec-ok', 60)
    insertTranscript({ id: 'tx-ok', recording_id: 'rec-ok', full_text: 'x', language: 'es', speakers: segs([[0, 'hola'], [5, 'chau']]) })
    expect(row('tx-ok').integrity_status).toBe('ok')
    expect(row('tx-ok').integrity_version).toBe(1)

    seed('rec-rep', 60)
    insertTranscript({ id: 'tx-rep', recording_id: 'rec-rep', full_text: 'x', language: 'es', speakers: segs([[0, 'a'], [9, 'b'], [9, 'c']]) })
    expect(row('tx-rep').integrity_status).toBe('suspect')
    expect(JSON.parse(row('tx-rep').integrity_json).issues[0].code).toBe('repeated_start')
  })

  it('judges text against the measured audio length', () => {
    seed('rec-short', 18)
    const words = Array.from({ length: 1677 }, (_, i) => `w${i}`).join(' ')
    insertTranscript({ id: 'tx-short', recording_id: 'rec-short', full_text: words, language: 'es', speakers: segs([[0, words]]) })
    expect(row('tx-short').integrity_status).toBe('broken')
  })

  it('lets the owner accept a flagged transcript, and a replacement loses the acceptance', () => {
    seed('rec-acc', 60)
    const flagged = segs([[0, 'a'], [3, 'b'], [3, 'c']])
    insertTranscript({ id: 'tx-acc', recording_id: 'rec-acc', full_text: 'x', language: 'es', speakers: flagged })

    expect(setTranscriptIntegrityAccepted('rec-acc', true)).toBe(true)
    expect(row('tx-acc').integrity_accepted_at).not.toBeNull()

    // A backfill under the same rules keeps it: the text has not changed.
    backfillTranscriptIntegrity()
    expect(row('tx-acc').integrity_accepted_at).not.toBeNull()

    // A new transcription replaces the row, and with it what was accepted.
    insertTranscript({ id: 'tx-acc', recording_id: 'rec-acc', full_text: 'x', language: 'es', speakers: flagged })
    expect(row('tx-acc').integrity_accepted_at).toBeNull()

    expect(setTranscriptIntegrityAccepted('rec-acc', true)).toBe(true)
    expect(setTranscriptIntegrityAccepted('rec-acc', false)).toBe(true)
    expect(row('tx-acc').integrity_accepted_at).toBeNull()
    expect(setTranscriptIntegrityAccepted('rec-without-transcript', true)).toBe(false)
  })

  it('checks again after the segments are rewritten, dropping an acceptance', () => {
    seed('rec-up', 60)
    insertTranscript({ id: 'tx-up', recording_id: 'rec-up', full_text: 'x', language: 'es', speakers: segs([[0, 'a'], [3, 'b'], [3, 'c']]) })
    setTranscriptIntegrityAccepted('rec-up', true)

    run('UPDATE transcripts SET speakers = ? WHERE id = ?', [segs([[0, 'a'], [3, 'b'], [6, 'c']]), 'tx-up'])
    expect(refreshTranscriptIntegrity('tx-up')?.status).toBe('ok')
    expect(row('tx-up').integrity_status).toBe('ok')
    expect(row('tx-up').integrity_accepted_at).toBeNull()
  })

  it('labels transcripts stored before the check existed, once', () => {
    seed('rec-old', 60)
    insertTranscript({ id: 'tx-old', recording_id: 'rec-old', full_text: 'x', language: 'es', speakers: segs([[10, 'a'], [4, 'b']]) })
    run('UPDATE transcripts SET integrity_status = NULL, integrity_json = NULL, integrity_version = NULL WHERE id = ?', ['tx-old'])

    const first = backfillTranscriptIntegrity()
    expect(first.checked).toBe(1)
    expect(first.suspect).toBe(1)
    expect(row('tx-old').integrity_status).toBe('suspect')
    expect(backfillTranscriptIntegrity().checked).toBe(0)
  })
})
