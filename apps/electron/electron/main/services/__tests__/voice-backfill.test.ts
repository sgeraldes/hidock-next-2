// @vitest-environment node

/**
 * Voice evidence for older recordings (spec 2026-10-03, section 1b).
 *
 * REAL temp DB, real database.ts (better-sqlite3). The voice worker is never run: the
 * preflight is injected and writes what persistMatches would write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-voice-backfill-${process.pid}.sqlite`)
const audioDir = join(tmpdir(), `hidock-voice-backfill-audio-${process.pid}`)

const transcriptionConfig = vi.hoisted(() => ({
  current: {} as Record<string, unknown>
}))

vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: transcriptionConfig.current }),
  getDataPath: () => tmpdir(),
  updateConfig: vi.fn()
}))
const identityRules = vi.hoisted(() => vi.fn(async (_deps?: unknown) => ({ ran: true })))
vi.mock('../identity-rules', () => ({ runIdentityRules: (deps?: unknown) => identityRules(deps) }))

import { closeDatabase, initializeDatabase, queryAll, queryOne, run } from '../database'
import type { SpeakerLinkingResult } from '../speaker-linking'
import { SpeakerLinkingUnavailableError } from '../speaker-linking'
import {
  getVoiceBackfillStatus,
  isInsideWindow,
  measureOneRecording,
  pickNextRecordingForVoice,
  resetVoiceBackfillForTests,
  runVoiceBackfillOnce,
  startVoiceBackfill,
  stopVoiceBackfill,
  tieTranscriptSpeakers,
  type VoiceBackfillDeps
} from '../voice-backfill'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
  if (existsSync(audioDir)) rmSync(audioDir, { recursive: true, force: true })
}

interface RecordingSeed {
  id: string
  date?: string
  duration?: number | null
  speakers?: Array<{ speaker: string; start: number; end: number; text?: string }> | null
  integrity?: 'ok' | 'suspect' | 'broken' | null
  file?: 'present' | 'missing'
  deleted?: boolean
  personal?: boolean
  transcript?: boolean
}

function seedRecording(seed: RecordingSeed): void {
  const path = join(audioDir, `${seed.id}.mp3`)
  if ((seed.file ?? 'present') === 'present') writeFileSync(path, 'audio')
  run(
    `INSERT INTO recordings (id, filename, date_recorded, file_path, duration_seconds, deleted_at, personal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.id,
      `${seed.id}.mp3`,
      seed.date ?? '2026-09-01T10:00:00Z',
      path,
      seed.duration === undefined ? 600 : seed.duration,
      seed.deleted ? '2026-10-01T00:00:00Z' : null,
      seed.personal ? 1 : 0
    ]
  )
  if (seed.transcript === false) return
  const turns = seed.speakers === undefined ? [{ speaker: 'Speaker 1', start: 0, end: 10, text: 'hola' }] : seed.speakers
  run(
    `INSERT INTO transcripts (id, recording_id, full_text, speakers, integrity_status) VALUES (?, ?, 'x', ?, ?)`,
    [`t-${seed.id}`, seed.id, turns === null ? null : JSON.stringify(turns), seed.integrity === undefined ? 'ok' : seed.integrity]
  )
}

const turnsFor = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ speaker: `Speaker ${i + 1}`, start: i * 10, end: i * 10 + 10, text: 'x' }))

/** What persistMatches writes for one acoustic voice. */
function storeVoice(recordingId: string, local: string, clusterId: string, contactId: string | null = null): void {
  if (!queryOne('SELECT 1 FROM voice_clusters WHERE id = ?', [clusterId])) {
    run(
      `INSERT INTO voice_clusters
       (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds, contact_id)
       VALUES (?, 'community-1', '4.0.0', 3, '[1,0,0]', 1, 20, ?)`,
      [clusterId, contactId]
    )
  }
  run(
    `INSERT INTO recording_voice_clusters
     (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
     VALUES (?, ?, ?, ?, 'matched', 0.93)`,
    [recordingId, local, stableLabel(clusterId), clusterId]
  )
}

const stableLabel = (clusterId: string) => `Voice ${clusterId.slice(0, 6).toUpperCase()}`

interface FakeVoice {
  local: string
  clusterId: string
  contactId?: string | null
  segments: Array<[number, number]>
}

/** A preflight that writes the evidence and returns the result, like runSpeakerLinkingPreflight. */
function fakePreflight(voices: FakeVoice[], device = 'cpu'): NonNullable<VoiceBackfillDeps['runPreflight']> {
  return vi.fn(async (recordingId: string) => {
    for (const voice of voices) storeVoice(recordingId, voice.local, voice.clusterId, voice.contactId ?? null)
    const result: SpeakerLinkingResult = {
      available: true,
      model: 'community-1',
      modelVersion: '4.0.0',
      device,
      segments: voices.flatMap((voice) => voice.segments.map(([start, end]) => ({ start, end, speaker: voice.local }))),
      matches: voices.map((voice) => ({
        localSpeakerLabel: voice.local,
        voiceClusterId: voice.clusterId,
        stableLabel: stableLabel(voice.clusterId),
        status: 'matched' as const,
        similarity: 0.93,
        runnerUpMargin: 0.2,
        contactId: voice.contactId ?? null,
        contactName: null,
        speechSeconds: 10
      }))
    }
    return result
  })
}

/** 03:00 local time: inside the default night window. */
const NIGHT = () => new Date(2026, 9, 3, 3, 0, 0)
/** 14:00 local time: outside it. */
const AFTERNOON = () => new Date(2026, 9, 3, 14, 0, 0)

function deps(overrides: Partial<VoiceBackfillDeps> = {}): VoiceBackfillDeps {
  return {
    now: NIGHT,
    isTranscribing: () => false,
    isValueBackfillRunning: () => false,
    isBootDrainActive: () => false,
    emit: vi.fn(),
    learnVoices: vi.fn(async () => undefined),
    runPreflight: fakePreflight([{ local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 10]] }]),
    ...overrides
  }
}

const stateRow = (recordingId: string) =>
  queryOne<{ status: string; error: string | null }>(
    'SELECT status, error FROM voice_backfill_state WHERE recording_id = ?',
    [recordingId]
  )

const tiedLabels = (recordingId: string) =>
  Object.fromEntries(
    queryAll<{ local_speaker_label: string; transcript_speaker_label: string | null }>(
      'SELECT local_speaker_label, transcript_speaker_label FROM recording_voice_clusters WHERE recording_id = ?',
      [recordingId]
    ).map((row) => [row.local_speaker_label, row.transcript_speaker_label])
  )

beforeEach(async () => {
  cleanup()
  mkdirSync(audioDir, { recursive: true })
  transcriptionConfig.current = {
    speakerLinkingEnabled: true,
    speakerEngine: 'auto',
    voiceBackfill: { schedule: 'night', windowStart: '01:00', windowEnd: '07:00' }
  }
  resetVoiceBackfillForTests()
  await initializeDatabase()
  run(`INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
       VALUES ('person', 'Ana Ruiz', 'unknown', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'user')`)
})

afterEach(() => {
  stopVoiceBackfill()
  vi.useRealTimers()
  closeDatabase()
  cleanup()
})

describe('schema', () => {
  it('creates voice_backfill_state, one row per recording', () => {
    const columns = queryAll<{ name: string }>('PRAGMA table_info(voice_backfill_state)').map((c) => c.name)
    expect(columns).toEqual(['recording_id', 'attempted_at', 'status', 'error'])
    expect(EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(66)
    const version = queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v
    expect(version).toBe(EXPECTED_SCHEMA_VERSION)
  })

  it('accepts only done, failed and skipped, and goes away with its recording', () => {
    seedRecording({ id: 'r1' })
    expect(() =>
      run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status) VALUES ('r1', 'now', 'maybe')`)
    ).toThrow()
    run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status) VALUES ('r1', 'now', 'failed')`)
    run(`DELETE FROM transcripts WHERE recording_id = 'r1'`)
    run(`DELETE FROM recordings WHERE id = 'r1'`)
    expect(stateRow('r1')).toBeUndefined()
  })

  it('the migration creates the table on a database that predates v66', async () => {
    closeDatabase()
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(dbPath)
    raw.exec('DROP TABLE voice_backfill_state')
    raw.exec('DELETE FROM schema_version WHERE version >= 66')
    raw.close()

    await initializeDatabase()

    expect(queryAll('PRAGMA table_info(voice_backfill_state)')).toHaveLength(4)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })
})

describe('isInsideWindow', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m, 0)

  it('handles a window inside one day', () => {
    expect(isInsideWindow(at(9), '08:30', '17:00')).toBe(true)
    expect(isInsideWindow(at(8, 30), '08:30', '17:00')).toBe(true)
    expect(isInsideWindow(at(17), '08:30', '17:00')).toBe(false)
    expect(isInsideWindow(at(7), '08:30', '17:00')).toBe(false)
  })

  it('handles a window that crosses midnight', () => {
    expect(isInsideWindow(at(23), '22:00', '06:00')).toBe(true)
    expect(isInsideWindow(at(0, 15), '22:00', '06:00')).toBe(true)
    expect(isInsideWindow(at(5, 59), '22:00', '06:00')).toBe(true)
    expect(isInsideWindow(at(6), '22:00', '06:00')).toBe(false)
    expect(isInsideWindow(at(12), '22:00', '06:00')).toBe(false)
  })

  it('reads equal times as the whole day and a malformed time as never', () => {
    expect(isInsideWindow(at(12), '03:00', '03:00')).toBe(true)
    expect(isInsideWindow(at(3), 'late', '07:00')).toBe(false)
  })
})

describe('pickNextRecordingForVoice', () => {
  it('takes the fewest speakers first, then the shortest, then the oldest', () => {
    seedRecording({ id: 'three', speakers: turnsFor(3), duration: 60 })
    seedRecording({ id: 'one-long', speakers: turnsFor(1), duration: 3600 })
    seedRecording({ id: 'one-short-new', speakers: turnsFor(1), duration: 300, date: '2026-09-20T10:00:00Z' })
    seedRecording({ id: 'one-short-old', speakers: turnsFor(1), duration: 300, date: '2026-09-02T10:00:00Z' })
    seedRecording({ id: 'two', speakers: turnsFor(2), duration: 30 })

    const order: string[] = []
    for (;;) {
      const next = pickNextRecordingForVoice()
      if (!next) break
      order.push(next.recordingId)
      run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status) VALUES (?, 'now', 'done')`, [next.recordingId])
    }
    expect(order).toEqual(['one-short-old', 'one-short-new', 'one-long', 'two', 'three'])
  })

  it('puts transcripts without speaker turns last', () => {
    seedRecording({ id: 'unknown', speakers: null, duration: 10 })
    seedRecording({ id: 'four', speakers: turnsFor(4), duration: 900 })
    expect(pickNextRecordingForVoice()?.recordingId).toBe('four')
  })

  it('skips trash, personal, untranscribed, missing audio, recordings with evidence and recordings already tried', () => {
    seedRecording({ id: 'trash', deleted: true })
    seedRecording({ id: 'personal', personal: true })
    seedRecording({ id: 'untranscribed', transcript: false })
    seedRecording({ id: 'no-file', file: 'missing' })
    seedRecording({ id: 'has-voices' })
    storeVoice('has-voices', 'SPEAKER_00', 'cccccc00-0000')
    seedRecording({ id: 'failed' })
    run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status, error) VALUES ('failed', 'now', 'failed', 'x')`)
    expect(pickNextRecordingForVoice()).toBeNull()

    seedRecording({ id: 'good', duration: 120 })
    expect(pickNextRecordingForVoice()).toEqual({
      recordingId: 'good',
      audioPath: join(audioDir, 'good.mp3'),
      durationSeconds: 120
    })
  })
})

describe('tieTranscriptSpeakers', () => {
  const linking = (voices: FakeVoice[]): SpeakerLinkingResult => ({
    available: true,
    model: 'community-1',
    modelVersion: '4.0.0',
    device: 'cpu',
    segments: voices.flatMap((voice) => voice.segments.map(([start, end]) => ({ start, end, speaker: voice.local }))),
    matches: voices.map((voice) => ({
      localSpeakerLabel: voice.local,
      voiceClusterId: voice.clusterId,
      stableLabel: stableLabel(voice.clusterId),
      status: 'matched' as const,
      similarity: 0.93,
      runnerUpMargin: 0.2,
      contactId: null,
      contactName: null,
      speechSeconds: 10
    }))
  })

  function prepare(id: string, integrity: 'ok' | 'suspect', voices: FakeVoice[]): SpeakerLinkingResult {
    seedRecording({ id, speakers: turnsFor(2), integrity })
    for (const voice of voices) storeVoice(id, voice.local, voice.clusterId)
    return linking(voices)
  }

  it('ties each acoustic voice to the transcript speaker it overlaps most, and leaves the turns alone', () => {
    const result = prepare('r', 'ok', [
      { local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 9]] },
      { local: 'SPEAKER_01', clusterId: 'bbbbbb00-0000', segments: [[10.5, 20]] }
    ])
    const before = queryOne<{ speakers: string }>('SELECT speakers FROM transcripts WHERE recording_id = ?', ['r'])!.speakers

    expect(tieTranscriptSpeakers('r', result)).toBe(2)

    expect(tiedLabels('r')).toEqual({ SPEAKER_00: 'Speaker 1', SPEAKER_01: 'Speaker 2' })
    expect(queryOne<{ speakers: string }>('SELECT speakers FROM transcripts WHERE recording_id = ?', ['r'])!.speakers).toBe(before)
  })

  it('ties nothing when the transcript is not ok', () => {
    const result = prepare('r', 'suspect', [
      { local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 10]] },
      { local: 'SPEAKER_01', clusterId: 'bbbbbb00-0000', segments: [[10, 20]] }
    ])
    expect(tieTranscriptSpeakers('r', result)).toBe(0)
    expect(tiedLabels('r')).toEqual({ SPEAKER_00: null, SPEAKER_01: null })
  })

  it('ties nothing below the strong overlap share', () => {
    // 3 of 10 seconds of Speaker 1: 0.30, under 0.35.
    const result = prepare('r', 'ok', [{ local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 3]] }])
    expect(tieTranscriptSpeakers('r', result)).toBe(0)
    expect(tiedLabels('r')).toEqual({ SPEAKER_00: null })
  })

  it('ties nothing when one voice is the best match for two transcript speakers', () => {
    const result = prepare('r', 'ok', [
      { local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 20]] },
      { local: 'SPEAKER_01', clusterId: 'bbbbbb00-0000', segments: [[20, 21]] }
    ])
    expect(tieTranscriptSpeakers('r', result)).toBe(0)
    expect(tiedLabels('r')).toEqual({ SPEAKER_00: null, SPEAKER_01: null })
  })

  it('keeps a stable label the transcript already uses, whatever its integrity', () => {
    seedRecording({
      id: 'r',
      integrity: 'suspect',
      speakers: [{ speaker: stableLabel('aaaaaa00-0000'), start: 0, end: 10 }]
    })
    storeVoice('r', 'SPEAKER_00', 'aaaaaa00-0000')
    const result = linking([{ local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', segments: [[0, 10]] }])
    expect(tieTranscriptSpeakers('r', result)).toBe(1)
    expect(tiedLabels('r')).toEqual({ SPEAKER_00: stableLabel('aaaaaa00-0000') })
  })
})

describe('runVoiceBackfillOnce', () => {
  it('does nothing when the schedule is off, outside the night window, or while other heavy work runs', async () => {
    seedRecording({ id: 'r' })
    const preflight = fakePreflight([])

    transcriptionConfig.current.voiceBackfill = { schedule: 'off', windowStart: '01:00', windowEnd: '07:00' }
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight }))).toMatchObject({ ran: false, reason: 'off' })

    transcriptionConfig.current.voiceBackfill = { schedule: 'night', windowStart: '01:00', windowEnd: '07:00' }
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight, now: AFTERNOON }))).toMatchObject({
      ran: false,
      reason: 'outside-window'
    })
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight, isTranscribing: () => true }))).toMatchObject({
      ran: false,
      reason: 'transcription-active'
    })
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight, isValueBackfillRunning: () => true }))).toMatchObject({
      ran: false,
      reason: 'value-backfill'
    })
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight, isBootDrainActive: () => true }))).toMatchObject({
      ran: false,
      reason: 'boot-drain'
    })

    transcriptionConfig.current.speakerEngine = 'off'
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight }))).toMatchObject({ ran: false, reason: 'engine-off' })

    expect(preflight).not.toHaveBeenCalled()
  })

  it('runs in the background schedule at any hour', async () => {
    seedRecording({ id: 'r' })
    transcriptionConfig.current.voiceBackfill = { schedule: 'background', windowStart: '01:00', windowEnd: '07:00' }
    expect(await runVoiceBackfillOnce(deps({ now: AFTERNOON }))).toMatchObject({ ran: true, recordingId: 'r', outcome: 'done' })
  })

  it('reports when nothing is left', async () => {
    expect(await runVoiceBackfillOnce(deps())).toMatchObject({ ran: false, reason: 'nothing-left' })
  })

  it('runs one recording, ties the speakers, names known voices and records it', async () => {
    seedRecording({ id: 'r', speakers: turnsFor(2) })
    const emit = vi.fn()
    const preflight = fakePreflight([
      { local: 'SPEAKER_00', clusterId: 'aaaaaa00-0000', contactId: 'person', segments: [[0, 10]] },
      { local: 'SPEAKER_01', clusterId: 'bbbbbb00-0000', segments: [[10, 20]] }
    ])

    const outcome = await runVoiceBackfillOnce(deps({ runPreflight: preflight, emit }))

    expect(outcome).toMatchObject({ ran: true, recordingId: 'r', outcome: 'done' })
    expect(preflight).toHaveBeenCalledWith('r', join(audioDir, 'r.mp3'), expect.any(Function), 600)
    expect(stateRow('r')).toEqual({ status: 'done', error: null })
    expect(tiedLabels('r')).toEqual({ SPEAKER_00: 'Speaker 1', SPEAKER_01: 'Speaker 2' })
    expect(
      queryOne('SELECT contact_id, source FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?', ['r', 'Speaker 1'])
    ).toEqual({ contact_id: 'person', source: 'voice' })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ recordingId: 'r', outcome: 'done', done: 1, remaining: 0 }))
  })

  it('learns voices after a recording gets its voices, and only then (spec 2026-10-03, Phase 2)', async () => {
    seedRecording({ id: 'r1', duration: 60 })
    seedRecording({ id: 'r2', duration: 120 })
    seedRecording({ id: 'r3', duration: 180 })
    const learnVoices = vi.fn(async () => undefined)

    await runVoiceBackfillOnce(deps({ learnVoices }))
    expect(learnVoices).toHaveBeenCalledTimes(1)

    await runVoiceBackfillOnce(deps({ learnVoices, runPreflight: fakePreflight([]) }))
    await runVoiceBackfillOnce(deps({ learnVoices, runPreflight: vi.fn().mockRejectedValue(new Error('boom')) }))
    expect(learnVoices).toHaveBeenCalledTimes(1)
  })

  it('by default, the identity rules run after the voice learning pass (spec 2026-10-03, Phase 3)', async () => {
    seedRecording({ id: 'r' })
    identityRules.mockClear()
    await runVoiceBackfillOnce(deps({ learnVoices: undefined }))
    expect(identityRules).toHaveBeenCalledTimes(1)
    expect(identityRules).toHaveBeenCalledWith(expect.objectContaining({ isTranscribing: expect.any(Function) }))
  })

  it('a failure while learning voices does not change the recording outcome', async () => {
    seedRecording({ id: 'r' })
    const learnVoices = vi.fn(async () => {
      throw new Error('learning broke')
    })
    expect(await runVoiceBackfillOnce(deps({ learnVoices }))).toMatchObject({ outcome: 'done' })
    expect(stateRow('r')?.status).toBe('done')
  })

  it('records a recording where no voice spoke long enough as skipped', async () => {
    seedRecording({ id: 'r' })
    expect(await runVoiceBackfillOnce(deps({ runPreflight: fakePreflight([]) }))).toMatchObject({ outcome: 'skipped' })
    expect(stateRow('r')?.status).toBe('skipped')
    expect(pickNextRecordingForVoice()).toBeNull()
  })

  it('records a failure with its error and moves on to the next recording', async () => {
    seedRecording({ id: 'first', duration: 60 })
    seedRecording({ id: 'second', duration: 120 })
    const preflight = vi.fn().mockRejectedValueOnce(new Error('invalid speaker-linking worker output: boom'))

    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight }))).toMatchObject({ recordingId: 'first', outcome: 'failed' })
    expect(stateRow('first')).toEqual({ status: 'failed', error: 'invalid speaker-linking worker output: boom' })
    expect(getVoiceBackfillStatus().lastError).toBe('invalid speaker-linking worker output: boom')
    expect(pickNextRecordingForVoice()?.recordingId).toBe('second')
  })

  it('treats a timeout as a failure of that recording', async () => {
    seedRecording({ id: 'r' })
    const preflight = vi.fn().mockRejectedValue(new SpeakerLinkingUnavailableError('speaker-linking timed out after 900 seconds'))
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight }))).toMatchObject({ outcome: 'failed' })
    expect(stateRow('r')?.status).toBe('failed')
  })

  it('does not blame the recording when the voice worker cannot run on this computer', async () => {
    seedRecording({ id: 'r' })
    const preflight = vi.fn().mockRejectedValue(new SpeakerLinkingUnavailableError('ModuleNotFoundError: No module named pyannote'))
    expect(await runVoiceBackfillOnce(deps({ runPreflight: preflight }))).toMatchObject({ ran: true, outcome: 'unavailable' })
    expect(stateRow('r')).toBeUndefined()
    expect(getVoiceBackfillStatus().lastError).toBe('ModuleNotFoundError: No module named pyannote')
  })

  it('stops when a transcription starts or the window closes, and leaves the recording for later', async () => {
    seedRecording({ id: 'r' })
    let transcribing = false
    let hour = 3
    const seen: boolean[] = []
    const preflight = vi.fn(async (_id: string, _path: string, shouldContinue: () => boolean) => {
      seen.push(shouldContinue())
      transcribing = true
      seen.push(shouldContinue())
      transcribing = false
      hour = 7
      seen.push(shouldContinue())
      throw new Error('speaker-linking cancelled because recording became ineligible')
    })

    const outcome = await runVoiceBackfillOnce(
      deps({
        runPreflight: preflight as never,
        isTranscribing: () => transcribing,
        now: () => new Date(2026, 9, 3, hour, 0, 0)
      })
    )

    expect(seen).toEqual([true, false, false])
    expect(outcome).toMatchObject({ ran: true, outcome: 'cancelled' })
    expect(stateRow('r')).toBeUndefined()
  })
})

describe('measureOneRecording', () => {
  it('runs one recording now, outside the window, and says how long it took', async () => {
    seedRecording({ id: 'r', duration: 1200 })
    let clock = 1_000
    const result = await measureOneRecording(
      deps({
        now: AFTERNOON,
        clock: () => clock,
        runPreflight: vi.fn(async () => {
          clock += 90_000
          return {
            available: true,
            model: 'community-1',
            modelVersion: '4.0.0',
            device: 'cuda',
            segments: [],
            matches: []
          } satisfies SpeakerLinkingResult
        })
      })
    )
    expect(result).toEqual({ recordingId: 'r', seconds: 90, audioSeconds: 1200, device: 'cuda' })
    expect(getVoiceBackfillStatus().lastMeasure).toEqual(result)
  })

  it('says so when there is nothing to measure', async () => {
    await expect(measureOneRecording(deps())).rejects.toThrow('No recording is waiting for voice evidence.')
  })
})

describe('getVoiceBackfillStatus', () => {
  it('counts done, failed and remaining over the transcribed library, with the audio left', () => {
    seedRecording({ id: 'with-voices' })
    storeVoice('with-voices', 'SPEAKER_00', 'aaaaaa00-0000')
    seedRecording({ id: 'failed' })
    run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status, error) VALUES ('failed', 'now', 'failed', 'x')`)
    seedRecording({ id: 'no-voices' })
    run(`INSERT INTO voice_backfill_state (recording_id, attempted_at, status) VALUES ('no-voices', 'now', 'skipped')`)
    seedRecording({ id: 'left-1', duration: 600 })
    seedRecording({ id: 'left-2', duration: 1800 })
    seedRecording({ id: 'trash', deleted: true })
    seedRecording({ id: 'untranscribed', transcript: false })

    expect(getVoiceBackfillStatus()).toMatchObject({
      schedule: 'night',
      window: { start: '01:00', end: '07:00' },
      total: 5,
      done: 1,
      skipped: 1,
      failed: 1,
      remaining: 2,
      remainingAudioSeconds: 2400,
      running: false,
      lastRunAt: null,
      lastError: null
    })
  })

  // Review of #129: a recording whose audio is not on this computer can never be measured, so it
  // must not stay in "to go" or in the time estimate for ever.
  it('counts recordings without their audio file apart, not as remaining', () => {
    seedRecording({ id: 'left', duration: 600 })
    seedRecording({ id: 'gone', duration: 3600, file: 'missing' })
    run(`UPDATE recordings SET file_path = '' WHERE id = 'gone'`)
    seedRecording({ id: 'moved', duration: 1200, file: 'missing' })

    expect(getVoiceBackfillStatus()).toMatchObject({ total: 3, remaining: 1, remainingAudioSeconds: 600, noAudio: 2 })
  })

  it('falls back to the default schedule when the config has none', () => {
    delete transcriptionConfig.current.voiceBackfill
    expect(getVoiceBackfillStatus()).toMatchObject({ schedule: 'night', window: { start: '01:00', end: '07:00' } })
  })
})

describe('startVoiceBackfill', () => {
  it('ticks every two minutes, one run at a time, until stopped', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const runOnce = vi.fn(
      () =>
        new Promise<{ ran: boolean }>((resolve) => {
          release = () => resolve({ ran: true })
        })
    )
    startVoiceBackfill({ runOnce })

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(runOnce).toHaveBeenCalledTimes(1)
    // Still running: no second tick starts beside it.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(runOnce).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(runOnce).toHaveBeenCalledTimes(2)

    stopVoiceBackfill()
    release()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(runOnce).toHaveBeenCalledTimes(2)
  })
})
