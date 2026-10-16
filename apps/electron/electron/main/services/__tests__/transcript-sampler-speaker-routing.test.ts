// @vitest-environment node

/**
 * A speaker-label doubt (more_speakers_than_invited) must not buy ASR: the
 * sampler compares words, and words say nothing about who spoke. Mixed doubts
 * keep their sampling, and a confirmed sample never clears the speaker doubt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-sampler-speakers-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-sampler-speakers-cache-${process.pid}-${Date.now()}`)

const config = vi.hoisted(() => ({
  value: {
    transcription: { valueClassificationMinConfidence: 0.6, jevApiKey: 'jev-test', geminiApiKey: 'gem-test' }, // pragma: allowlist secret
    decisions: {},
    quality: { samplesPerDay: 1 }
  } as Record<string, any>
}))

vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.cache }))
vi.mock('../config', () => ({ getConfig: () => config.value }))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))
vi.mock('../brains', () => ({ resolveGeminiApiKey: () => config.value.transcription.geminiApiKey, getBrainRouter: () => ({ canServe: () => false }) }))

import { initializeDatabase, closeDatabase, run, queryOne, insertTranscript } from '../database'
import { refreshTranscriptValidity } from '../transcript-validity-store'
import { runSamplingPass, sampleRecording, type SamplerDeps } from '../transcript-sampler'
import { applyQualityRules } from '../quality-rules'
import { FRAME_SECONDS } from '../audio-profile'

/** Four voices, one invitee: the speaker doubt. `pairedStarts` adds consistently wrong times on top. */
function seed(id: string, date: string, pairedStarts: boolean): void {
  const file = join(paths.cache, `${id}.hda`)
  writeFileSync(file, Buffer.alloc(16))
  run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees) VALUES (?, 'Interview', ?, ?, ?)`,
    [`m-${id}`, date, date, JSON.stringify([{ email: 'a@example.com' }])])
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal, meeting_id)
     VALUES (?, ?, ?, 600, 'file', ?, 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, 0, ?)`,
    [id, `${id}.hda`, file, date, `m-${id}`]
  )
  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
        sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, 1, 'mp3-frame-gain', 1, 1, 600, 600, 1, 600, 160, 0, 'speech', '[]', '2026-09-25T23:29:04.713Z')`,
    [id]
  )
  mkdirSync(join(paths.cache, 'audio-envelope'), { recursive: true })
  writeFileSync(join(paths.cache, 'audio-envelope', `${id}.u8`), new Uint8Array(Math.round(600 / FRAME_SECONDS)).fill(160))
  const segments = Array.from({ length: 20 }, (_, i) => {
    const start = pairedStarts ? Math.floor(i / 2) * 60 : i * 30
    return { speaker: `Voice ${i % 4}`, start, end: start + 25, text: Array.from({ length: 10 }, (_, w) => `w${w}-${i}`).join(' ') }
  })
  insertTranscript({ id: `trans_${id}`, recording_id: id, full_text: 'x', language: 'es', speakers: JSON.stringify(segments), word_count: 200 })
  refreshTranscriptValidity(id)
}

const stored = (id: string) =>
  queryOne<{ validity_status: string; validity_json: string; speakers: string }>(
    'SELECT validity_status, validity_json, speakers FROM transcripts WHERE recording_id = ?', [id])!
const codes = (id: string) => (JSON.parse(stored(id).validity_json).reasons as Array<{ code: string }>).map((r) => r.code)

function deps(): SamplerDeps & { calls: { read: number; transcribe: number; compare: number } } {
  const calls = { read: 0, transcribe: 0, compare: 0 }
  return {
    calls,
    readWindow: async () => { calls.read++; return Buffer.alloc(100) },
    transcribeWindow: async () => {
      calls.transcribe++
      return { text: 'una frase con bastantes palabras para comparar con lo guardado', model: 'gemini-test', costUsd: 0.0034 }
    },
    compare: async (pairs) => { calls.compare++; return pairs.map(() => 'same' as const) },
    now: () => new Date('2026-10-13T15:00:00')
  }
}

beforeAll(async () => {
  mkdirSync(paths.cache, { recursive: true })
  await initializeDatabase()
  applyQualityRules(config.value)
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
  if (existsSync(paths.cache)) rmSync(paths.cache, { recursive: true, force: true })
})

describe('speaker-only doubt', () => {
  it('is doubtful with only the speaker reason, and never reads or transcribes a window', async () => {
    seed('speakers-only', '2026-10-12T10:00:00Z', false)
    expect(stored('speakers-only').validity_status).toBe('doubtful')
    expect(codes('speakers-only')).toEqual(['more_speakers_than_invited'])
    const before = stored('speakers-only').speakers

    const d = deps()
    const result = await runSamplingPass(d)
    expect(result).toMatchObject({ sampled: [], failed: 0 })
    expect(d.calls).toEqual({ read: 0, transcribe: 0, compare: 0 })
    expect(queryOne('SELECT 1 AS x FROM transcript_samples WHERE recording_id = ?', ['speakers-only'])).toBeUndefined()
    // The warning and the transcript stay as they were: not valid just because it was looked at.
    expect(stored('speakers-only').validity_status).toBe('doubtful')
    expect(stored('speakers-only').speakers).toBe(before)
  })

  it('returns before planning windows when sampleRecording is called on it directly', async () => {
    const row = {
      recording_id: 'speakers-only', file_path: join(paths.cache, 'speakers-only.hda'), speakers: stored('speakers-only').speakers,
      validity_json: stored('speakers-only').validity_json, method: 'mp3-frame-gain', sampled_fingerprint: null
    }
    const d = deps()
    expect(await sampleRecording(row, d)).toBeNull()
    expect(d.calls).toEqual({ read: 0, transcribe: 0, compare: 0 })
  })
})

describe('mixed doubt', () => {
  it('still samples the audio, spends the day\'s slot on it, and does not use it up on a speaker-only row', async () => {
    // Newer than the speaker-only row, so a slot wasted on that row would starve this one.
    seed('speakers-and-timing', '2026-10-11T10:00:00Z', true)
    seed('speakers-only-newest', '2026-10-13T08:00:00Z', false)
    expect(codes('speakers-and-timing')).toEqual(expect.arrayContaining(['more_speakers_than_invited', 'timestamps_consistently_wrong']))

    const d = deps()
    const result = await runSamplingPass(d)
    expect(result.sampled.map((s) => [s.recordingId, s.verdict])).toEqual([['speakers-and-timing', 'confirmed']])
    expect(d.calls.transcribe).toBeGreaterThan(0)
    expect(d.calls.compare).toBe(1)
  })

  it('cannot pretend the voices were verified: the text matched, the speaker doubt stays', () => {
    expect(stored('speakers-and-timing').validity_status).toBe('doubtful')
    expect(codes('speakers-and-timing')).toContain('more_speakers_than_invited')
    const sample = queryOne<{ windows_json: string }>('SELECT windows_json FROM transcript_samples WHERE recording_id = ?', ['speakers-and-timing'])!
    expect(JSON.parse(sample.windows_json).speakersChecked).toBe(false)
  })
})
