// @vitest-environment node

/**
 * Stars, kind and context follow the recording's own measurements, against a
 * real SQLite database: a stored Jev evaluation of a noise-only recording is
 * brought down to one star without a Jev call, gets its Jev verdict back when
 * the audio turns out to hold speech, and a low-confidence answer never shows
 * four or five stars. A capped recording is evaluated by the rules, not Jev.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-evaluation-evidence-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => tmpdir(),
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))
// A Jev key, so the classifier would call Jev; the harness is a spy that must stay unused for capped recordings.
const jevAsk = vi.hoisted(() => vi.fn())
vi.mock('../jev-settings', () => ({ jevKeyFor: () => 'test-jev-key' }))
vi.mock('../pipeline/jev-harness', () => ({ createJevHarness: () => ({ ask: jevAsk }) }))

import { initializeDatabase, closeDatabase, run, queryOne, saveRecordingEvaluation } from '../database'
import { classifyCaptureValueRaw, recomputeEvaluationsFromEvidence } from '../value-classification'

const REC02_ANSWERS = {
  stars: { type: 'score', score: 2.51, confidence: 0, legend: {}, probabilities: { '0': 0.2, '1': 0.16, '2': 0.05, '3': 0.09, '4': 0.5 } },
  kind: { type: 'choice', choice: 'media_playback', confidence: 0.47, probabilities: {} },
  context: { type: 'choice', choice: 'personal', confidence: 0.95, probabilities: {} },
}

function seed(id: string, category: string | null, integrity: 'ok' | 'broken' = 'ok'): void {
  run(
    `INSERT INTO recordings (id, filename, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported)
     VALUES (?, ?, 789, 'file', '2026-04-21T11:57:18.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0)`,
    [id, `${id}.hda`]
  )
  if (category) {
    run(
      `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
          sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
       VALUES (?, 1, 'mp3-frame-gain', 1, 1, 789, 3.74, 0.0047, 0.61, 138, 26, ?, '[]', '2026-09-25T23:29:04.713Z')`,
      [id, category]
    )
  }
  run(
    `INSERT INTO transcripts (id, recording_id, full_text, language, word_count, integrity_status, integrity_version)
     VALUES (?, ?, 'Me engañó con mi mejor amiga y por eso le clavé un cuchillo.', 'es', 2554, ?, 3)`,
    [`trans_${id}`, id, integrity]
  )
  run(
    `INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, captured_at)
     VALUES (?, ?, ?, 'unrated', '2026-04-21T11:57:18.000Z')`,
    [`c-${id}`, `Capture ${id}`, id]
  )
}

function storeJev(id: string, answers: object, starLevel: number, kind: string): void {
  saveRecordingEvaluation({
    capture_id: `c-${id}`, recording_id: id, version: 1, model: 'jev-1.13.0', stars: 3.51, star_level: starLevel,
    stars_confidence: 0, kind, kind_confidence: 0.47, context: 'personal', context_confidence: 0.95,
    transcript_invented: 0.84, transcript_overfull: 0.96, has_action_items: 0.95, sensitive: 0.96,
    reasons_json: '[]', answers_json: JSON.stringify(answers), input_tokens: 1200, audio_warning: null,
  })
}

const evaluation = (id: string) =>
  queryOne<{ star_level: number; stars: number; kind: string; context: string; version: number; model: string }>(
    'SELECT star_level, stars, kind, context, version, model FROM recording_evaluations WHERE capture_id = ?',
    [`c-${id}`]
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

describe('stored evaluations follow the evidence', () => {
  it('brings Rec02 (noise only, stored as 5 stars, media playing) to one star, noise or accidental', async () => {
    seed('rec02', 'noise')
    storeJev('rec02', REC02_ANSWERS, 5, 'media_playback')
    expect(await recomputeEvaluationsFromEvidence()).toBeGreaterThanOrEqual(1)
    expect(evaluation('rec02')).toMatchObject({ star_level: 1, stars: 1, kind: 'noise_accidental', context: 'unclear' })
    expect(jevAsk).not.toHaveBeenCalled()
    // Idempotent.
    expect(await recomputeEvaluationsFromEvidence(['rec02'])).toBe(0)
  })

  it("gives Jev's own verdict back, capped by its confidence, when the audio holds speech", async () => {
    run("UPDATE audio_profiles SET category = 'speech' WHERE recording_id = 'rec02'")
    await recomputeEvaluationsFromEvidence(['rec02'])
    expect(evaluation('rec02')).toMatchObject({ star_level: 3, kind: 'media_playback', context: 'personal' })
  })

  it('caps an untrusted transcript over speech audio too', async () => {
    seed('rec41', 'speech', 'broken')
    storeJev('rec41', REC02_ANSWERS, 5, 'team_meeting')
    await recomputeEvaluationsFromEvidence(['rec41'])
    expect(evaluation('rec41')).toMatchObject({ star_level: 1, kind: 'noise_accidental' })
  })

  it('evaluates a capped recording with the rules, without asking Jev', async () => {
    seed('rec03', 'noise')
    const raw = await classifyCaptureValueRaw('c-rec03')
    expect(jevAsk).not.toHaveBeenCalled()
    expect(raw.providerCalled).toBe(false)
    expect(raw.evaluation).toMatchObject({ model: 'rules-v1', starLevel: 1, kind: 'noise_accidental' })
    expect(raw.classification).toMatchObject({ value: 'none', reasons: ['noise_only'] })
    expect(raw.method).toBe('audio')
  })

  it('marks a rules evaluation outdated when its cap no longer holds, so Jev is asked next time', async () => {
    seed('rec04', 'noise')
    saveRecordingEvaluation({
      capture_id: 'c-rec04', recording_id: 'rec04', version: 1, model: 'rules-v1', stars: 1, star_level: 1,
      stars_confidence: 1, kind: 'noise_accidental', kind_confidence: 1, context: 'unclear', context_confidence: 1,
      transcript_invented: 1, transcript_overfull: null, has_action_items: 0, sensitive: null,
      reasons_json: '[]', answers_json: '{}', input_tokens: 0, audio_warning: null,
    })
    run("UPDATE audio_profiles SET category = 'speech' WHERE recording_id = 'rec04'")
    await recomputeEvaluationsFromEvidence(['rec04'])
    expect(evaluation('rec04')?.version).toBe(0)
  })
})
