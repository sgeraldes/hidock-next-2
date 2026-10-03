// @vitest-environment node

/**
 * Transcript trust against a real SQLite database: a transcript stored over
 * noise is checked against the audio profile and comes out broken, an
 * untrusted transcript rates its recording "no value" with method 'trust', a
 * model rating cannot undo that, and accepting the transcript (or the audio
 * turning out to hold speech) takes it back. The owner's rating and personal
 * recordings are never touched.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-transcript-trust-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => tmpdir(),
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  insertTranscript,
  refreshTranscriptIntegrityForRecording,
  setTranscriptIntegrityAccepted,
} from '../database'
import { isTranscriptUntrusted, syncTrustVerdicts, TRUST_REASON } from '../transcript-trust'
import { applyCaptureValueClassification } from '../value-classification'

function seedRecording(id: string, personal = false): void {
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, NULL, 789, 'file', '2026-04-21T11:57:18.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, ?)`,
    [id, `${id}.hda`, personal ? 1 : 0]
  )
}

function seedProfile(id: string, category: string, soundSeconds: number): void {
  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
        sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, 1, 'mp3-frame-gain', 1, 1, 789, ?, ?, 0.6, 138, 26, ?, '[]', '2026-09-25T23:29:04.713Z')
     ON CONFLICT(recording_id) DO UPDATE SET category = excluded.category, sound_seconds = excluded.sound_seconds`,
    [id, soundSeconds, soundSeconds / 789, category]
  )
}

function seedCapture(id: string, recordingId: string, rating: string, source: 'ai' | 'user' | null): void {
  run(
    `INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, quality_source, captured_at)
     VALUES (?, ?, ?, ?, ?, '2026-04-21T11:57:18.000Z')`,
    [id, `Capture ${id}`, recordingId, rating, source]
  )
}

/** A 2,500-word story in 100 lines over 13 minutes, like Rec02's. */
function story(recordingId: string): void {
  const segments = Array.from({ length: 100 }, (_, i) => ({
    speaker: i % 2 ? 'SPEAKER_01' : 'SPEAKER_00',
    start: i * 7.8,
    text: `${Array.from({ length: 24 }, (_, w) => `palabra${w}`).join(' ')} linea${i}`,
  }))
  insertTranscript({
    id: `trans_${recordingId}`,
    recording_id: recordingId,
    full_text: segments.map((s) => s.text).join(' '),
    language: 'es',
    summary: 'Laura confiesa.',
    speakers: JSON.stringify(segments),
    word_count: 2500,
  })
}

const rating = (captureId: string) =>
  queryOne<{ quality_rating: string; quality_method: string | null; quality_reasons: string | null; quality_source: string | null }>(
    'SELECT quality_rating, quality_method, quality_reasons, quality_source FROM knowledge_captures WHERE id = ?',
    [captureId]
  )

beforeAll(async () => {
  await initializeDatabase()
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
})

describe('transcript trust', () => {
  it('breaks a transcript stored over a noise-only file, and keeps the summary it came with', () => {
    seedRecording('rec02')
    seedProfile('rec02', 'noise', 3.74)
    story('rec02')
    const t = queryOne<{ integrity_status: string; integrity_json: string; summary: string }>(
      'SELECT integrity_status, integrity_json, summary FROM transcripts WHERE recording_id = ?',
      ['rec02']
    )
    expect(t?.integrity_status).toBe('broken')
    expect(JSON.parse(t!.integrity_json).issues.map((i: { code: string }) => i.code)).toContain('text_over_noise')
    expect(t?.summary).toBe('Laura confiesa.') // nothing stored is deleted
    expect(isTranscriptUntrusted('rec02')).toBe(true)
  })

  it('rates an untrusted transcript "no value" with method trust, and a model cannot undo it', () => {
    seedCapture('c-rec02', 'rec02', 'unrated', null)
    expect(syncTrustVerdicts()).toMatchObject({ rated: 1 })
    expect(rating('c-rec02')).toMatchObject({ quality_rating: 'garbage', quality_method: 'trust', quality_source: 'ai' })
    expect(JSON.parse(rating('c-rec02')!.quality_reasons!)).toEqual([TRUST_REASON])
    expect(applyCaptureValueClassification('c-rec02', { value: 'high', reasons: [], confidence: 0.99 }, 'content').applied).toBe(false)
    expect(rating('c-rec02')?.quality_rating).toBe('garbage')
    // Idempotent: a second pass changes nothing.
    expect(syncTrustVerdicts()).toEqual({ rated: 0, cleared: 0 })
  })

  it('takes the rating back when the owner accepts the transcript', () => {
    expect(setTranscriptIntegrityAccepted('rec02', true)).toBe(true)
    expect(isTranscriptUntrusted('rec02')).toBe(false)
    expect(syncTrustVerdicts('rec02')).toEqual({ rated: 0, cleared: 1 })
    expect(rating('c-rec02')).toMatchObject({ quality_rating: 'unrated', quality_method: null })
    setTranscriptIntegrityAccepted('rec02', false)
    expect(syncTrustVerdicts('rec02')).toEqual({ rated: 1, cleared: 0 })
  })

  it('trusts the transcript again when the audio turns out to hold speech', () => {
    seedProfile('rec02', 'speech', 600)
    expect(refreshTranscriptIntegrityForRecording('rec02')?.status).not.toBe('broken')
    expect(syncTrustVerdicts('rec02')).toEqual({ rated: 0, cleared: 1 })
    expect(rating('c-rec02')?.quality_rating).toBe('unrated')
  })

  it('never touches the owner rating, a personal recording, or an audio verdict', () => {
    seedRecording('owned')
    seedProfile('owned', 'noise', 2)
    story('owned')
    seedCapture('c-owned', 'owned', 'valuable', 'user')
    seedRecording('private', true)
    seedProfile('private', 'noise', 2)
    story('private')
    seedCapture('c-private', 'private', 'unrated', null)
    seedRecording('crackle')
    seedProfile('crackle', 'noise', 2)
    story('crackle')
    seedCapture('c-crackle', 'crackle', 'unrated', null)
    expect(applyCaptureValueClassification('c-crackle', { value: 'none', reasons: ['noise_only'], confidence: 1 }, 'audio').applied).toBe(true)

    syncTrustVerdicts()
    expect(rating('c-owned')).toMatchObject({ quality_rating: 'valuable', quality_source: 'user' })
    expect(rating('c-private')?.quality_rating).toBe('unrated')
    expect(rating('c-crackle')).toMatchObject({ quality_rating: 'garbage', quality_method: 'audio' })
  })
})
