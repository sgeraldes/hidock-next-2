/**
 * Puts a range of transcript lines on the words Parakeet heard in that stretch
 * of audio (the model host's alignment job).
 *
 * The transcript's words and the heard words are matched in order with an
 * edit-distance alignment: a word heard slightly differently ("estan" for
 * "estás") still matches, a transcript word that was not heard is skipped, and
 * speech the transcript does not have (the lines on either side, a filler, an
 * untranscribed remark) costs little and is passed over. Each line then starts
 * where its first matched word was heard and ends where its last one ended.
 *
 * It refuses, instead of guessing, when too few of the words were heard. The
 * caller then falls back to the speech-stretch aligner (transcript-time-aligner).
 */

import { ALIGN_MIN_STEP_SECONDS, type AlignmentResult, type SpeechSpan } from './transcript-time-aligner'

export interface HostWord {
  word: string
  /** Seconds on the recording's clock. */
  start: number
  end: number
}

export interface WordAlignmentResult extends AlignmentResult {
  method: 'model-host-words'
  matchedWords: number
  totalWords: number
  heardWords: number
}

/** Below this share of the transcript's words heard, the placement is not trusted. */
export const WORD_ALIGN_MIN_MATCH = 0.5
/** Two words this alike (1 minus edit distance over length) are the same word heard slightly differently. */
export const WORD_ALIGN_NEAR = 0.7
/** Time given to each transcript word that was not heard, before or after the heard ones in its line. */
export const WORD_ALIGN_UNHEARD_SECONDS = 0.3
/** Above this many cells the match would hold the main process too long; the section is refused. */
export const WORD_ALIGN_MAX_CELLS = 6_000_000

const COST_NEAR = 0.3
const COST_SUBSTITUTE = 1
const COST_UNHEARD = 1
const COST_EXTRA = 0.5

const WORD = /[\p{L}\p{N}]+/gu

/** Lower case, no accents, letters and digits only: "¿Qué?" and "que" are one word. */
export function normalizeWords(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(WORD) ?? []
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

function substitution(a: string, b: string): number {
  if (a === b) return 0
  if (a.length >= 3 && b.length >= 3 && 1 - editDistance(a, b) / Math.max(a.length, b.length) >= WORD_ALIGN_NEAR) return COST_NEAR
  return COST_SUBSTITUTE
}

export function alignLinesToWords(lines: Array<{ text: string }>, window: SpeechSpan, heardWords: HostWord[]): WordAlignmentResult {
  // Each heard word may split into several normalized pieces ("it's"); every piece keeps the word's times.
  const heard = heardWords
    .filter((w) => w.end > window.start - 1 && w.start < window.end + 1)
    .flatMap((w) => normalizeWords(w.word).map((text) => ({ text, start: w.start, end: w.end })))
  const lineWords = lines.map((line) => normalizeWords(line.text))
  const words = lineWords.flatMap((list, line) => list.map((text) => ({ text, line })))
  const n = words.length
  const m = heard.length
  const speechSeconds = heard.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0)
  const failed = (reason: string, confidence = 0, matched = 0): WordAlignmentResult => ({
    ok: false, confidence, starts: [], ends: [], speechSeconds, wordsPerSpeechSecond: null, reason,
    method: 'model-host-words', matchedWords: matched, totalWords: n, heardWords: m
  })
  if (!lines.length || !n) return failed('There are no words in these lines to place.')
  if (!m) return failed('The model host heard no words in this stretch of audio.')
  if ((n + 1) * (m + 1) > WORD_ALIGN_MAX_CELLS) return failed('This section is too long to match word by word in one go.')

  // cost[i][j]: transcript words [0, i) against heard words [0, j). Heard words
  // before the first match are free (the line before, or padding), and so are
  // those after the last (the minimum is taken over the whole last row).
  const width = m + 1
  const cost = new Float32Array((n + 1) * width)
  const move = new Uint8Array((n + 1) * width) // 0 diagonal, 1 transcript word unheard, 2 extra heard word
  for (let i = 1; i <= n; i++) { cost[i * width] = i * COST_UNHEARD; move[i * width] = 1 }
  for (let i = 1; i <= n; i++) {
    const t = words[i - 1].text
    for (let j = 1; j <= m; j++) {
      const diagonal = cost[(i - 1) * width + j - 1] + substitution(t, heard[j - 1].text)
      const unheard = cost[(i - 1) * width + j] + COST_UNHEARD
      const extra = cost[i * width + j - 1] + COST_EXTRA
      let best = diagonal
      let step = 0
      if (unheard < best) { best = unheard; step = 1 }
      if (extra < best) { best = extra; step = 2 }
      cost[i * width + j] = best
      move[i * width + j] = step
    }
  }
  let j = 0
  for (let k = 1; k <= m; k++) if (cost[n * width + k] < cost[n * width + j]) j = k

  // Walk back: which heard word each transcript word landed on, and how well.
  const strong = new Array<number>(n).fill(-1)
  const weak = new Array<number>(n).fill(-1)
  let i = n
  while (i > 0) {
    const step = j === 0 ? 1 : move[i * width + j]
    if (step === 0) {
      const c = substitution(words[i - 1].text, heard[j - 1].text)
      if (c < COST_SUBSTITUTE) strong[i - 1] = j - 1
      else weak[i - 1] = j - 1
      i--; j--
    } else if (step === 1) {
      i--
    } else {
      j--
    }
  }
  const matched = strong.filter((k) => k >= 0).length
  const confidence = matched / n

  // Each line from its own heard words; strong matches first, then substitutions.
  const raw: Array<{ start: number; end: number; strong: boolean } | null> = []
  let offset = 0
  for (const list of lineWords) {
    const range = Array.from({ length: list.length }, (_, k) => offset + k)
    offset += list.length
    const pick = range.some((k) => strong[k] >= 0) ? strong : range.some((k) => weak[k] >= 0) ? weak : null
    if (!pick) { raw.push(null); continue }
    const anchored = range.filter((k) => pick[k] >= 0)
    const first = anchored[0]
    const last = anchored[anchored.length - 1]
    raw.push({
      start: heard[pick[first]].start - (first - range[0]) * WORD_ALIGN_UNHEARD_SECONDS,
      end: heard[pick[last]].end + (range[range.length - 1] - last) * WORD_ALIGN_UNHEARD_SECONDS,
      strong: pick === strong
    })
  }

  // In order, apart and inside the window; a line with nothing heard shares the gap
  // between its neighbours in proportion to its words.
  const starts: number[] = []
  const ends: number[] = []
  for (let k = 0; k < lines.length; k++) {
    const floor = k > 0 ? starts[k - 1] + ALIGN_MIN_STEP_SECONDS : window.start
    const own = raw[k]
    if (own) {
      starts.push(Math.min(window.end, Math.max(floor, own.start)))
      ends.push(own.end)
      continue
    }
    let next = k + 1
    while (next < lines.length && !raw[next]) next++
    const gapStart = Math.max(floor, k > 0 ? ends[k - 1] : window.start)
    const gapEnd = next < lines.length ? Math.max(gapStart, raw[next]!.start) : window.end
    const pending = lineWords.slice(k, next).map((list) => Math.max(1, list.length))
    const total = pending.reduce((sum, c) => sum + c, 0)
    let before = 0
    for (let q = k; q < next; q++) {
      const at = gapStart + ((gapEnd - gapStart) * before) / total
      before += pending[q - k]
      const floorQ = q > 0 ? starts[q - 1] + ALIGN_MIN_STEP_SECONDS : window.start
      starts.push(Math.min(window.end, Math.max(floorQ, at)))
      ends.push(gapStart + ((gapEnd - gapStart) * before) / total)
    }
    k = next - 1
  }
  for (let k = 0; k < lines.length; k++) {
    const next = k + 1 < lines.length ? starts[k + 1] : window.end
    ends[k] = Math.max(Math.min(ends[k], next, window.end), starts[k] + ALIGN_MIN_STEP_SECONDS)
  }

  const strongLines = raw.filter((r) => r?.strong).length
  const ok = confidence >= WORD_ALIGN_MIN_MATCH && strongLines >= Math.ceil(lines.length / 2)
  return {
    ok, confidence, starts, ends, speechSeconds, wordsPerSpeechSecond: null,
    reason: ok ? '' : `The model host heard only ${matched} of these ${n} words here, too few to place the lines by them.`,
    method: 'model-host-words', matchedWords: matched, totalWords: n, heardWords: m
  }
}
