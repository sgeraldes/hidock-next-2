// @vitest-environment node

/**
 * Transcript trust against a real SQLite database. A transcript stored over
 * noise is checked against the audio profile and comes out broken. Over
 * speech, a transcript that is not valid leaves its recording uncategorized
 * (owner, 4-oct-2026): the old 'trust' "no value" ratings and the ratings read
 * from its content are taken back, the stored stars, kind and context go, and
 * accepting the transcript gives them back. The owner's rating and the audio's
 * own verdicts are never touched.
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
const emitDomainEvent = vi.hoisted(() => vi.fn())
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent }) }))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  insertTranscript,
  setTranscriptIntegrityAccepted,
  backfillTranscriptIntegrity,
  saveRecordingEvaluation,
} from '../database'
import { isTranscriptUntrusted, syncTrustVerdicts } from '../transcript-trust'
import { applyCaptureValueClassification, recomputeEvaluationsFromEvidence } from '../value-classification'

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

  it('never rates a transcript "no value" for being broken', () => {
    seedCapture('c-rec02', 'rec02', 'unrated', null)
    expect(syncTrustVerdicts('rec02')).toEqual({ cleared: 0, withdrawn: 0 })
    expect(rating('c-rec02')?.quality_rating).toBe('unrated')
  })
})

describe('a transcript that is not valid, over speech', () => {
  const validity = (id: string) =>
    queryOne<{ validity_status: string | null }>('SELECT validity_status FROM transcripts WHERE recording_id = ?', [id])
      ?.validity_status
  const evaluation = (captureId: string) =>
    queryOne<{ star_level: number | null; kind: string | null; context: string | null; answers_json: string }>(
      'SELECT star_level, kind, context, answers_json FROM recording_evaluations WHERE capture_id = ?',
      [captureId]
    )

  it('is invalid: 2,500 words over 30 seconds of sound', () => {
    seedRecording('inv')
    seedProfile('inv', 'speech', 30)
    story('inv')
    syncTrustVerdicts('inv')
    expect(validity('inv')).toBe('invalid')
    expect(isTranscriptUntrusted('inv')).toBe(true)
  })

  it('takes back the old trust rating and the rating read from its content', () => {
    seedCapture('c-inv', 'inv', 'garbage', 'ai')
    run(`UPDATE knowledge_captures SET quality_method = 'trust', quality_reasons = '["transcript_untrusted"]' WHERE id = 'c-inv'`)
    seedRecording('inv2')
    seedProfile('inv2', 'speech', 30)
    story('inv2')
    seedCapture('c-inv2', 'inv2', 'garbage', 'ai')
    run(`UPDATE knowledge_captures SET quality_method = 'content' WHERE id = 'c-inv2'`)

    expect(syncTrustVerdicts('inv')).toEqual({ cleared: 0, withdrawn: 1 })
    expect(syncTrustVerdicts('inv2')).toEqual({ cleared: 1, withdrawn: 0 })
    expect(rating('c-inv')).toMatchObject({ quality_rating: 'unrated', quality_method: null, quality_source: null })
    expect(rating('c-inv2')).toMatchObject({ quality_rating: 'unrated', quality_method: 'held', quality_source: null })
    expect(syncTrustVerdicts()).toEqual({ cleared: 0, withdrawn: 0 })
  })

  it('loses its stars, kind and context, keeps Jev answers, and gets them back when accepted', async () => {
    const answers = {
      stars: { type: 'score', score: 3.2, confidence: 0.8, legend: {}, probabilities: { '3': 0.8, '4': 0.2 } },
      kind: { type: 'choice', choice: 'team_meeting', probabilities: {}, confidence: 0.9 },
      context: { type: 'choice', choice: 'work', probabilities: {}, confidence: 0.9 },
    }
    saveRecordingEvaluation({
      capture_id: 'c-inv', recording_id: 'inv', version: 1, model: 'jev-1.13.0', stars: 4.2, star_level: 4,
      stars_confidence: 0.8, kind: 'team_meeting', kind_confidence: 0.9, context: 'work', context_confidence: 0.9,
      transcript_invented: null, transcript_overfull: null, has_action_items: null, sensitive: null,
      reasons_json: '[]', answers_json: JSON.stringify(answers), input_tokens: 1200, audio_warning: null,
    })
    await recomputeEvaluationsFromEvidence(['inv'])
    expect(evaluation('c-inv')).toMatchObject({ star_level: null, kind: null, context: null })
    expect(JSON.parse(evaluation('c-inv')!.answers_json)).toEqual(answers)

    expect(setTranscriptIntegrityAccepted('inv', true)).toBe(true)
    syncTrustVerdicts('inv')
    expect(validity('inv')).toBe('valid')
    expect(isTranscriptUntrusted('inv')).toBe(false)
    await recomputeEvaluationsFromEvidence(['inv'])
    expect(evaluation('c-inv')).toMatchObject({ star_level: 4, kind: 'team_meeting', context: 'work' })
  })

  // Kiro review of #149: a rating taken back must come back when the
  // transcript turns valid, not stay unrated until some later scan.
  it('gives the held content rating back from the stored evaluation once the transcript is valid', async () => {
    saveRecordingEvaluation({
      capture_id: 'c-inv2', recording_id: 'inv2', version: 1, model: 'jev-1.13.0', stars: 1.1, star_level: 1,
      stars_confidence: 0.9, kind: 'device_test', kind_confidence: 0.9, context: 'unclear', context_confidence: 0.9,
      transcript_invented: null, transcript_overfull: null, has_action_items: null, sensitive: null,
      reasons_json: '["no_substance"]',
      answers_json: JSON.stringify({ stars: { type: 'score', score: 0.1, confidence: 0.9, legend: {}, probabilities: { '0': 0.9, '1': 0.1 } } }),
      input_tokens: 1200, audio_warning: null,
    })
    await recomputeEvaluationsFromEvidence(['inv2'])
    expect(rating('c-inv2')).toMatchObject({ quality_rating: 'unrated', quality_method: 'held' })

    setTranscriptIntegrityAccepted('inv2', true)
    syncTrustVerdicts('inv2')
    await recomputeEvaluationsFromEvidence(['inv2'])
    expect(rating('c-inv2')).toMatchObject({ quality_rating: 'garbage', quality_method: 'content', quality_source: 'ai' })
  })

  it('leaves a personal recording rating as it is', () => {
    seedRecording('priv', true)
    seedProfile('priv', 'speech', 30)
    story('priv')
    seedCapture('c-priv', 'priv', 'low-value', 'ai')
    run(`UPDATE knowledge_captures SET quality_method = 'content' WHERE id = 'c-priv'`)
    expect(syncTrustVerdicts('priv')).toEqual({ cleared: 0, withdrawn: 0 })
    expect(rating('c-priv')).toMatchObject({ quality_rating: 'low-value', quality_method: 'content' })
  })

  it('never touches the owner rating or an audio verdict', () => {
    seedRecording('owned')
    seedProfile('owned', 'speech', 30)
    story('owned')
    seedCapture('c-owned', 'owned', 'valuable', 'user')
    seedRecording('crackle')
    seedProfile('crackle', 'noise', 2)
    story('crackle')
    seedCapture('c-crackle', 'crackle', 'unrated', null)
    expect(applyCaptureValueClassification('c-crackle', { value: 'none', reasons: ['noise_only'], confidence: 1 }, 'audio').applied).toBe(true)

    syncTrustVerdicts('owned')
    syncTrustVerdicts('crackle')
    expect(rating('c-owned')).toMatchObject({ quality_rating: 'valuable', quality_source: 'user' })
    expect(rating('c-crackle')).toMatchObject({ quality_rating: 'garbage', quality_method: 'audio' })
    expect(validity('crackle')).toBe('audio')
  })
})

describe('the library backfill and an old acceptance', () => {
  it('clears an acceptance of a timing warning when the new rules find the text invented', async () => {
    // Kiro review of #136: the owner accepted Rec02's "one cramped line" under
    // the v2 rules; v3 finds text over noise. The acceptance covered the old
    // problems only, so it must not keep the transcript trusted.
    seedRecording('accepted-v2')
    seedProfile('accepted-v2', 'noise', 3.74)
    story('accepted-v2')
    run(
      `UPDATE transcripts SET integrity_status = 'suspect', integrity_version = 2,
         integrity_json = '{"status":"suspect","issues":[{"code":"cramped_lines","count":1,"detail":""}]}',
         integrity_accepted_at = '2026-09-30T10:00:00.000Z' WHERE recording_id = 'accepted-v2'`
    )
    await backfillTranscriptIntegrity()
    const row = queryOne<{ integrity_status: string; integrity_accepted_at: string | null }>(
      'SELECT integrity_status, integrity_accepted_at FROM transcripts WHERE recording_id = ?',
      ['accepted-v2']
    )
    expect(row).toEqual({ integrity_status: 'broken', integrity_accepted_at: null })
    expect(isTranscriptUntrusted('accepted-v2')).toBe(true)
  })

  it('keeps an acceptance when the new rules find the same problems', async () => {
    seedRecording('accepted-same')
    seedProfile('accepted-same', 'speech', 600)
    insertTranscript({
      id: 'trans_accepted-same', recording_id: 'accepted-same', full_text: 'a b', language: 'es',
      speakers: JSON.stringify([{ speaker: 'A', start: 1, text: 'hola' }, { speaker: 'B', start: 1, text: 'chau' }]), word_count: 2,
    })
    const stored = queryOne<{ integrity_json: string }>('SELECT integrity_json FROM transcripts WHERE recording_id = ?', ['accepted-same'])
    run(
      `UPDATE transcripts SET integrity_version = 2, integrity_accepted_at = '2026-09-30T10:00:00.000Z' WHERE recording_id = 'accepted-same'`
    )
    expect(JSON.parse(stored!.integrity_json).status).toBe('suspect')
    await backfillTranscriptIntegrity()
    const row = queryOne<{ integrity_accepted_at: string | null }>(
      'SELECT integrity_accepted_at FROM transcripts WHERE recording_id = ?',
      ['accepted-same']
    )
    expect(row?.integrity_accepted_at).toBe('2026-09-30T10:00:00.000Z')
  })
})

it('announces one recording after syncing its verdict and never an empty scope', async () => {
  seedRecording('event-recording')
  story('event-recording')
  emitDomainEvent.mockClear()
  syncTrustVerdicts('event-recording')
  const events = emitDomainEvent.mock.calls.filter(([event]) => event.type === 'transcript:verdicts-updated')
  expect(events).toHaveLength(1)
  expect(events[0][0].payload).toEqual({ recordingIds: ['event-recording'] })
  emitDomainEvent.mockClear()
  syncTrustVerdicts()
  expect(emitDomainEvent.mock.calls.filter(([event]) => event.type === 'transcript:verdicts-updated')).toHaveLength(0)
  await new Promise<void>((resolve) => setImmediate(resolve))
})
