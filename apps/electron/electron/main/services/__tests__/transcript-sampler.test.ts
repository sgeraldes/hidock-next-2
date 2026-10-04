// @vitest-environment node

/**
 * The sampling pass against a real SQLite database and a real envelope, with
 * the transcriber and Jev replaced: a doubtful transcript is sampled once, the
 * verdict settles its validity, a transcript sampled as it is now is not
 * sampled again, and the daily allowance and the switches hold.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-sampler-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-sampler-cache-${process.pid}-${Date.now()}`)

const config = vi.hoisted(() => ({
  value: {
    transcription: { valueClassificationMinConfidence: 0.6, jevApiKey: 'jev-test', geminiApiKey: 'gem-test' }, // pragma: allowlist secret
    decisions: {},
    quality: { samplesPerDay: 2 },
  } as Record<string, any>,
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
}))
vi.mock('../config', () => ({ getConfig: () => config.value }))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))
vi.mock('../brains', () => ({ resolveGeminiApiKey: () => config.value.transcription.geminiApiKey }))

import { initializeDatabase, closeDatabase, run, queryOne, insertTranscript } from '../database'
import { refreshTranscriptValidity } from '../transcript-validity-store'
import { runSamplingPass, type SamplerDeps } from '../transcript-sampler'
import { applyQualityRules } from '../quality-rules'
import { FRAME_SECONDS } from '../audio-profile'

function seedDoubtful(id: string, date: string): void {
  const file = join(paths.cache, `${id}.hda`)
  writeFileSync(file, Buffer.alloc(16))
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, ?, 600, 'file', ?, 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, 0)`,
    [id, `${id}.hda`, file, date]
  )
  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
        sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, 1, 'mp3-frame-gain', 1, 1, 600, 600, 1, 600, 160, 0, 'speech', '[]', '2026-09-25T23:29:04.713Z')`,
    [id]
  )
  mkdirSync(join(paths.cache, 'audio-envelope'), { recursive: true })
  writeFileSync(join(paths.cache, 'audio-envelope', `${id}.u8`), new Uint8Array(Math.round(600 / FRAME_SECONDS)).fill(160))
  // Consistently wrong times: pairs of lines start at the same second.
  const segments = Array.from({ length: 20 }, (_, i) => ({
    speaker: 'A',
    start: Math.floor(i / 2) * 60,
    end: Math.floor(i / 2) * 60 + 50,
    text: Array.from({ length: 10 }, (_, w) => `w${w}-${i}`).join(' '),
  }))
  insertTranscript({ id: `trans_${id}`, recording_id: id, full_text: 'x', language: 'es', speakers: JSON.stringify(segments), word_count: 200 })
  refreshTranscriptValidity(id)
}

const validity = (id: string) =>
  queryOne<{ validity_status: string }>('SELECT validity_status FROM transcripts WHERE recording_id = ?', [id])?.validity_status

function deps(match: 'same' | 'different', now = new Date('2026-10-04T15:00:00')): SamplerDeps & { calls: { transcribe: number; compare: number } } {
  const calls = { transcribe: 0, compare: 0 }
  return {
    calls,
    readWindow: async () => Buffer.alloc(100),
    transcribeWindow: async () => {
      calls.transcribe++
      return { text: 'una frase con bastantes palabras para comparar con lo guardado', model: 'gemini-test', costUsd: 0.0034 }
    },
    compare: async (pairs) => {
      calls.compare++
      return pairs.map(() => match)
    },
    now: () => now,
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

describe('runSamplingPass', () => {
  it('samples the newest doubtful transcripts up to the daily allowance and settles them', async () => {
    seedDoubtful('old', '2026-09-01T10:00:00Z')
    seedDoubtful('mid', '2026-09-15T10:00:00Z')
    seedDoubtful('new', '2026-10-01T10:00:00Z')
    expect(validity('new')).toBe('doubtful')

    const d = deps('same')
    const result = await runSamplingPass(d)
    expect(result.sampled.map((s) => s.recordingId)).toEqual(['new', 'mid'])
    expect(result.sampled.every((s) => s.verdict === 'confirmed')).toBe(true)
    expect(d.calls.compare).toBe(2) // one Jev call per recording
    expect(validity('new')).toBe('valid')
    expect(validity('old')).toBe('doubtful')
    const row = queryOne<{ cost_usd: number; windows_json: string }>('SELECT cost_usd, windows_json FROM transcript_samples WHERE recording_id = ?', ['new'])
    expect(row!.cost_usd).toBeCloseTo(0.0034 * JSON.parse(row!.windows_json).length)
  })

  it('stops at the allowance for the day, and goes on the next day', async () => {
    expect(await runSamplingPass(deps('same'))).toMatchObject({ skipped: 'daily-limit' })
    const next = await runSamplingPass(deps('different', new Date('2026-10-05T09:00:00')))
    expect(next.sampled.map((s) => [s.recordingId, s.verdict])).toEqual([['old', 'contradicted']])
    expect(validity('old')).toBe('invalid')
  })

  it('never samples a transcript twice as it is', async () => {
    const d = deps('same', new Date('2026-10-06T09:00:00'))
    expect((await runSamplingPass(d)).sampled).toEqual([])
    expect(d.calls.transcribe).toBe(0)
  })

  it('does nothing when switched off or with no engine', async () => {
    applyQualityRules({ quality: { samplesPerDay: 0 } })
    expect(await runSamplingPass(deps('same'))).toMatchObject({ skipped: 'off' })
    applyQualityRules(config.value)
    config.value.transcription.jevApiKey = ''
    expect(await runSamplingPass(deps('same'))).toMatchObject({ skipped: 'no-engine' })
    config.value.transcription.jevApiKey = 'jev-test' // pragma: allowlist secret
  })
})
