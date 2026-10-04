/**
 * The sampling pass: a few minutes of a doubtful transcript's audio are
 * transcribed again, Jev compares them with the stored text by meaning, and
 * the verdict settles the doubt (transcript-validity.ts reads it).
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md, step 3. Owner,
 * 4-oct-2026: twenty first, then the rest without asking again unless
 * something does not add up. Settings > Quality checks "Samples per day"
 * caps the spend (about 0.01 USD a recording); 0 stops it.
 *
 * One recording at a time, one window at a time, about half a megabyte of
 * audio in memory (only the window is read from disk): the pass never
 * competes with the app.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { GeminiEngine } from '@hidock/transcription'
import { resolveGeminiApiKey } from './brains'
import { getConfig } from './config'
import { queryAll, run } from './database'
import { getCachePath } from './file-storage'
import { bundledFfmpegPath, FRAME_SECONDS, readDeviceWindow } from './audio-profile'
import { createGeminiUsageCollector, recordGeminiUsage, runUsageFields } from './gemini-usage'
import { CURRENT_GEMINI_TRANSCRIPTION_MODEL } from './gemini-model-ids'
import type { JevQuestion } from './jev-client'
import { jevKeyFor } from './jev-settings'
import { createJevHarness } from './pipeline/jev-harness'
import { withCallRecord } from './pipeline/track-call'
import { askDecision, hasDecisionEngine } from './pipeline/decision-engines'
import { qualityRules } from './quality-rules'
import { filterTranscribableRecordingIds, isRecordingEligible } from './recording-eligibility'
import { languageFor } from './transcription-language'
import { audioFrameTest, type TranscriptValidity, type ValiditySegment } from './transcript-validity'
import { readEnvelope, transcriptFingerprint } from './transcript-validity-store'
import { syncTrustVerdicts } from './transcript-trust'
import {
  afterEndVerdict,
  planAfterEndWindows,
  planSampleWindows,
  precheckWindow,
  sampleVerdict,
  type SampleVerdict,
  type SampleWindow,
  type WindowMatch
} from './transcript-sampling'

/** Below this confidence a Jev answer about a window counts as unclear. */
export const COMPARE_MIN_CONFIDENCE = 0.5

export interface WindowTranscript {
  text: string
  model: string
  costUsd: number | null
}

export interface SamplerDeps {
  /** The audio of one window as an MP3 stream, or null when the file cannot be cut. */
  readWindow(filePath: string, start: number, seconds: number): Promise<Buffer | null>
  transcribeWindow(audio: Buffer, recordingId: string, seconds: number): Promise<WindowTranscript>
  compare(pairs: Array<{ stored: string; fresh: string }>, recordingId: string): Promise<WindowMatch[]>
  now(): Date
}

export interface SampleOutcome {
  recordingId: string
  verdict: SampleVerdict
  matches: WindowMatch[]
  costUsd: number | null
}

export interface SamplingPassResult {
  sampled: SampleOutcome[]
  skipped?: 'off' | 'no-engine' | 'daily-limit'
  failed: number
}

interface Candidate {
  recording_id: string
  file_path: string
  speakers: string | null
  validity_json: string | null
  method: string | null
  sampled_fingerprint: string | null
}

/** Doubtful transcripts not yet sampled as they are now, newest first. */
function candidates(limit: number): Candidate[] {
  const rows = queryAll<Candidate>(
    `SELECT t.recording_id, r.file_path, t.speakers, t.validity_json, ap.method,
            s.transcript_fingerprint AS sampled_fingerprint
       FROM transcripts t
       JOIN recordings r ON r.id = t.recording_id
       LEFT JOIN audio_profiles ap ON ap.recording_id = t.recording_id
       LEFT JOIN transcript_samples s ON s.recording_id = t.recording_id
      WHERE t.validity_status = 'doubtful' AND t.integrity_accepted_at IS NULL
        AND r.deleted_at IS NULL AND COALESCE(r.personal, 0) = 0
        AND r.file_path IS NOT NULL AND r.file_path != ''
      ORDER BY r.date_recorded DESC`
  )
  const fresh = rows.filter((row) => row.sampled_fingerprint !== transcriptFingerprint(row.speakers))
  const { eligible } = filterTranscribableRecordingIds(fresh.map((row) => row.recording_id))
  return fresh.filter((row) => eligible.has(row.recording_id) && existsSync(row.file_path)).slice(0, limit)
}

function samplesSince(since: Date): number {
  const row = queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_samples WHERE sampled_at >= ?', [since.toISOString()])
  return row[0]?.n ?? 0
}

function startOfDay(at: Date): Date {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d
}

function parseSegments(json: string | null): ValiditySegment[] {
  try {
    const parsed = json ? JSON.parse(json) : []
    return Array.isArray(parsed) ? (parsed as ValiditySegment[]) : []
  } catch {
    return []
  }
}

function parseValidity(json: string | null): TranscriptValidity | null {
  try {
    return json ? (JSON.parse(json) as TranscriptValidity) : null
  } catch {
    return null
  }
}

export interface SamplePlan {
  /** 'after-end': the transcript stops while the audio goes on, so the windows look for speech after its end. */
  mode: 'compare' | 'after-end'
  windows: SampleWindow[]
}

/** The windows to sample for one recording, from its stored lines, its validity measures and its envelope. */
export function windowsFor(row: Pick<Candidate, 'recording_id' | 'speakers' | 'validity_json' | 'method'>): SamplePlan {
  const validity = parseValidity(row.validity_json)
  const env = readEnvelope(row.recording_id, row.method)
  const fileSeconds = validity?.measures.fileSeconds ?? (env ? env.length * FRAME_SECONDS : 0)
  if (!fileSeconds) return { mode: 'compare', windows: [] }
  const frameHasAudio = env ? audioFrameTest(env, row.method === 'decoded' ? 'db' : 'gain') : null
  const hasAudioAt =
    frameHasAudio && env ? (second: number) => frameHasAudio(Math.min(env.length - 1, Math.floor(second / FRAME_SECONDS))) : undefined
  const codes = new Set((validity?.reasons ?? []).map((r) => r.code))
  if (codes.has('audio_after_the_end') && typeof validity?.measures.endSeconds === 'number') {
    return { mode: 'after-end', windows: planAfterEndWindows({ endSeconds: validity.measures.endSeconds, fileSeconds, hasAudioAt }) }
  }
  return {
    mode: 'compare',
    windows: planSampleWindows({
      segments: parseSegments(row.speakers),
      fileSeconds,
      timeFactor: validity?.measures.timeFactor ?? 1,
      compressedTo: codes.has('clock_compressed') ? fileSeconds : null,
      hasAudioAt
    })
  }
}

/** Transcribe one window, or null when it could not be read or transcribed (the reason is logged). */
async function transcribeOne(row: Candidate, window: SampleWindow, deps: SamplerDeps): Promise<WindowTranscript | null> {
  const seconds = window.end - window.start
  try {
    const audio = await deps.readWindow(row.file_path, window.start, seconds)
    return audio ? await deps.transcribeWindow(audio, row.recording_id, seconds) : null
  } catch (error) {
    console.warn(`[Sampling] ${row.recording_id} at ${window.start} s: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Sample one recording: transcribe its windows, compare, store the verdict,
 * settle its validity. Once any window was transcribed (and billed) the
 * sample is stored, whatever fails after, so the daily allowance counts it and
 * the recording is not transcribed again on the next pass. When no window
 * could be transcribed nothing was spent, and it throws so the next pass
 * tries again.
 */
export async function sampleRecording(row: Candidate, deps: SamplerDeps): Promise<SampleOutcome | null> {
  const plan = windowsFor(row)
  if (plan.windows.length === 0) return null
  const fresh: Array<{ window: SampleWindow; transcript: WindowTranscript | null }> = []
  for (const window of plan.windows) {
    let transcript = await transcribeOne(row, window, deps)
    // An empty answer under stored text would count against the transcript:
    // ask once more before believing it (a flaky empty candidate is not silence).
    if (plan.mode === 'compare' && transcript && precheckWindow(transcript.text, window.storedText) === 'no_speech') {
      const again = await transcribeOne(row, window, deps)
      if (again) transcript = { ...again, costUsd: sumCosts([transcript.costUsd, again.costUsd]) }
    }
    fresh.push({ window, transcript })
  }
  if (fresh.every((f) => f.transcript === null)) throw new Error('no window could be transcribed')

  let matches: WindowMatch[]
  let verdict: SampleVerdict
  let error: string | null = null
  if (plan.mode === 'after-end') {
    verdict = afterEndVerdict(fresh.map((f) => f.transcript?.text ?? null))
    matches = fresh.map((f) => (f.transcript ? (wordCount(f.transcript.text) > 0 ? 'different' : 'no_speech') : 'unclear'))
  } else {
    matches = fresh.map(({ window, transcript }) => (transcript ? (precheckWindow(transcript.text, window.storedText) ?? 'unclear') : 'unclear'))
    const toCompare = fresh
      .map((f, i) => ({ i, stored: f.window.storedText, fresh: f.transcript?.text ?? '' }))
      .filter(({ i }) => fresh[i].transcript && precheckWindow(fresh[i].transcript!.text, fresh[i].window.storedText) === null)
    if (toCompare.length > 0) {
      try {
        const answers = await deps.compare(toCompare.map(({ stored, fresh: text }) => ({ stored, fresh: text })), row.recording_id)
        toCompare.forEach(({ i }, k) => {
          matches[i] = answers[k] ?? 'unclear'
        })
      } catch (e) {
        // Already paid for the transcription: keep the sample, inconclusive on these windows.
        error = e instanceof Error ? e.message : String(e)
        console.warn(`[Sampling] ${row.recording_id}: comparison failed, stored as inconclusive: ${error}`)
      }
    }
    verdict = sampleVerdict(matches)
  }
  const costs = fresh.map((f) => f.transcript?.costUsd).filter((c): c is number => typeof c === 'number')
  const costUsd = costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null
  const model = fresh.find((f) => f.transcript)?.transcript?.model ?? null
  run(
    `INSERT INTO transcript_samples (recording_id, transcript_fingerprint, verdict, windows_json, model, cost_usd, sampled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET transcript_fingerprint = excluded.transcript_fingerprint,
       verdict = excluded.verdict, windows_json = excluded.windows_json, model = excluded.model,
       cost_usd = excluded.cost_usd, sampled_at = excluded.sampled_at`,
    [
      row.recording_id,
      transcriptFingerprint(row.speakers),
      verdict,
      JSON.stringify({
        mode: plan.mode,
        windows: fresh.map((f, i) => ({ start: f.window.start, end: f.window.end, match: matches[i], words: wordCount(f.transcript?.text) })),
        ...(error ? { error } : {})
      }),
      model,
      costUsd,
      deps.now().toISOString()
    ]
  )
  // Refreshes the validity with the sample, takes ratings back or gives them back, recomputes stars.
  syncTrustVerdicts(row.recording_id)
  return { recordingId: row.recording_id, verdict, matches, costUsd }
}

function wordCount(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

function sumCosts(costs: Array<number | null>): number | null {
  const known = costs.filter((c): c is number => typeof c === 'number')
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

/** Window audio left behind by a crash between writing and removing it: meeting audio, never kept. */
function sweepLeftoverSamples(now: Date): void {
  const dir = join(getCachePath(), 'samples')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (now.getTime() - statSync(path).mtimeMs > 3_600_000) unlinkSync(path)
    } catch {
      // Gone already, or in use by a pass that is still running.
    }
  }
}

let running = false

/**
 * Sample doubtful transcripts up to today's remaining allowance. Idempotent:
 * a transcript is sampled once as it is; a new or edited one is sampled again.
 * A recording whose sample fails is left for the next pass.
 */
export async function runSamplingPass(deps: SamplerDeps = defaultSamplerDeps()): Promise<SamplingPassResult> {
  const perDay = qualityRules().samplesPerDay
  if (perDay <= 0) return { sampled: [], skipped: 'off', failed: 0 }
  if (!(await hasDecisionEngine('sample-compare')) || !resolveGeminiApiKey()) return { sampled: [], skipped: 'no-engine', failed: 0 }
  if (running) return { sampled: [], failed: 0 }
  running = true
  try {
    sweepLeftoverSamples(deps.now())
    const remaining = perDay - samplesSince(startOfDay(deps.now()))
    if (remaining <= 0) return { sampled: [], skipped: 'daily-limit', failed: 0 }
    const sampled: SampleOutcome[] = []
    let failed = 0
    for (const row of candidates(remaining)) {
      try {
        const outcome = await sampleRecording(row, deps)
        if (outcome) sampled.push(outcome)
      } catch (error) {
        failed++
        console.warn(`[Sampling] ${row.recording_id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (sampled.length > 0 || failed > 0) {
      const count = (v: SampleVerdict) => sampled.filter((s) => s.verdict === v).length
      const cost = sampled.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      console.log(
        `[Sampling] ${sampled.length} sampled (${count('confirmed')} confirmed, ${count('contradicted')} contradicted, ` +
          `${count('incomplete')} incomplete, ${count('inconclusive')} inconclusive), ${failed} failed, ${cost.toFixed(4)} USD`
      )
    }
    return { sampled, failed }
  } finally {
    running = false
  }
}

/**
 * One window of any audio file: the device's frames read straight from disk
 * (only the window's bytes), anything else cut by the bundled ffmpeg, which
 * streams the file itself.
 */
export async function readWindowAudio(filePath: string, start: number, seconds: number): Promise<Buffer | null> {
  return readDeviceWindow(filePath, start, seconds) ?? readWithFfmpeg(filePath, start, seconds)
}

function readWithFfmpeg(filePath: string, start: number, seconds: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      bundledFfmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds), '-i', filePath,
        '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null))
  })
}

/** Transcribe one window with the configured Gemini transcription model; usage is billed to the window. */
async function transcribeWindowWithGemini(audio: Buffer, recordingId: string, seconds: number): Promise<WindowTranscript> {
  const config = getConfig()
  const model = config.transcription.geminiModel || CURRENT_GEMINI_TRANSCRIPTION_MODEL
  const dir = join(getCachePath(), 'samples')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${recordingId}-${Date.now()}.mp3`)
  writeFileSync(path, audio)
  const usage = createGeminiUsageCollector()
  try {
    const text = await withCallRecord({ step: 'sample-transcribe', route: 'direct:gemini-sdk', recordingId }, () =>
      usage.run(async () => {
        const engine = new GeminiEngine({
          apiKey: resolveGeminiApiKey(),
          model,
          language: languageFor('gemini', config.transcription.language)
        })
        const parts: string[] = []
        for await (const segment of engine.transcribe(audio, {
          source: 'mic',
          language: config.transcription.language,
          durationSeconds: seconds,
          filePath: path,
          onUsage: (event: { model?: string; usage: unknown }) => recordGeminiUsage(event.model, event.usage)
        } as Parameters<typeof engine.transcribe>[1] & { filePath: string })) {
          if (segment.text?.trim()) parts.push(segment.text.trim())
        }
        return parts.join('\n')
      })
    )
    return { text, model, costUsd: runUsageFields(usage.total()).estimatedCostAmount ?? null }
  } catch (error) {
    // No speech in the window is an answer, not a failure.
    if (error instanceof Error && error.name === 'NoSpeechDetectedError') {
      return { text: '', model, costUsd: runUsageFields(usage.total()).estimatedCostAmount ?? null }
    }
    throw error
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // A leftover sample file is removed with the cache.
    }
  }
}

export function compareQuestion(i: number): JevQuestion {
  return {
    type: 'choice',
    instructions:
      `Compare \`windows[${i}].new_transcript\` (one minute of a recording, transcribed again) with ` +
      `\`windows[${i}].stored_excerpt\` (the stored transcript around the same minutes, which may cover more time ` +
      'and be worded differently). Judge by meaning: topic, people, what is said.',
    criteria: {
      same: 'The new minute is part of the same conversation as the stored excerpt.',
      different: 'The new minute is a different conversation, or the stored excerpt does not contain what was said.'
    }
  }
}

/** The decision engine's verdict for each pair, in one call. */
export async function compareWithDecisions(pairs: Array<{ stored: string; fresh: string }>, recordingId: string): Promise<WindowMatch[]> {
  const harness = createJevHarness({ getKey: () => jevKeyFor('value') })
  const questions: Record<string, JevQuestion> = {}
  pairs.forEach((_, i) => (questions[`w${i}`] = compareQuestion(i)))
  const state = { windows: pairs.map((p) => ({ new_transcript: p.fresh, stored_excerpt: p.stored })) }
  const { response: res } = await askDecision('sample-compare', state, questions, { jev: harness, recordingId, shouldGenerate: () => isRecordingEligible(recordingId) })
  return pairs.map((_, i) => {
    const a = res.answers[`w${i}`]
    if (a?.type !== 'choice' || (a.confidence ?? 0) < COMPARE_MIN_CONFIDENCE) return 'unclear'
    return a.choice === 'same' ? 'same' : a.choice === 'different' ? 'different' : 'unclear'
  })
}

export function defaultSamplerDeps(): SamplerDeps {
  return {
    readWindow: readWindowAudio,
    transcribeWindow: transcribeWindowWithGemini,
    compare: compareWithDecisions,
    now: () => new Date()
  }
}
