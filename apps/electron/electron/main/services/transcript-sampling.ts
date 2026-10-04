/**
 * Sampling of a transcript in doubt: which minutes of the audio to transcribe
 * again, what the stored text says for those minutes, and the verdict the
 * comparison gives. Pure: no database, no network, no files.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md, step 3. Owner,
 * 4-oct-2026: "send only a portion of the audio to be transcribed, and compare
 * the two transcriptions by meaning".
 */

import type { ValiditySegment } from './transcript-validity'

/** Seconds in one window sent to the transcriber. */
export const SAMPLE_WINDOW_SECONDS = 60
/** Windows per recording. Three cost about 0.01 USD at gemini-3.5-transcribe's 0.0034 USD per minute. */
export const SAMPLE_WINDOWS = 3
/** Seconds of stored text taken on each side of a window, so a clock that is off still lands inside. */
export const STORED_MARGIN_SECONDS = 120
/** Stored text sent to Jev for one window, at most. */
export const STORED_TEXT_MAX_CHARS = 6000
/** Under this many words, a window's transcript counts as "no speech". */
export const MIN_WINDOW_WORDS = 8

export interface SampleWindow {
  /** Start and end on the audio file's real timeline, in seconds. */
  start: number
  end: number
  /** What the stored transcript says around these minutes. */
  storedText: string
}

export interface WindowPlanInput {
  segments: ValiditySegment[]
  /** Length of the audio file, in seconds. */
  fileSeconds: number
  /** Factor the validity check applied to the line times (4 for an old WAV whose header lied). */
  timeFactor: number
  /**
   * Where the speech ends on the real timeline, when the transcript's clock is
   * compressed (the text is complete but its times end early). The stored
   * times are stretched onto [0, speechEnd] before the windows are placed.
   */
  compressedTo?: number | null
  /** Seconds of the file that hold audio, by frame (the validity envelope), to avoid sampling silence. */
  hasAudioAt?: (second: number) => boolean
}

function words(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

/** The stored lines on the real timeline: start, end, text. Untimed lines are kept with no time. */
function placedLines(input: WindowPlanInput): Array<{ start: number | null; end: number | null; text: string }> {
  const timed = input.segments.filter((s) => typeof s.start === 'number' && Number.isFinite(s.start))
  const storedEnd = timed.reduce((max, s) => Math.max(max, (s.end ?? s.start) as number), 0)
  const stretch =
    input.compressedTo && storedEnd > 0 && input.compressedTo > storedEnd ? input.compressedTo / storedEnd : input.timeFactor || 1
  return input.segments.map((s, i) => {
    const text = (s.text ?? '').trim()
    if (typeof s.start !== 'number' || !Number.isFinite(s.start)) return { start: null, end: null, text }
    const start = s.start * stretch
    const next = input.segments.slice(i + 1).find((n) => typeof n.start === 'number' && Number.isFinite(n.start))
    const ownEnd = typeof s.end === 'number' && s.end > s.start ? s.end * stretch : null
    const end = ownEnd ?? (next ? (next.start as number) * stretch : start)
    return { start, end: Math.max(start, end), text }
  })
}

/**
 * Up to SAMPLE_WINDOWS one-minute windows spread over the part of the file the
 * transcript covers, each centred where there is audio, with the stored text
 * of the same minutes plus a margin. Lines that cannot be placed in time (no
 * time, or every word at one instant) are added to every window's stored text,
 * since they could belong to any of them.
 */
export function planSampleWindows(input: WindowPlanInput): SampleWindow[] {
  const lines = placedLines(input)
  const placed = lines.filter((l) => l.start !== null && l.text) as Array<{ start: number; end: number; text: string }>
  const unplaceable = lines.filter((l) => (l.start === null || l.end === l.start) && words(l.text) > 40).map((l) => l.text)
  const coverEnd = Math.min(input.fileSeconds, placed.reduce((max, l) => Math.max(max, l.end), 0) || input.fileSeconds)
  if (coverEnd < SAMPLE_WINDOW_SECONDS / 2) return []

  const windows: SampleWindow[] = []
  const usable = Math.max(0, coverEnd - SAMPLE_WINDOW_SECONDS)
  for (let k = 0; k < SAMPLE_WINDOWS; k++) {
    // Centres at 1/6, 1/2 and 5/6 of the covered span.
    let start = usable * ((2 * k + 1) / (2 * SAMPLE_WINDOWS))
    if (input.hasAudioAt) {
      // Slide forward, then back, to the nearest stretch that holds audio.
      const step = 15
      let found = -1
      for (let d = 0; d <= usable && found < 0; d += step) {
        if (start + d <= usable && input.hasAudioAt(start + d + SAMPLE_WINDOW_SECONDS / 2)) found = start + d
        else if (start - d >= 0 && input.hasAudioAt(start - d + SAMPLE_WINDOW_SECONDS / 2)) found = start - d
      }
      if (found < 0) continue
      start = found
    }
    start = Math.round(start)
    const end = Math.min(input.fileSeconds, start + SAMPLE_WINDOW_SECONDS)
    if (windows.some((w) => Math.abs(w.start - start) < SAMPLE_WINDOW_SECONDS)) continue
    const near = placed
      .filter((l) => l.end >= start - STORED_MARGIN_SECONDS && l.start <= end + STORED_MARGIN_SECONDS)
      .map((l) => l.text)
    const storedText = [...near, ...unplaceable].join('\n').slice(0, STORED_TEXT_MAX_CHARS)
    windows.push({ start, end, storedText })
  }
  return windows
}

/**
 * Windows after the transcript's end, for a transcript that stops while the
 * file goes on with audio (plan step 3: "the windows come from after its
 * end instead"). Nothing is stored there, so the question is only whether
 * the audio holds speech.
 */
export function planAfterEndWindows(input: {
  endSeconds: number
  fileSeconds: number
  hasAudioAt?: (second: number) => boolean
}): SampleWindow[] {
  const span = input.fileSeconds - input.endSeconds
  if (span < SAMPLE_WINDOW_SECONDS / 2) return []
  const windows: SampleWindow[] = []
  const usable = Math.max(0, span - SAMPLE_WINDOW_SECONDS)
  for (let k = 0; k < SAMPLE_WINDOWS; k++) {
    let start = input.endSeconds + usable * ((2 * k + 1) / (2 * SAMPLE_WINDOWS))
    if (input.hasAudioAt) {
      let found = -1
      for (let d = 0; d <= usable && found < 0; d += 15) {
        const fwd = start + d
        const back = start - d
        if (fwd <= input.endSeconds + usable && input.hasAudioAt(fwd + SAMPLE_WINDOW_SECONDS / 2)) found = fwd
        else if (back >= input.endSeconds && input.hasAudioAt(back + SAMPLE_WINDOW_SECONDS / 2)) found = back
      }
      if (found < 0) continue
      start = found
    }
    start = Math.round(start)
    if (windows.some((w) => Math.abs(w.start - start) < SAMPLE_WINDOW_SECONDS)) continue
    windows.push({ start, end: Math.min(input.fileSeconds, start + SAMPLE_WINDOW_SECONDS), storedText: '' })
  }
  return windows
}

/** Speech in any window after the end makes the transcript incomplete; none at all confirms it. */
export function afterEndVerdict(freshTexts: Array<string | null>): SampleVerdict {
  const heard = freshTexts.filter((t): t is string => t !== null)
  if (heard.length === 0) return 'inconclusive'
  return heard.some((t) => words(t) >= MIN_WINDOW_WORDS) ? 'incomplete' : 'confirmed'
}

/** What Jev found for one window. */
export type WindowMatch = 'same' | 'different' | 'no_speech' | 'unclear'

export type SampleVerdict = 'confirmed' | 'contradicted' | 'inconclusive' | 'incomplete'

/**
 * The verdict of a sample: confirmed when most windows tell the same
 * conversation, contradicted when most tell another one or the audio holds no
 * speech where the stored transcript has text, inconclusive otherwise (the
 * transcript stays in doubt).
 */
export function sampleVerdict(matches: WindowMatch[]): SampleVerdict {
  const judged = matches.filter((m) => m !== 'unclear')
  if (judged.length === 0) return 'inconclusive'
  const same = judged.filter((m) => m === 'same').length
  const against = judged.length - same
  if (same > judged.length / 2) return 'confirmed'
  if (against > judged.length / 2) return 'contradicted'
  return 'inconclusive'
}

/** A window's own match before Jev: no speech in the new transcript where the stored one has text. */
export function precheckWindow(newText: string, storedText: string): WindowMatch | null {
  if (words(newText) < MIN_WINDOW_WORDS && words(storedText) >= MIN_WINDOW_WORDS) return 'no_speech'
  if (words(newText) < MIN_WINDOW_WORDS && words(storedText) < MIN_WINDOW_WORDS) return 'unclear'
  return null
}
