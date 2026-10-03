/**
 * Voice evidence for recordings transcribed before voices were measured (spec
 * docs/superpowers/specs/2026-10-03-people-identity-autoresolve-design.md, section 1b).
 *
 * Voice evidence used to come only from transcription. This job runs the same acoustic step
 * (runSpeakerLinkingPreflight: diarization plus the WeSpeaker embedding, stored as voice
 * clusters) for transcribed recordings that have none, one recording at a time, without
 * transcribing again. Then it ties each acoustic voice to the transcript's own speaker label
 * when the transcript's timing can be trusted, so known voices name those speakers.
 *
 * Where it runs is the existing speakerEngine (a paired Model Host, or this computer at low
 * priority with the configured CPU share). When it runs is transcription.voiceBackfill: at
 * night by default, in the background, or never. It always waits for a transcription, the
 * value scan and the boot tasks.
 */

import { existsSync } from 'fs'
import { getConfig } from './config'
import { queryAll, queryOne, run, runInTransaction, runNoSave } from './database'
import { getEventBus } from './event-bus'
import { filterEligibleRecordingIds, isRecordingEligible } from './recording-eligibility'
import {
  applyKnownVoiceBindings,
  runSpeakerLinkingPreflight,
  SpeakerLinkingUnavailableError,
  STRONG_SPEAKER_OVERLAP,
  type SpeakerLinkingResult
} from './speaker-linking'
import { resolveSpeakerEngine } from './speaker-engines'
import { getActiveTranscriptions } from './transcription-activity'
import { runVoiceLearning } from './voice-learning'
import {
  DEFAULT_VOICE_BACKFILL,
  type VoiceBackfillConfig,
  type VoiceBackfillMeasure,
  type VoiceBackfillStatus
} from '../../../src/shared/voice-backfill-schedule'

export type { VoiceBackfillMeasure, VoiceBackfillStatus }

/** How often the scheduler looks for the next recording. */
export const VOICE_BACKFILL_TICK_MS = 2 * 60_000

export type VoiceBackfillOutcome = 'done' | 'skipped' | 'failed' | 'cancelled' | 'unavailable'

export type VoiceBackfillSkipReason =
  | 'off'
  | 'engine-off'
  | 'outside-window'
  | 'transcription-active'
  | 'value-backfill'
  | 'boot-drain'
  | 'already-running'
  | 'nothing-left'

export interface VoiceBackfillRun {
  ran: boolean
  reason?: VoiceBackfillSkipReason
  recordingId?: string
  outcome?: VoiceBackfillOutcome
}

export interface VoiceBackfillDeps {
  now?: () => Date
  /** Milliseconds, for timing a run. */
  clock?: () => number
  isTranscribing?: () => boolean
  isValueBackfillRunning?: () => boolean
  isBootDrainActive?: () => boolean
  runPreflight?: typeof runSpeakerLinkingPreflight
  emit?: (payload: VoiceBackfillProgress) => void
  /** Voice learning (voice-learning.ts), run after a recording gets its voices. */
  learnVoices?: () => Promise<unknown>
}

export interface VoiceBackfillProgress {
  recordingId: string
  outcome: VoiceBackfillOutcome
  total: number
  done: number
  skipped: number
  failed: number
  remaining: number
}

export interface NextVoiceRecording {
  recordingId: string
  audioPath: string
  durationSeconds: number | null
}

let running = false
let stopRequested = false
let lastRunAt: string | null = null
let lastError: string | null = null
let lastMeasure: VoiceBackfillMeasure | null = null
let schedulerActive = false
let timer: ReturnType<typeof setTimeout> | null = null

/** Test-only: forget the in-memory state between tests. */
export function resetVoiceBackfillForTests(): void {
  running = false
  stopRequested = false
  lastRunAt = null
  lastError = null
  lastMeasure = null
  schedulerActive = false
  if (timer) clearTimeout(timer)
  timer = null
}

function currentSchedule(): VoiceBackfillConfig {
  const configured = getConfig().transcription.voiceBackfill
  return { ...DEFAULT_VOICE_BACKFILL, ...(configured ?? {}) }
}

function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Whether local time `now` falls in [windowStart, windowEnd). A window whose end is earlier
 * than its start crosses midnight; equal times mean the whole day; a malformed time, never.
 */
export function isInsideWindow(now: Date, windowStart: string, windowEnd: string): boolean {
  const start = minutesOf(windowStart)
  const end = minutesOf(windowEnd)
  if (start === null || end === null) return false
  if (start === end) return true
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

/**
 * The next transcribed recording without voice evidence: fewest transcript speakers first
 * (the simplest meetings teach voices best), then the shortest, then the oldest. Transcripts
 * without speaker turns go last. Never one in Trash, personal or value-excluded, never one
 * already tried, never one whose audio file is not on this computer.
 */
export function pickNextRecordingForVoice(): NextVoiceRecording | null {
  const rows = queryAll<{ id: string; file_path: string | null; duration_seconds: number | null }>(
    `SELECT id, file_path, duration_seconds FROM (
       SELECT r.id, r.file_path, r.duration_seconds, r.date_recorded,
              CASE WHEN t.speakers IS NOT NULL AND json_valid(t.speakers) AND json_type(t.speakers) = 'array'
                   THEN (SELECT COUNT(DISTINCT json_extract(j.value, '$.speaker')) FROM json_each(t.speakers) j)
                   ELSE NULL END AS speaker_count
         FROM recordings r
         JOIN transcripts t ON t.recording_id = r.id
        WHERE r.deleted_at IS NULL
          AND r.file_path IS NOT NULL AND r.file_path != ''
          AND NOT EXISTS (SELECT 1 FROM recording_voice_clusters rvc WHERE rvc.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM voice_backfill_state s WHERE s.recording_id = r.id)
     )
     ORDER BY CASE WHEN COALESCE(speaker_count, 0) = 0 THEN 1 ELSE 0 END,
              speaker_count,
              COALESCE(duration_seconds, 1e18),
              date_recorded,
              id`
  )
  if (!rows.length) return null
  const { eligible } = filterEligibleRecordingIds(rows.map((row) => row.id))
  for (const row of rows) {
    if (!eligible.has(row.id) || !row.file_path || !existsSync(row.file_path)) continue
    return { recordingId: row.id, audioPath: row.file_path, durationSeconds: row.duration_seconds }
  }
  return null
}

interface Turn {
  speaker: string
  start: number
  end: number
}

function parseTurns(speakersJson: string | null): Turn[] {
  if (!speakersJson) return []
  try {
    const parsed = JSON.parse(speakersJson) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((turn: Record<string, unknown>) => {
      const start = Number(turn?.start)
      const end = Number(turn?.end)
      const speaker = typeof turn?.speaker === 'string' ? turn.speaker : ''
      return speaker && Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ speaker, start, end }] : []
    })
  } catch {
    return []
  }
}

/**
 * Tie each acoustic voice of a recording to the transcript speaker label it overlaps most.
 *
 * persistMatches stores the stable "Voice XXXXXX" label, which is what a transcription made
 * with voices uses. An older transcript has its own labels ("Speaker 1"), so:
 * - a stable label the transcript already uses is kept;
 * - otherwise, only when the transcript's integrity is 'ok', a voice takes the transcript
 *   speaker it covers best, if that covers at least STRONG_SPEAKER_OVERLAP of the speaker's
 *   time and no other transcript speaker picked the same voice (one to one);
 * - every other voice gets no label: the recording still knows which voices it holds.
 * The transcript itself is never rewritten. Returns how many voices were tied.
 */
export function tieTranscriptSpeakers(recordingId: string, linking: SpeakerLinkingResult): number {
  const transcript = queryOne<{ speakers: string | null; integrity_status: string | null }>(
    'SELECT speakers, integrity_status FROM transcripts WHERE recording_id = ?',
    [recordingId]
  )
  const turns = parseTurns(transcript?.speakers ?? null)
  const transcriptLabels = new Set(turns.map((turn) => turn.speaker))
  const tie = new Map<string, string>()

  for (const match of linking.matches) {
    if (transcriptLabels.has(match.stableLabel)) tie.set(match.localSpeakerLabel, match.stableLabel)
  }

  if (transcript?.integrity_status === 'ok') {
    const voices = linking.matches.map((match) => match.localSpeakerLabel).filter((local) => !tie.has(local))
    const takenLabels = new Set(tie.values())
    const speakingTime = new Map<string, number>()
    for (const turn of turns) speakingTime.set(turn.speaker, (speakingTime.get(turn.speaker) ?? 0) + turn.end - turn.start)

    const choiceByLabel = new Map<string, string>()
    for (const label of transcriptLabels) {
      if (takenLabels.has(label)) continue
      const overlapByVoice = new Map<string, number>()
      for (const turn of turns) {
        if (turn.speaker !== label) continue
        for (const segment of linking.segments) {
          if (!voices.includes(segment.speaker)) continue
          const overlap = Math.max(0, Math.min(turn.end, segment.end) - Math.max(turn.start, segment.start))
          if (overlap > 0) overlapByVoice.set(segment.speaker, (overlapByVoice.get(segment.speaker) ?? 0) + overlap)
        }
      }
      const ranked = [...overlapByVoice.entries()].sort((a, b) => b[1] - a[1])
      const best = ranked[0]
      if (!best || (ranked[1] && ranked[1][1] === best[1])) continue
      if (best[1] / (speakingTime.get(label) ?? Infinity) < STRONG_SPEAKER_OVERLAP) continue
      choiceByLabel.set(label, best[0])
    }
    const labelsPerVoice = new Map<string, string[]>()
    for (const [label, voice] of choiceByLabel) labelsPerVoice.set(voice, [...(labelsPerVoice.get(voice) ?? []), label])
    for (const [voice, labels] of labelsPerVoice) {
      if (labels.length === 1) tie.set(voice, labels[0])
    }
  }

  return runInTransaction(() => {
    for (const match of linking.matches) {
      runNoSave(
        `UPDATE recording_voice_clusters SET transcript_speaker_label = ?
          WHERE recording_id = ? AND local_speaker_label = ?`,
        [tie.get(match.localSpeakerLabel) ?? null, recordingId, match.localSpeakerLabel]
      )
    }
    return tie.size
  })
}

function recordAttempt(recordingId: string, status: 'done' | 'failed' | 'skipped', error: string | null, at: string): void {
  run(
    `INSERT INTO voice_backfill_state (recording_id, attempted_at, status, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET attempted_at = excluded.attempted_at,
       status = excluded.status, error = excluded.error`,
    [recordingId, at, status, error]
  )
}

interface Counts {
  total: number
  done: number
  skipped: number
  failed: number
  remaining: number
  remainingAudioSeconds: number
  /** Not measurable here: no audio file on this computer. Kept out of remaining and the estimate. */
  noAudio: number
}

function countLibrary(): Counts {
  const rows = queryAll<{
    id: string
    file_path: string | null
    duration_seconds: number | null
    has_voices: number
    status: string | null
  }>(
    `SELECT r.id, r.file_path, r.duration_seconds,
            EXISTS (SELECT 1 FROM recording_voice_clusters rvc WHERE rvc.recording_id = r.id) AS has_voices,
            s.status
       FROM recordings r
       JOIN transcripts t ON t.recording_id = r.id
       LEFT JOIN voice_backfill_state s ON s.recording_id = r.id
      WHERE r.deleted_at IS NULL`
  )
  const { eligible } = filterEligibleRecordingIds(rows.map((row) => row.id))
  const counts: Counts = { total: 0, done: 0, skipped: 0, failed: 0, remaining: 0, remainingAudioSeconds: 0, noAudio: 0 }
  for (const row of rows) {
    if (!eligible.has(row.id)) continue
    counts.total++
    if (row.has_voices || row.status === 'done') counts.done++
    else if (row.status === 'failed') counts.failed++
    else if (row.status === 'skipped') counts.skipped++
    else if (!row.file_path || !existsSync(row.file_path)) counts.noAudio++
    else {
      counts.remaining++
      counts.remainingAudioSeconds += Math.max(0, row.duration_seconds ?? 0)
    }
  }
  return counts
}

export function getVoiceBackfillStatus(): VoiceBackfillStatus {
  const schedule = currentSchedule()
  return {
    schedule: schedule.schedule,
    window: { start: schedule.windowStart, end: schedule.windowEnd },
    ...countLibrary(),
    lastRunAt,
    lastError,
    running,
    lastMeasure
  }
}

interface ResolvedDeps {
  now: () => Date
  clock: () => number
  isTranscribing: () => boolean
  isValueBackfillRunning: () => boolean
  isBootDrainActive: () => boolean
  runPreflight: typeof runSpeakerLinkingPreflight
  emit: (payload: VoiceBackfillProgress) => void
  learnVoices: () => Promise<unknown>
}

/** The value scan and the boot scheduler are loaded only when the job really asks them. */
async function resolveDeps(deps: VoiceBackfillDeps): Promise<ResolvedDeps> {
  const isTranscribing = deps.isTranscribing ?? (() => getActiveTranscriptions().length > 0)
  return {
    now: deps.now ?? (() => new Date()),
    clock: deps.clock ?? (() => Date.now()),
    isTranscribing,
    learnVoices: deps.learnVoices ?? (() => runVoiceLearning({ isTranscribing })),
    isValueBackfillRunning: deps.isValueBackfillRunning ?? (await import('./value-backfill')).isValueBackfillRunning,
    isBootDrainActive: deps.isBootDrainActive ?? (await import('./boot-scheduler')).isBootDrainActive,
    runPreflight: deps.runPreflight ?? runSpeakerLinkingPreflight,
    emit:
      deps.emit ??
      ((payload) =>
        getEventBus().emitDomainEvent({ type: 'voice-backfill:progress', timestamp: new Date().toISOString(), payload }))
  }
}

interface Processed {
  outcome: VoiceBackfillOutcome
  seconds: number
  device: string | null
  error: string | null
}

/**
 * Run the voice step for one recording and record what happened.
 *
 * Not wrapped in inVoiceSlot: the local workers inside runSpeakerLinkingPreflight already take
 * the voice slot (runWorker, the ONNX export and the DirectML probe), and the slot is not
 * reentrant, so an outer hold would wait on itself forever. A Model Host run needs no slot.
 */
async function processRecording(
  next: NextVoiceRecording,
  shouldContinue: () => boolean,
  d: ResolvedDeps
): Promise<Processed> {
  running = true
  const started = d.clock()
  const elapsed = () => Math.round((d.clock() - started) / 100) / 10
  const at = () => d.now().toISOString()
  let processed: Processed
  try {
    const result = await d.runPreflight(next.recordingId, next.audioPath, shouldContinue, next.durationSeconds)
    if (!result.available) {
      lastError = result.reason ?? 'Voice recognition is not available on this computer.'
      processed = { outcome: 'unavailable', seconds: elapsed(), device: result.device, error: lastError }
    } else if (!result.matches.length) {
      recordAttempt(next.recordingId, 'skipped', null, at())
      lastError = null
      processed = { outcome: 'skipped', seconds: elapsed(), device: result.device, error: null }
    } else {
      tieTranscriptSpeakers(next.recordingId, result)
      applyKnownVoiceBindings(next.recordingId)
      recordAttempt(next.recordingId, 'done', null, at())
      lastError = null
      processed = { outcome: 'done', seconds: elapsed(), device: result.device, error: null }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!shouldContinue() || /cancelled/i.test(message)) {
      // Stopped for a transcription, the window or the Trash: the recording waits for later.
      processed = { outcome: 'cancelled', seconds: elapsed(), device: null, error: null }
    } else if (e instanceof SpeakerLinkingUnavailableError && !/timed out/i.test(message)) {
      // The worker cannot run here (missing module, no access to the model): not this recording's fault.
      lastError = message
      processed = { outcome: 'unavailable', seconds: elapsed(), device: null, error: message }
    } else {
      recordAttempt(next.recordingId, 'failed', message, at())
      lastError = message
      processed = { outcome: 'failed', seconds: elapsed(), device: null, error: message }
    }
  } finally {
    running = false
    lastRunAt = d.now().toISOString()
  }
  console.log(
    `[VoiceBackfill] ${next.recordingId}: ${processed.outcome} in ${processed.seconds} s` +
      (processed.error ? ` (${processed.error.slice(0, 200)})` : '')
  )
  try {
    d.emit({ recordingId: next.recordingId, outcome: processed.outcome, ...countLibrary() })
  } catch (e) {
    console.warn('[VoiceBackfill] could not announce progress:', e)
  }
  if (processed.outcome === 'done') {
    // New voices can teach who someone is (spec 2026-10-03, Phase 2). A failure there is not
    // this recording's: its voices are stored either way.
    try {
      await d.learnVoices()
    } catch (e) {
      console.warn('[VoiceBackfill] voice learning failed:', e instanceof Error ? e.message : e)
    }
  }
  return processed
}

/**
 * One step of the backfill: returns at once, with the reason, when the schedule says no or
 * other heavy work runs; otherwise runs ONE recording and stops it when a transcription
 * starts, the window closes, the schedule changes or the recording leaves the library.
 */
export async function runVoiceBackfillOnce(deps: VoiceBackfillDeps = {}): Promise<VoiceBackfillRun> {
  const d = await resolveDeps(deps)
  const allowedNow = (): VoiceBackfillSkipReason | null => {
    const schedule = currentSchedule()
    if (schedule.schedule === 'off') return 'off'
    if (resolveSpeakerEngine(getConfig().transcription) === 'off') return 'engine-off'
    if (schedule.schedule === 'night' && !isInsideWindow(d.now(), schedule.windowStart, schedule.windowEnd)) {
      return 'outside-window'
    }
    if (d.isTranscribing()) return 'transcription-active'
    return null
  }
  const blocked = allowedNow()
  if (blocked) return { ran: false, reason: blocked }
  if (d.isValueBackfillRunning()) return { ran: false, reason: 'value-backfill' }
  if (d.isBootDrainActive()) return { ran: false, reason: 'boot-drain' }
  if (running) return { ran: false, reason: 'already-running' }

  const next = pickNextRecordingForVoice()
  if (!next) return { ran: false, reason: 'nothing-left' }
  const shouldContinue = () => !stopRequested && allowedNow() === null && isRecordingEligible(next.recordingId)
  const processed = await processRecording(next, shouldContinue, d)
  return { ran: true, recordingId: next.recordingId, outcome: processed.outcome }
}

/**
 * Settings' "Measure one recording": the next recording now, whatever the window says, timed.
 * The answer feeds the estimate for the rest of the library.
 */
export async function measureOneRecording(deps: VoiceBackfillDeps = {}): Promise<VoiceBackfillMeasure> {
  const d = await resolveDeps(deps)
  if (running) throw new Error('A recording is already being measured. Try again when it finishes.')
  const next = pickNextRecordingForVoice()
  if (!next) throw new Error('No recording is waiting for voice evidence.')
  const processed = await processRecording(next, () => !stopRequested && isRecordingEligible(next.recordingId), d)
  if (processed.outcome === 'cancelled') throw new Error('The measurement was stopped before it finished.')
  if (processed.outcome === 'failed' || processed.outcome === 'unavailable') {
    throw new Error(processed.error ?? 'The voice step failed on this recording.')
  }
  lastMeasure = {
    recordingId: next.recordingId,
    seconds: processed.seconds,
    audioSeconds: Math.max(0, next.durationSeconds ?? 0),
    device: processed.device
  }
  return lastMeasure
}

/**
 * Look for the next recording every two minutes, one at a time: the next look is scheduled
 * only after the current one finished, so two never overlap.
 */
export function startVoiceBackfill(
  options: { runOnce?: () => Promise<unknown>; intervalMs?: number } = {}
): void {
  if (schedulerActive) return
  schedulerActive = true
  stopRequested = false
  const runOnce = options.runOnce ?? (() => runVoiceBackfillOnce())
  const intervalMs = options.intervalMs ?? VOICE_BACKFILL_TICK_MS
  const scheduleNext = () => {
    if (!schedulerActive) return
    timer = setTimeout(() => void tick(), intervalMs)
  }
  const tick = async () => {
    timer = null
    try {
      await runOnce()
    } catch (e) {
      console.warn('[VoiceBackfill] step failed:', e instanceof Error ? e.message : e)
    } finally {
      scheduleNext()
    }
  }
  scheduleNext()
}

/** Stop looking, and stop the recording in progress (on quit). */
export function stopVoiceBackfill(): void {
  schedulerActive = false
  stopRequested = true
  if (timer) clearTimeout(timer)
  timer = null
}
