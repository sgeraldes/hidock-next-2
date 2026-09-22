// @vitest-environment node

/**
 * Duration backfill + low-value classifier tests (real better-sqlite3 engine).
 *
 * Verifies the data-layer fix for the Library: recordings.duration_seconds is
 * NULL on the download/import paths, so DB/client sort+filter by duration
 * returns nothing. backfillRecordingDurations() populates it from the cheapest
 * reliable sources already in the DB (device-file cache + transcript timing),
 * and classifyLowValueCaptures() gives the "clean up junk" filter real data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-durationtest-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db
}))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  queryAll,
  runWithMassDeleteAllowed,
  backfillRecordingDurations,
  classifyLowValueCaptures,
  maxTranscriptSegmentEnd
} from '../database'

function cleanupDbFiles(base: string): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${base}${suffix}`)) rmSync(`${base}${suffix}`, { force: true })
  }
}

const DATA_TABLES = ['transcripts', 'device_files_cache', 'knowledge_captures', 'quality_assessments', 'recordings']

function wipeData(): void {
  runWithMassDeleteAllowed(() => {
    for (const table of DATA_TABLES) {
      try {
        run(`DELETE FROM ${table}`)
      } catch {
        /* ignore */
      }
    }
  })
}

function seedRecording(id: string, opts: { filename?: string; duration?: number | null; meeting_id?: string | null } = {}): void {
  run(
    `INSERT INTO recordings
       (id, filename, file_path, date_recorded, duration_seconds, meeting_id, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, ?, ?, ?, ?, 'none', 'local-only', 'none', 0, 1, 'hidock', 0, 0)`,
    [id, opts.filename ?? `${id}.wav`, `/tmp/${id}.wav`, '2026-01-01T10:00:00.000Z', opts.duration ?? null, opts.meeting_id ?? null]
  )
}

function seedDeviceCache(filename: string, duration: number): void {
  run(
    `INSERT INTO device_files_cache (id, filename, file_size, duration_seconds, date_recorded)
     VALUES (?, ?, ?, ?, ?)`,
    [`cache-${filename}`, filename, 1000, duration, '2026-01-01T10:00:00.000Z']
  )
}

function seedTranscript(recordingId: string, opts: { speakers?: string | null; wordCount?: number } = {}): void {
  run(
    `INSERT INTO transcripts (id, recording_id, full_text, speakers, word_count)
     VALUES (?, ?, ?, ?, ?)`,
    [`t-${recordingId}`, recordingId, 'text', opts.speakers ?? null, opts.wordCount ?? 0]
  )
}

function seedCapture(id: string, sourceRecordingId: string, meetingId: string | null = null): void {
  run(
    `INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, meeting_id)
     VALUES (?, ?, ?, ?, ?)`,
    [id, `Capture ${id}`, '2026-01-01T10:00:00.000Z', sourceRecordingId, meetingId]
  )
}

function durationOf(id: string): number | null {
  return queryOne<{ duration_seconds: number | null }>('SELECT duration_seconds FROM recordings WHERE id = ?', [id])?.duration_seconds ?? null
}

describe('maxTranscriptSegmentEnd', () => {
  it('returns 0 for null/empty/invalid input', () => {
    expect(maxTranscriptSegmentEnd(null)).toBe(0)
    expect(maxTranscriptSegmentEnd('')).toBe(0)
    expect(maxTranscriptSegmentEnd('not json')).toBe(0)
    expect(maxTranscriptSegmentEnd('{}')).toBe(0)
  })

  it('returns the largest segment end time', () => {
    const speakers = JSON.stringify([
      { speaker: 'A', start: 0, end: 12 },
      { speaker: 'B', start: 12, end: 40 },
      { speaker: 'A', start: 40, end: 40 } // final turn clamped to its start
    ])
    expect(maxTranscriptSegmentEnd(speakers)).toBe(40)
  })

  it('falls back to start when end is missing', () => {
    expect(maxTranscriptSegmentEnd(JSON.stringify([{ start: 33 }]))).toBe(33)
  })
})

describe('backfillRecordingDurations', () => {
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
    wipeData()
  })

  it('populates duration_seconds from the device-file cache (base-filename match)', () => {
    // Download stored the local .wav with NULL duration; the device cache knows
    // the .hda source's duration. Base-filename matching bridges the extension.
    seedRecording('rec-a', { filename: 'Rec59.wav', duration: null })
    seedDeviceCache('Rec59.hda', 132)

    const result = backfillRecordingDurations()

    expect(result.updated).toBe(1)
    expect(durationOf('rec-a')).toBe(132)
  })

  it('falls back to the transcript last-segment end when no cache exists', () => {
    seedRecording('rec-b', { duration: null })
    seedTranscript('rec-b', {
      speakers: JSON.stringify([
        { start: 0, end: 30 },
        { start: 30, end: 95 }
      ])
    })

    const result = backfillRecordingDurations()

    expect(result.updated).toBe(1)
    expect(durationOf('rec-b')).toBe(95)
  })

  it('is idempotent and never overwrites an existing duration', () => {
    seedRecording('rec-c', { filename: 'Keep.wav', duration: 500 })
    seedDeviceCache('Keep.hda', 132)

    const first = backfillRecordingDurations()
    expect(first.updated).toBe(0) // already has a duration
    expect(durationOf('rec-c')).toBe(500)

    // Row needing backfill; a second run only touches the still-NULL row.
    seedRecording('rec-d', { filename: 'New.wav', duration: null })
    seedDeviceCache('New.hda', 77)
    const second = backfillRecordingDurations()
    expect(second.updated).toBe(1)
    expect(durationOf('rec-d')).toBe(77)
  })

  it('enables duration sort/filter: after backfill the DB can order by duration', () => {
    seedRecording('short', { filename: 'Short.wav', duration: null })
    seedDeviceCache('Short.hda', 8)
    seedRecording('long', { filename: 'Long.wav', duration: null })
    seedDeviceCache('Long.hda', 600)

    // Before: both NULL — ordering/filtering by duration yields nothing usable.
    const before = queryAll<{ id: string }>(
      'SELECT id FROM recordings WHERE duration_seconds > 0 ORDER BY duration_seconds ASC'
    )
    expect(before.length).toBe(0)

    backfillRecordingDurations()

    // After: real values, so "< 1 min" filter and duration sort both work.
    const underOneMinute = queryAll<{ id: string }>(
      'SELECT id FROM recordings WHERE duration_seconds > 0 AND duration_seconds < 60'
    ).map((r) => r.id)
    expect(underOneMinute).toEqual(['short'])

    const sorted = queryAll<{ id: string }>(
      'SELECT id FROM recordings WHERE duration_seconds > 0 ORDER BY duration_seconds ASC'
    ).map((r) => r.id)
    expect(sorted).toEqual(['short', 'long'])
  })
})

describe('classifyLowValueCaptures', () => {
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
    wipeData()
  })

  it('marks a short, transcript-less, meeting-less capture as low-value', () => {
    seedRecording('junk', { duration: 6 })
    seedCapture('cap-junk', 'junk')

    const result = classifyLowValueCaptures()

    expect(result.markedLowValue).toBe(1)
    const q = queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap-junk'])
    expect(q?.quality_rating).toBe('low-value')
  })

  it('does NOT downgrade substantial or ambiguous captures', () => {
    // Long recording → keep unrated.
    seedRecording('long', { duration: 1800 })
    seedCapture('cap-long', 'long')
    // Short but with a real, speakable transcript (25 words in 8s ≈ 3.1 words
    // per second, the median rate in the owner's DB) → keep unrated.
    seedRecording('short-transcribed', { duration: 8 })
    seedTranscript('short-transcribed', { wordCount: 25 })
    seedCapture('cap-st', 'short-transcribed')
    // Short but linked to a meeting → keep unrated.
    run('INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)', ['m1', 'Sync', '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z'])
    seedRecording('short-meeting', { duration: 8, meeting_id: 'm1' })
    seedCapture('cap-sm', 'short-meeting', 'm1')

    classifyLowValueCaptures()

    for (const id of ['cap-long', 'cap-st', 'cap-sm']) {
      const q = queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', [id])
      expect(q?.quality_rating).toBe('unrated')
    }
  })

  it('treats a physically impossible transcript as no transcript at all', () => {
    // 120 words in 8 seconds is 15 words per second — roughly three times the
    // fastest human speech, i.e. a hallucinated transcript. It must not buy
    // the clip its way out of the "no meaningful transcript" test
    // (2026-09-22).
    seedRecording('hallucinated', { duration: 8 })
    seedTranscript('hallucinated', { wordCount: 120 })
    seedCapture('cap-hallucinated', 'hallucinated')

    expect(classifyLowValueCaptures().markedLowValue).toBe(1)
    const q = queryOne<{ quality_rating: string }>(
      'SELECT quality_rating FROM knowledge_captures WHERE id = ?',
      ['cap-hallucinated']
    )
    expect(q?.quality_rating).toBe('low-value')
  })

  it('leaves a rating the user cleared back to unrated alone', () => {
    // Clearing a rating is a decision, not an absence of one: quality_source
    // stays 'user' and this classifier must not re-mark the row (2026-09-22).
    seedRecording('cleared', { duration: 6 })
    seedCapture('cap-cleared', 'cleared')
    run(
      "UPDATE knowledge_captures SET quality_rating = 'unrated', quality_source = 'user' WHERE id = ?",
      ['cap-cleared']
    )

    expect(classifyLowValueCaptures().markedLowValue).toBe(0)
    const q = queryOne<{ quality_rating: string; quality_source: string | null }>(
      'SELECT quality_rating, quality_source FROM knowledge_captures WHERE id = ?',
      ['cap-cleared']
    )
    expect(q?.quality_rating).toBe('unrated')
    expect(q?.quality_source).toBe('user')
  })

  it('never overrides a user/AI-set rating and is idempotent', () => {
    seedRecording('junk', { duration: 6 })
    seedCapture('cap-junk', 'junk')
    run(`UPDATE knowledge_captures SET quality_rating = 'valuable' WHERE id = 'cap-junk'`)

    const result = classifyLowValueCaptures()
    expect(result.markedLowValue).toBe(0)
    const q = queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap-junk'])
    expect(q?.quality_rating).toBe('valuable')
  })
})


describe('backfillRecordingDurations — measured from the audio file', () => {
  /** Where the fixture audio lives for this block. */
  let audioDir: string

  /**
   * One MPEG-2 Layer III frame header at 64 kbps / 16 kHz, repeated: the
   * device's own format, and 288 bytes per frame at 8,000 bytes per second.
   */
  function writeAudio(name: string, frames: number): string {
    const FRAME = Buffer.from([0xff, 0xf3, 0x88, 0xc4])
    const BYTES = 288
    const data = Buffer.alloc(frames * BYTES)
    for (let i = 0; i < frames; i++) FRAME.copy(data, i * BYTES)
    const path = join(audioDir, name)
    writeFileSync(path, data)
    return path
  }

  function seedWithFile(id: string, filePath: string, duration: number | null): void {
    run(
      `INSERT INTO recordings
         (id, filename, file_path, date_recorded, duration_seconds, status, location,
          transcription_status, on_device, on_local, source, is_imported, personal)
       VALUES (?, ?, ?, ?, ?, 'none', 'local-only', 'none', 0, 1, 'hidock', 0, 0)`,
      [id, `${id}.wav`, filePath, '2026-01-01T10:00:00.000Z', duration]
    )
  }

  function sourceOf(id: string): string | null {
    return (
      queryOne<{ duration_source: string | null }>('SELECT duration_source FROM recordings WHERE id = ?', [id])
        ?.duration_source ?? null
    )
  }

  beforeAll(async () => {
    cleanupDbFiles(paths.db)
    await initializeDatabase()
    audioDir = mkdtempSync(join(tmpdir(), 'hidock-backfill-audio-'))
  })

  afterAll(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    cleanupDbFiles(paths.db)
    rmSync(audioDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    wipeData()
  })

  it('corrects a duration the transcript had understated', () => {
    // The shape the owner's library is full of: 250 frames = 9 s of audio
    // carrying a duration that came from a transcript which stopped at 3 s.
    seedWithFile('understated', writeAudio('understated.wav', 250), 3)

    const result = backfillRecordingDurations()

    expect(result.measured).toBe(1)
    expect(result.updated).toBe(1)
    expect(durationOf('understated')).toBe(9)
    expect(sourceOf('understated')).toBe('file')
  })

  it('measures a row that had no duration at all', () => {
    seedWithFile('empty', writeAudio('empty-duration.wav', 1000), null)

    backfillRecordingDurations()

    expect(durationOf('empty')).toBe(36)
    expect(sourceOf('empty')).toBe('file')
  })

  it('measures each file once and leaves it alone afterwards', () => {
    seedWithFile('once', writeAudio('once.wav', 250), null)

    expect(backfillRecordingDurations().measured).toBe(1)
    // Second pass does not reopen the file: the row is no longer even scanned.
    const second = backfillRecordingDurations()
    expect(second.scanned).toBe(0)
    expect(second.measured).toBe(0)
    expect(durationOf('once')).toBe(9)
  })

  it('keeps the longer estimate when the transcript outruns the file on disk', () => {
    // A truncated download: 9 s of audio left, 600 s of it transcribed. Writing
    // the 9 would record the loss as if it were the recording's real length.
    seedWithFile('truncated', writeAudio('truncated.wav', 250), 600)
    seedTranscript('truncated', { speakers: JSON.stringify([{ start: 0, end: 600 }]) })

    const result = backfillRecordingDurations()

    expect(result.truncated).toBe(1)
    expect(result.measured).toBe(0)
    expect(durationOf('truncated')).toBe(600)
    expect(sourceOf('truncated')).toBeNull()
  })

  it('accepts a transcript that overshoots the audio by a fraction of a second', () => {
    // Transcribers round their last segment up; that is not a truncated file.
    seedWithFile('overshoot', writeAudio('overshoot.wav', 250), 9)
    seedTranscript('overshoot', { speakers: JSON.stringify([{ start: 0, end: 9.6 }]) })

    const result = backfillRecordingDurations()

    expect(result.truncated).toBe(0)
    expect(sourceOf('overshoot')).toBe('file')
  })


  it('reopens a rating the old, too-short length had settled', () => {
    // The shape that makes this necessary: 9 s on record, rated garbage by the
    // stopwatch, and 36 s of audio actually on disk. The gate never revisits a
    // capture it already rated, so the correction has to hand it back.
    seedWithFile('rerate', writeAudio('rerate.wav', 1000), 9)
    seedCapture('cap-rerate', 'rerate')
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'ai' WHERE id = ?", [
      'cap-rerate',
    ])

    const result = backfillRecordingDurations()

    expect(result.rerateable).toBe(1)
    expect(durationOf('rerate')).toBe(36)
    const q = queryOne<{ quality_rating: string; quality_source: string | null }>(
      'SELECT quality_rating, quality_source FROM knowledge_captures WHERE id = ?',
      ['cap-rerate']
    )
    expect(q?.quality_rating).toBe('unrated')
    expect(q?.quality_source).toBeNull()
  })

  it('leaves a rating a person set alone, however wrong the old length was', () => {
    seedWithFile('mine', writeAudio('mine.wav', 1000), 9)
    seedCapture('cap-mine', 'mine')
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'user' WHERE id = ?", [
      'cap-mine',
    ])

    const result = backfillRecordingDurations()

    expect(result.rerateable).toBe(0)
    expect(
      queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', [
        'cap-mine',
      ])?.quality_rating
    ).toBe('garbage')
  })

  it('leaves a rating alone when the correction stays under the gate', () => {
    // 9 s on record, 9 s of audio: nothing about the verdict has changed.
    seedWithFile('still-short', writeAudio('still-short.wav', 250), 3)
    seedCapture('cap-short', 'still-short')
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'ai' WHERE id = ?", [
      'cap-short',
    ])

    const result = backfillRecordingDurations()

    expect(result.rerateable).toBe(0)
    expect(
      queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', [
        'cap-short',
      ])?.quality_rating
    ).toBe('garbage')
  })

  it('falls back to the old estimates when the file cannot be read', () => {
    const path = join(audioDir, 'not-audio.flac')
    writeFileSync(path, Buffer.from('this is not a stream this reads'))
    seedWithFile('unreadable', path, null)
    seedTranscript('unreadable', { speakers: JSON.stringify([{ start: 0, end: 42 }]) })

    const result = backfillRecordingDurations()

    expect(result.measured).toBe(0)
    expect(durationOf('unreadable')).toBe(42)
    expect(sourceOf('unreadable')).toBeNull()
  })
})
