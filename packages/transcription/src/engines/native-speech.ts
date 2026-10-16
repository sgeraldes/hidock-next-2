/**
 * Speech-aware helpers for the native Gemini transcription path.
 *
 * 13/14-oct-2026: with the two channels of a recording transcribed apart, one
 * side of a call can be quiet for minutes. Gemini then returned a short,
 * correct answer for a 426 s chunk and the coverage check called it
 * incomplete ("covers 2% of the 426s recording", Rec12 channel 0 had 0 s of
 * speech in that chunk). And because words were joined into one line per
 * speaker, a channel with one speaker came back as one line per chunk, which
 * the validity check could not place in time (Rec14: 29 lines for 82 minutes).
 *
 * What lives here: plan the requests from the channel's voice activity, so
 * silence is never sent; judge coverage against where the voice ends; and cut
 * lines at pauses so each keeps the time of its words.
 *
 * Plan: docs/superpowers/plans/2026-10-16-transcription-retry-and-fallback.md
 */

export interface SpeechInterval {
  /** Seconds from the start of the audio being transcribed. */
  start: number
  end: number
}

export interface SpeechSpan {
  start: number
  end: number
}

export interface SpeechPlanOptions {
  /** Added before and after each voice run so a word is not cut at its edge. */
  paddingSeconds?: number
  /**
   * A silence at least this long is not sent: the span closes before it and
   * the next one opens after it. Shorter silences travel inside the span, so
   * a conversation is a few requests and not one per sentence.
   */
  skipSilenceSeconds?: number
  /** Longest span sent in one request. */
  maxSpanSeconds?: number
}

export const SPEECH_PLAN_DEFAULTS: Required<SpeechPlanOptions> = {
  paddingSeconds: 0.5,
  skipSilenceSeconds: 30,
  maxSpanSeconds: 20 * 60,
}

/** Clean, sorted, non-overlapping intervals clipped to [0, durationSeconds]. */
export function normalizeIntervals(intervals: ReadonlyArray<SpeechInterval>, durationSeconds: number): SpeechInterval[] {
  const clean = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(durationSeconds, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const out: SpeechInterval[] = []
  for (const i of clean) {
    const last = out.at(-1)
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

/**
 * Contiguous spans of the recording that hold all its voice and none of its
 * long silences. Each span starts and ends on voice (plus padding), so the
 * times a provider returns for a span add to `span.start` and land back on the
 * recording's own timeline. An empty result means: nothing to send.
 */
export function planSpeechSpans(
  intervals: ReadonlyArray<SpeechInterval>,
  durationSeconds: number,
  options: SpeechPlanOptions = {}
): SpeechSpan[] {
  const { paddingSeconds, skipSilenceSeconds, maxSpanSeconds } = { ...SPEECH_PLAN_DEFAULTS, ...options }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return []
  const voice = normalizeIntervals(intervals, durationSeconds)
  if (!voice.length) return []

  // Padded voice runs; overlapping padding joins them.
  const runs: SpeechSpan[] = []
  for (const v of voice) {
    const start = Math.max(0, v.start - paddingSeconds)
    const end = Math.min(durationSeconds, v.end + paddingSeconds)
    const last = runs.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else runs.push({ start, end })
  }

  // Pack consecutive runs into one span while the silence between them is
  // short and the span stays under the cap. A long silence or the cap closes it.
  const spans: SpeechSpan[] = []
  for (const run of runs) {
    const current = spans.at(-1)
    if (current && run.start - current.end < skipSilenceSeconds && run.end - current.start <= maxSpanSeconds) {
      current.end = run.end
      continue
    }
    // A single run longer than the cap is cut into equal pieces under it.
    const length = run.end - run.start
    const pieces = Math.max(1, Math.ceil(length / maxSpanSeconds))
    const step = length / pieces
    for (let p = 0; p < pieces; p++) {
      spans.push({ start: run.start + p * step, end: p === pieces - 1 ? run.end : run.start + (p + 1) * step })
    }
  }
  return spans.map((s) => ({ start: round3(s.start), end: round3(s.end) }))
}

/** Seconds of voice inside [start, end) of the audio. */
export function speechSecondsIn(intervals: ReadonlyArray<SpeechInterval>, start: number, end: number): number {
  let total = 0
  for (const i of intervals) total += Math.max(0, Math.min(i.end, end) - Math.max(i.start, start))
  return total
}

/** End of the last voice inside [start, end), or null when there is none. */
export function lastSpeechEndIn(intervals: ReadonlyArray<SpeechInterval>, start: number, end: number): number | null {
  let last: number | null = null
  for (const i of intervals) {
    if (i.end <= start || i.start >= end) continue
    const e = Math.min(i.end, end)
    if (last === null || e > last) last = e
  }
  return last
}

/** Below this much voice an interval cannot be "incomplete": there is almost nothing to transcribe. */
export const MIN_SPEECH_FOR_COVERAGE_SECONDS = 5

/**
 * Coverage of one request judged against the voice in it. Returns the reason
 * the answer looks cut short, or null when it covers what was said.
 *
 * `lastTextEnd` and the intervals are on the recording's timeline;
 * [start, end) is the interval that was sent. The answer is short when the
 * text stops more than `toleranceSeconds` before the voice does and leaves at
 * least `minMissingSeconds` of voice behind it.
 */
export function speechCoverageShortfall(
  lastTextEnd: number | null,
  intervals: ReadonlyArray<SpeechInterval>,
  start: number,
  end: number,
  options: { toleranceSeconds?: number; minMissingSeconds?: number } = {}
): string | null {
  const toleranceSeconds = options.toleranceSeconds ?? 20
  const minMissingSeconds = options.minMissingSeconds ?? 15
  const voiced = speechSecondsIn(intervals, start, end)
  if (voiced < MIN_SPEECH_FOR_COVERAGE_SECONDS) return null
  const voiceEnd = lastSpeechEndIn(intervals, start, end)
  if (voiceEnd === null) return null
  const textEnd = lastTextEnd ?? start
  if (textEnd >= voiceEnd - toleranceSeconds) return null
  const missing = speechSecondsIn(intervals, textEnd, voiceEnd)
  if (missing < minMissingSeconds) return null
  const covered = speechSecondsIn(intervals, start, Math.min(textEnd, end))
  return `text ends at ${formatSeconds(textEnd)} but voice continues to ${formatSeconds(voiceEnd)} ` +
    `(${Math.round(missing)} s of voice untranscribed, ${Math.round((covered / voiced) * 100)}% of the voice covered)`
}

export interface TimedWord {
  text: string
  speaker: string
  startTime: number
  endTime: number
}

export interface LineBreakOptions {
  /** A silence this long between two words starts a new line. */
  pauseSeconds?: number
  /** A line never spans more than this. */
  maxLineSeconds?: number
}

/**
 * Group timed words into lines: a new line on a speaker change, on a pause of
 * `pauseSeconds` or more, or when the line would pass `maxLineSeconds`. The
 * join function decides spacing around punctuation.
 */
export function groupWordsIntoLines<T extends TimedWord>(
  words: ReadonlyArray<T>,
  join: (text: string, word: string) => string,
  options: LineBreakOptions = {}
): Array<{ speaker: string; text: string; startTime: number; endTime: number }> {
  const pauseSeconds = options.pauseSeconds ?? 0.8
  const maxLineSeconds = options.maxLineSeconds ?? 30
  const lines: Array<{ speaker: string; text: string; startTime: number; endTime: number }> = []
  for (const word of words) {
    const current = lines.at(-1)
    const startsNew = !current ||
      current.speaker !== word.speaker ||
      word.startTime - current.endTime >= pauseSeconds ||
      Math.max(word.endTime, current.endTime) - current.startTime > maxLineSeconds
    if (startsNew) {
      lines.push({ speaker: word.speaker, text: word.text.trim(), startTime: word.startTime, endTime: Math.max(word.startTime, word.endTime) })
    } else {
      current.text = join(current.text, word.text)
      current.endTime = Math.max(current.endTime, word.endTime)
    }
  }
  return lines
}

/**
 * A standalone PCM WAV holding [startSeconds, endSeconds) of `audio`, cut on
 * sample-frame boundaries. Null when `audio` is not a plain PCM WAV, so the
 * caller keeps its previous path (MP3, or a container the splitters cannot cut).
 */
export function sliceWavSpan(audio: Buffer, startSeconds: number, endSeconds: number): Buffer | null {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let fmt: { format: number; channels: number; rate: number; byteRate: number; blockAlign: number; bits: number } | null = null
  let dataStart = -1
  let dataLength = 0
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 24 <= audio.length) {
      fmt = {
        format: audio.readUInt16LE(offset + 8), channels: audio.readUInt16LE(offset + 10),
        rate: audio.readUInt32LE(offset + 12), byteRate: audio.readUInt32LE(offset + 16),
        blockAlign: audio.readUInt16LE(offset + 20), bits: audio.readUInt16LE(offset + 22),
      }
    }
    if (id === 'data') { dataStart = offset + 8; dataLength = Math.min(size, audio.length - dataStart); break }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || fmt.format !== 1 || dataStart < 0 || fmt.blockAlign <= 0 || fmt.byteRate <= 0) return null
  const frames = Math.floor(dataLength / fmt.blockAlign)
  const first = Math.max(0, Math.min(frames, Math.floor(startSeconds * fmt.rate)))
  const last = Math.max(first, Math.min(frames, Math.ceil(endSeconds * fmt.rate)))
  if (last <= first) return null
  const body = audio.subarray(dataStart + first * fmt.blockAlign, dataStart + last * fmt.blockAlign)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + body.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(fmt.channels, 22); header.writeUInt32LE(fmt.rate, 24); header.writeUInt32LE(fmt.byteRate, 28)
  header.writeUInt16LE(fmt.blockAlign, 32); header.writeUInt16LE(fmt.bits, 34)
  header.write('data', 36); header.writeUInt32LE(body.length, 40)
  return Buffer.concat([header, body])
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function formatSeconds(value: number): string {
  const s = Math.max(0, Math.round(value))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(r).padStart(2, '0')}`
}
