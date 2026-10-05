// @vitest-environment node

/**
 * The stored validity verdict against a real SQLite database and a real
 * envelope file: text over frames with no audio is invalid, the library pass
 * checks each transcript once, and a meeting linked later (a new invite count)
 * has it checked again.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-validity-store-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-validity-cache-${process.pid}-${Date.now()}`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
const emitDomainEvent = vi.hoisted(() => vi.fn())
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent }) }))

import { initializeDatabase, closeDatabase, run, queryOne, insertTranscript } from '../database'
import {
  backfillTranscriptValidity,
  refreshTranscriptValidity,
  previewTranscriptValidity,
  transcriptFingerprint,
} from '../transcript-validity-store'
import { FRAME_SECONDS } from '../audio-profile'

const FILE_SECONDS = 600

function seed(id: string, gains: Array<[number, number]>): void {
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, NULL, ?, 'file', '2026-04-21T11:57:18.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, 0)`,
    [id, `2026Apr21-115718-${id}.hda`, FILE_SECONDS]
  )
  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
        sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, 1, 'mp3-frame-gain', 1, 1, ?, 600, 1, 600, 160, 0, 'speech', '[]', '2026-09-25T23:29:04.713Z')`,
    [id, FILE_SECONDS]
  )
  const frames: number[] = []
  for (const [gain, seconds] of gains) for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) frames.push(gain)
  mkdirSync(join(paths.cache, 'audio-envelope'), { recursive: true })
  writeFileSync(join(paths.cache, 'audio-envelope', `${id}.u8`), Uint8Array.from(frames))
  const segments = Array.from({ length: 50 }, (_, i) => ({
    speaker: i % 2 ? 'A' : 'B',
    start: i * 11,
    end: i * 11 + 10,
    text: Array.from({ length: 20 }, (_, w) => `w${w}-${i}`).join(' '),
  }))
  insertTranscript({
    id: `trans_${id}`,
    recording_id: id,
    full_text: segments.map((s) => s.text).join(' '),
    language: 'es',
    speakers: JSON.stringify(segments),
    word_count: 1000,
  })
}

const stored = (id: string) =>
  queryOne<{ validity_status: string | null; validity_json: string | null; validity_version: number | null }>(
    'SELECT validity_status, validity_json, validity_version FROM transcripts WHERE recording_id = ?',
    [id]
  )

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

describe('transcript validity store', () => {
  it('reads the envelope: text over frames with no audio is invalid, text over speech valid', async () => {
    seed('quiet', [[138, 590], [160, 10]])
    seed('talk', [[160, 600]])
    const counts = await backfillTranscriptValidity()
    expect(counts).toMatchObject({ checked: 2, invalid: 1, valid: 1 })
    expect(counts.changedIds).toEqual(['quiet', 'talk'])
    expect(emitDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript:verdicts-updated', payload: { recordingIds: ['quiet', 'talk'] } }))
    expect(stored('quiet')?.validity_status).toBe('invalid')
    expect(JSON.parse(stored('quiet')!.validity_json!).reasons.map((r: { code: string }) => r.code)).toContain('text_without_audio')
    expect(stored('talk')?.validity_status).toBe('valid')
  })

  it('checks each transcript once', async () => {
    expect(await backfillTranscriptValidity()).toEqual({ checked: 0, changedIds: [] })
  })

  it('checks again when a meeting is linked later and the speakers outnumber its invitees', async () => {
    run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees) VALUES ('m1', 'Sync', '2026-04-21T11:00:00Z', '2026-04-21T12:00:00Z', ?)`, [
      JSON.stringify([{ email: 'a@x.com' }]),
    ])
    run(`UPDATE recordings SET meeting_id = 'm1' WHERE id = 'talk'`)
    // Two speakers against one invitee is still within "invitees plus one".
    expect(await backfillTranscriptValidity()).toMatchObject({ checked: 1, valid: 1, changedIds: [] })
    expect(JSON.parse(stored('talk')!.validity_json!).measures.attendees).toBe(1)
    expect(await backfillTranscriptValidity()).toEqual({ checked: 0, changedIds: [] })
  })

  it('refreshes one recording, and previews lines not stored yet', () => {
    expect(refreshTranscriptValidity('talk')?.status).toBe('valid')
    expect(refreshTranscriptValidity('no-such-recording')).toBeNull()
    const lines = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ speaker: 'A', start: i * 11, end: i * 11 + 10, text: 'x '.repeat(20) })))
    expect(previewTranscriptValidity('quiet', lines)?.status).toBe('invalid')
    expect(previewTranscriptValidity('quiet', lines, { integrityStatus: 'broken' })?.reasons[0].code).toBe('integrity')
  })
})

describe('a sample of the audio', () => {
  it('uses independent VAD evidence for a sparse stored transcript and a fresh preview', () => {
    seed('rec98', [[160, 600]])
    const lines = JSON.stringify([{ start: 0.9, end: 1010.8, text: 'one two three four five six seven eight nine' },
      { start: 1200, end: 1205, text: 'one two three four five six seven eight' }])
    run('UPDATE transcripts SET speakers = ?, word_count = 17 WHERE recording_id = ?', [lines, 'rec98'])
    run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at, quality_json)
      VALUES ('vad-rec98', 'rec98', 'vad', 'hidock-next', 'vad', 'local', 'completed', '2026-10-04', ?)`,
      [JSON.stringify({ nonSilentSeconds: 598, durationSeconds: 1565 })])
    expect(refreshTranscriptValidity('rec98')?.status).toBe('incomplete')
    expect(previewTranscriptValidity('rec98', lines, { vadSpeechSeconds: 598,
      diarizedSegments: [{ start: 0, end: 1057 }] })?.measures.detectedSpeechSeconds).toBe(1057)
    expect(stored('rec98')?.validity_status).toBe('incomplete')
  })
  it('settles a doubtful transcript only while it is the transcript that was sampled', () => {
    seed('doubt', [[160, 600]])
    const lines = Array.from({ length: 20 }, (_, i) => ({ speaker: 'A', start: Math.floor(i / 2) * 60, end: Math.floor(i / 2) * 60 + 50, text: `w ${i} `.repeat(10) }))
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [JSON.stringify(lines), 'doubt'])
    expect(refreshTranscriptValidity('doubt')?.status).toBe('doubtful')

    const speakers = queryOne<{ speakers: string }>('SELECT speakers FROM transcripts WHERE recording_id = ?', ['doubt'])!.speakers
    run(
      `INSERT INTO transcript_samples (recording_id, transcript_fingerprint, verdict, windows_json, model, cost_usd, sampled_at)
       VALUES ('doubt', ?, 'confirmed', '[]', 'gemini-3.5-transcribe', 0.0102, '2026-10-04T12:00:00Z')`,
      [transcriptFingerprint(speakers)]
    )
    expect(refreshTranscriptValidity('doubt')?.status).toBe('valid')

    // A new transcript is not the one sampled: the doubt comes back.
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [JSON.stringify(lines.slice(1)), 'doubt'])
    expect(refreshTranscriptValidity('doubt')?.status).toBe('doubtful')
  })
})
