/**
 * Puts the existing lines of a transcript range back on the audio.
 *
 * This is an acoustic forced alignment: the words are not recognised. It reads
 * where speech is (the VAD activity stretches, or the frame envelope when a
 * recording has no VAD run) between the two trusted lines around the range,
 * and lays the range's lines over that speech in their order, each taking a
 * share of the speech time in proportion to its words, then moves each start
 * to the nearest onset of speech. Pure arithmetic in the main process: no
 * model, no GPU, no thread pool.
 *
 * It refuses, instead of guessing, when the window holds no speech, when the
 * words cannot fit in it, or when the window holds far more speech than these
 * words (other, untranscribed speech is there, so any placement is a guess).
 * The caller then offers to transcribe the section again.
 *
 * Measured on the owner's library (25-nov-2026, coord\tmp\timing): see the
 * PR for the accuracy against lines whose times were known to be right.
 */

export interface SpeechSpan {
  start: number
  end: number
}

export interface AlignmentResult {
  ok: boolean
  /** 0..1: how well the words fit the speech in the window. */
  confidence: number
  /** One per input line, seconds, in order and inside the window. */
  starts: number[]
  ends: number[]
  speechSeconds: number
  wordsPerSpeechSecond: number | null
  /** One sentence for the owner when ok is false. */
  reason: string
}

/** Sound shorter than this, alone, is a click, not a word. */
export const ALIGN_MIN_SPAN_SECONDS = 0.3
/** Two stretches this close are one breath of speech. */
export const ALIGN_MERGE_GAP_SECONDS = 0.25
/** A start this close to an onset of speech, in seconds of speech, moves onto it. */
export const ALIGN_SNAP_SECONDS = 2
/** Words per second of speech that a conversation holds; outside it the fit fades. */
export const ALIGN_FULL_RATE_LOW = 1.2
export const ALIGN_FULL_RATE_HIGH = 6
export const ALIGN_ZERO_RATE_LOW = 0.4
/** The pace no one speaks at (CRAMPED_WORDS_PER_SECOND is 8 for one line; a range may hold a fast burst). */
export const ALIGN_ZERO_RATE_HIGH = 9
/** Below this, the result is not applied and the section is offered for a new transcription. */
export const ALIGN_MIN_CONFIDENCE = 0.6

const WORD = /[\p{L}\p{N}]+/gu

function wordsIn(text: string): number {
  return Math.max(1, text.match(WORD)?.length ?? 0)
}

/** Speech stretches from a per-frame sound test, frames [fromFrame, toFrame). */
export function speechSpansFromFrames(
  isSound: (frame: number) => boolean, fromFrame: number, toFrame: number, frameSeconds: number
): SpeechSpan[] {
  const spans: SpeechSpan[] = []
  let open: number | null = null
  for (let f = fromFrame; f < toFrame; f++) {
    if (isSound(f)) {
      if (open === null) open = f
    } else if (open !== null) {
      spans.push({ start: open * frameSeconds, end: f * frameSeconds })
      open = null
    }
  }
  if (open !== null) spans.push({ start: open * frameSeconds, end: toFrame * frameSeconds })
  return spans
}

/** Clip to the window, join stretches split by a breath, drop clicks. */
export function cleanSpans(spans: SpeechSpan[], window: SpeechSpan): SpeechSpan[] {
  const clipped = spans
    .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const merged: SpeechSpan[] = []
  for (const span of clipped) {
    const last = merged[merged.length - 1]
    if (last && span.start - last.end <= ALIGN_MERGE_GAP_SECONDS) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged.filter((s) => s.end - s.start >= ALIGN_MIN_SPAN_SECONDS)
}

function rateScore(rate: number): number {
  if (rate >= ALIGN_FULL_RATE_LOW && rate <= ALIGN_FULL_RATE_HIGH) return 1
  if (rate < ALIGN_FULL_RATE_LOW) return Math.max(0, (rate - ALIGN_ZERO_RATE_LOW) / (ALIGN_FULL_RATE_LOW - ALIGN_ZERO_RATE_LOW))
  return Math.max(0, (ALIGN_ZERO_RATE_HIGH - rate) / (ALIGN_ZERO_RATE_HIGH - ALIGN_FULL_RATE_HIGH))
}

export function alignToSpeech(lines: Array<{ text: string }>, window: SpeechSpan, rawSpans: SpeechSpan[]): AlignmentResult {
  const spans = cleanSpans(rawSpans, window)
  const speechSeconds = spans.reduce((sum, s) => sum + s.end - s.start, 0)
  const failed = (reason: string, confidence = 0, rate: number | null = null): AlignmentResult =>
    ({ ok: false, confidence, starts: [], ends: [], speechSeconds, wordsPerSpeechSecond: rate, reason })
  if (!lines.length) return failed('There are no lines to place.')
  if (speechSeconds <= 0) return failed('There is no speech between the lines around this section.')
  const counts = lines.map((line) => wordsIn(line.text))
  const total = counts.reduce((sum, n) => sum + n, 0)
  const rate = total / speechSeconds
  if (rate > ALIGN_ZERO_RATE_HIGH) {
    return failed(`These lines have more words (${total}) than ${speechSeconds.toFixed(1)} s of speech can hold.`, 0, rate)
  }

  // Speech time (seconds of speech from the window start) to clock time.
  const clockAt = (offset: number): number => {
    let left = offset
    for (const span of spans) {
      const length = span.end - span.start
      if (left <= length) return span.start + left
      left -= length
    }
    return spans[spans.length - 1].end
  }
  // Onsets and estimates are compared in seconds of speech, so the silence
  // before an onset costs nothing: a line that is due at the end of a stretch
  // starts after the pause, where the next one begins.
  const onsets: Array<{ clock: number; offset: number }> = []
  let speechBefore = 0
  for (const span of spans) {
    onsets.push({ clock: span.start, offset: speechBefore })
    speechBefore += span.end - span.start
  }
  const starts: number[] = []
  let snapped = 0
  let before = 0
  for (let i = 0; i < lines.length; i++) {
    const offset = (speechSeconds * before) / total
    before += counts[i]
    const floor = i > 0 ? starts[i - 1] : window.start
    let best: { clock: number; offset: number } | null = null
    for (const onset of onsets) {
      if (onset.clock < floor || Math.abs(onset.offset - offset) > ALIGN_SNAP_SECONDS) continue
      if (best === null || Math.abs(onset.offset - offset) < Math.abs(best.offset - offset)) best = onset
    }
    if (best !== null) snapped++
    starts.push(Math.max(floor, best?.clock ?? clockAt(offset)))
  }
  const ends = starts.map((start, i) => {
    const own = clockAt((speechSeconds * counts.slice(0, i + 1).reduce((sum, n) => sum + n, 0)) / total)
    const next = i + 1 < starts.length ? starts[i + 1] : window.end
    return Math.max(start, Math.min(own, next))
  })
  const confidence = rateScore(rate) * (0.6 + 0.4 * (snapped / lines.length))
  const ok = confidence >= ALIGN_MIN_CONFIDENCE
  return {
    ok, confidence, starts, ends, speechSeconds, wordsPerSpeechSecond: rate,
    reason: ok ? '' : rate < ALIGN_FULL_RATE_LOW
      ? `There is far more speech here (${speechSeconds.toFixed(0)} s) than these ${total} words, so where they go cannot be told from the sound.`
      : 'The words and the speech in this stretch do not match well enough to place the lines.'
  }
}
