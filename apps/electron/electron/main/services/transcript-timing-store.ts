import { spawn } from 'child_process'
import { existsSync } from 'fs'
import bundledFfmpeg from 'ffmpeg-static'
import { FRAME_SECONDS, readDeviceWindow, scanDeviceMp3 } from './audio-profile'
import { audioFrameTest } from './transcript-validity'
import { readEnvelope, readSpeechEvidence, transcriptFingerprint } from './transcript-validity-store'
import { queryOne } from './database'
import {
  assessTimingEvidence, fixedRanges, NO_EVIDENCE, sectionRuns, type SpeechEvidence
} from './transcript-timing-evidence'
import { speechSpansFromFrames, type SpeechSpan } from './transcript-time-aligner'
import type { TimingAssessment, TimingFinding, TimingSegment } from '../../../src/shared/transcript-timing'

interface TimingRow {
  id: string
  speakers: string | null
  file_path: string | null
  method: string | null
  duration_seconds: number | null
}

/** Sound this long inside a stretch counts as possible speech there. */
const MIN_SOUND_SECONDS = 0.15
/** Decoded windows for a recording without an envelope: at most this many per request. */
const MAX_DECODED_WINDOWS = 12
const DECODED_WINDOW_SECONDS = 30

/** Decode only a bounded window, through pipes: no audio or cache files are written. */
async function decodeWindow(path: string, start: number, seconds: number): Promise<{ env: Uint8Array; unit: 'gain' | 'db' }> {
  const mp3 = readDeviceWindow(path, start, seconds)
  const gains = mp3 ? scanDeviceMp3(mp3) : null
  const args = mp3 ? ['-f', 'mp3', '-i', 'pipe:0'] : ['-ss', String(start), '-i', path]
  return new Promise((resolve, reject) => {
    if (!bundledFfmpeg) { reject(new Error('Bundled decoder unavailable')); return }
    const child = spawn(bundledFfmpeg.replace('app.asar', 'app.asar.unpacked'),
      ['-v', 'error', ...args, '-t', String(seconds), '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('Audio window timed out')) }, 10000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 16000 * (seconds + 1)) child.kill(); else chunks.push(chunk) })
    // The decoder's own errors go to the log, where a failed window can be explained.
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`Audio window could not be decoded (exit ${code})`)); return }
      const data = Buffer.concat(chunks)
      const levels: number[] = []
      for (let offset = 0; offset < data.length; offset += 576 * 4) {
        let peak = 0
        for (let i = offset; i + 4 <= Math.min(data.length, offset + 576 * 4); i += 4) peak = Math.max(peak, Math.abs(data.readFloatLE(i)))
        levels.push(Math.round(Math.max(0, Math.min(100, 20 * Math.log10(Math.max(peak, 1e-5)) + 100))))
      }
      // Device gains preserve the established speech floor. Decoded peak levels
      // can make its quiet encoder noise look like speech near zero seconds.
      resolve(gains ? { env: gains, unit: 'gain' } : { env: Uint8Array.from(levels), unit: 'db' })
    })
    child.stdin.on('error', err => console.warn('[TranscriptTiming] Decoder input closed early:', err.message))
    child.stdin.end(mp3 ?? undefined)
  })
}

function clip(spans: SpeechSpan[], start: number, end: number): SpeechSpan[] {
  return spans.map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) })).filter((s) => s.end > s.start)
}

function seconds(spans: SpeechSpan[]): number {
  return spans.reduce((sum, s) => sum + s.end - s.start, 0)
}

/** The VAD's activity stretches (the evidence #173 judges completeness with). */
export function evidenceFromActivity(activity: SpeechSpan[]): SpeechEvidence {
  const sorted = [...activity].sort((a, b) => a.start - b.start)
  return {
    hasAudio: (start, end) => seconds(clip(sorted, start, end)) >= MIN_SOUND_SECONDS,
    spansIn: (start, end) => clip(sorted, start, end)
  }
}

/** The stored frame envelope: one level per MP3 frame, judged with the validity check's floor. */
export function evidenceFromEnvelope(env: Uint8Array, unit: 'gain' | 'db'): SpeechEvidence {
  const test = audioFrameTest(env, unit)
  const frames = (start: number, end: number) =>
    [Math.max(0, Math.floor(start / FRAME_SECONDS)), Math.min(env.length, Math.ceil(end / FRAME_SECONDS))] as const
  return {
    hasAudio: (start, end) => {
      if (end <= 0 || start >= env.length * FRAME_SECONDS) return false
      const [from, to] = frames(start, end)
      if (to <= from) return null
      let sound = 0
      for (let f = from; f < to; f++) if (test(f)) sound++
      return sound * FRAME_SECONDS >= MIN_SOUND_SECONDS
    },
    spansIn: (start, end) => {
      const [from, to] = frames(start, end)
      return to > from ? clip(speechSpansFromFrames(test, from, to, FRAME_SECONDS), start, end) : []
    }
  }
}

/** Bounded decoded windows for a recording that has neither VAD stretches nor an envelope. */
async function evidenceFromDecodedWindows(path: string, segments: TimingSegment[], durationSeconds: number | null): Promise<SpeechEvidence> {
  const pending = assessTimingEvidence(segments, NO_EVIDENCE, durationSeconds)
  const starts = [...new Set(pending.flatMap((f) => [f.claimedStart, f.windowStart].filter((s): s is number => s !== null)))]
    .slice(0, MAX_DECODED_WINDOWS).map((start) => Math.max(0, start - 3))
  const windows: Array<{ start: number; evidence: SpeechEvidence; seconds: number }> = []
  for (const start of starts) {
    try {
      const { env, unit } = await decodeWindow(path, start, DECODED_WINDOW_SECONDS)
      windows.push({ start, seconds: env.length * FRAME_SECONDS, evidence: evidenceFromEnvelope(env, unit) })
    } catch (err) {
      // That window stays unknown: missing evidence never turns into invented silence.
      console.warn(`[TranscriptTiming] Audio window at ${start}s unavailable:`, err instanceof Error ? err.message : err)
    }
  }
  const covering = (start: number, end: number) =>
    windows.find((w) => Math.max(0, start) >= w.start && end <= w.start + w.seconds)
  return {
    hasAudio: (start, end) => {
      const w = covering(start, end)
      return w ? w.evidence.hasAudio(start - w.start, end - w.start) : null
    },
    spansIn: (start, end) => {
      const w = covering(start, end)
      return w ? w.evidence.spansIn(start - w.start, end - w.start)?.map((s) => ({ start: s.start + w.start, end: s.end + w.start })) ?? null : null
    }
  }
}

export interface TimingState {
  transcriptId: string
  speakers: string | null
  segments: TimingSegment[]
  durationSeconds: number | null
  /** The recording's audio, for Fix times on the model host. */
  filePath: string | null
  /** The same evidence the findings were judged on, so a fix uses it too. */
  evidence: SpeechEvidence
  assessment: TimingAssessment
}

function parseSegments(speakers: string | null): TimingSegment[] {
  const parsed: unknown = JSON.parse(speakers ?? '[]')
  if (!Array.isArray(parsed)) throw new Error('Transcript segments unavailable')
  return parsed as TimingSegment[]
}

/** The transcript's lines, findings and the evidence they were judged on. */
export async function loadTimingState(recordingId: string): Promise<TimingState> {
  const row = queryOne<TimingRow>(`SELECT t.id, t.speakers, r.file_path, ap.method, r.duration_seconds FROM transcripts t
    JOIN recordings r ON r.id = t.recording_id LEFT JOIN audio_profiles ap ON ap.recording_id = r.id
    WHERE t.recording_id = ? AND r.deleted_at IS NULL`, [recordingId])
  if (!row) throw new Error('Transcript not found')
  const segments = parseSegments(row.speakers)
  const duration = typeof row.duration_seconds === 'number' && row.duration_seconds > 0 ? row.duration_seconds : null
  let evidence: SpeechEvidence = NO_EVIDENCE
  let source: TimingAssessment['evidence'] = null
  const activity = readSpeechEvidence(recordingId).activityIntervals
  const env = readEnvelope(recordingId, row.method)
  if (activity?.length) {
    evidence = evidenceFromActivity(activity)
    source = 'vad'
  } else if (env?.length) {
    evidence = evidenceFromEnvelope(env, row.method === 'decoded' ? 'db' : 'gain')
    source = 'envelope'
  } else if (row.file_path && existsSync(row.file_path)) {
    evidence = await evidenceFromDecodedWindows(row.file_path, segments, duration)
    source = 'decoded'
  }
  const findings: TimingFinding[] = assessTimingEvidence(segments, evidence, duration)
  return {
    transcriptId: row.id,
    speakers: row.speakers,
    segments,
    durationSeconds: duration,
    filePath: row.file_path,
    evidence,
    assessment: {
      fingerprint: transcriptFingerprint(row.speakers),
      findings,
      hiddenIndices: segments.flatMap((s, i) => s.timingHidden && !s.sectionReplacedBy ? [i] : []),
      fixedRanges: fixedRanges(segments),
      sectionRuns: sectionRuns(segments),
      reviewed: segments.some((s) => s.timingReviewed === true),
      evidence: source
    }
  }
}

/** Whether Fix times can use the model host now; any doubt is no. */
async function hostCanAlign(): Promise<boolean> {
  try {
    const { getConfig } = await import('./config')
    const config = getConfig().transcription
    if (!config.modelHostUrl?.trim() || !config.modelHostToken) return false
    const { checkModelHost, modelHostCanAlign } = await import('./model-host-client')
    return modelHostCanAlign(await checkModelHost({ url: config.modelHostUrl, token: config.modelHostToken }))
  } catch (err) {
    console.warn('[TranscriptTiming] Could not ask the model host whether it can place words:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function getTranscriptTiming(recordingId: string): Promise<TimingAssessment> {
  const [state, wordAlignment] = await Promise.all([loadTimingState(recordingId), hostCanAlign()])
  return { ...state.assessment, wordAlignment }
}
