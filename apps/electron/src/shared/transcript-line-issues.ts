/**
 * The per-line timing rules of the transcript integrity check, shared by the
 * main process (transcript-integrity.ts counts them) and the transcript viewer
 * (which marks the lines themselves, owner 28-sep-2026). One source, so the
 * count in the warning and the lines marked in the text always agree.
 */

export type LineIssueCode = 'repeated_start' | 'backwards_start' | 'cramped_lines' | 'untimed_lines'

/** The codes a person can jump to in the transcript: each marks specific lines. */
export const JUMPABLE_LINE_ISSUES: readonly LineIssueCode[] = ['repeated_start', 'backwards_start', 'cramped_lines', 'untimed_lines']

export function isJumpableLineIssue(code: string): code is LineIssueCode {
  return (JUMPABLE_LINE_ISSUES as readonly string[]).includes(code)
}

/** Starts that round to the same hundredth of a second are the same instant. */
export const SAME_START_RESOLUTION = 100
/** A start this far before the previous one is going backwards, not jitter. */
export const BACKWARDS_TOLERANCE_SECONDS = 0.5
/** A line needs this many words before its pace means anything. */
export const CRAMPED_MIN_WORDS = 8
/** Faster than anyone speaks, for one line (value-thresholds IMPOSSIBLE_WORDS_PER_SECOND; a test keeps them equal). */
export const CRAMPED_WORDS_PER_SECOND = 8

export interface TimedLine {
  /** Seconds, or null for a line with no time. */
  start: number | null
  end: number | null
  text: string
  /** Retained source line omitted from derived content at the owner's request. */
  timingHidden?: boolean
}

const WORD = /[\p{L}\p{N}]+/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

/** Indices outside the longest non-decreasing sequence, allowing small overlap.
 * O(n log n); equal starts remain in the sequence and keep their separate flag.
 * Hidden source lines retain their indices but no longer distort the sequence.
 */
export function timingOutlierIndices(lines: TimedLine[]): number[] {
  const tails: number[] = []
  const indices: number[] = []
  const parents = new Map<number, number>()
  const timed: number[] = []
  lines.forEach((line, index) => {
    if (line.timingHidden || line.start === null || !Number.isFinite(line.start)) return
    timed.push(index)
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (tails[mid] <= line.start + BACKWARDS_TOLERANCE_SECONDS) lo = mid + 1
      else hi = mid
    }
    parents.set(index, lo > 0 ? indices[lo - 1] : -1)
    tails[lo] = Math.max(line.start, lo > 0 ? tails[lo - 1] : line.start)
    indices[lo] = index
  })
  const kept = new Set<number>()
  let cursor = indices.at(-1) ?? -1
  while (cursor >= 0) {
    kept.add(cursor)
    cursor = parents.get(cursor) ?? -1
  }
  return timed.filter(index => !kept.has(index))
}

/** One source for counts and row marks: flag the outlier, not its neighbour. */
export function lineIssues(lines: TimedLine[]): LineIssueCode[][] {
  const out: LineIssueCode[][] = lines.map(() => [])
  const outliers = new Set(timingOutlierIndices(lines))
  const seenStarts = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const { start, timingHidden } = lines[i]
    if (timingHidden) continue
    if (start === null || !Number.isFinite(start)) {
      out[i].push('untimed_lines')
      continue
    }
    if (outliers.has(i)) {
      out[i].push('backwards_start')
      continue
    }
    const instant = Math.round(start * SAME_START_RESOLUTION)
    if (seenStarts.has(instant)) out[i].push('repeated_start')
    seenStarts.add(instant)
  }
  // Pace uses the ordered sequence, never a rejected timestamp as a boundary.
  const timed = lines.map((l, i) => ({ l, i }))
    .filter(({ l, i }) => l.start !== null && !l.timingHidden && !outliers.has(i))
  for (let k = 0; k < timed.length; k++) {
    const { l, i } = timed[k]
    const n = countWords(l.text)
    if (n < CRAMPED_MIN_WORDS) continue
    const next = timed[k + 1]?.l.start ?? l.end
    if (next === null || next === undefined) continue
    const span = next - (l.start as number)
    if (span <= 0 || n / span > CRAMPED_WORDS_PER_SECOND) out[i].push('cramped_lines')
  }
  return out
}

/** How many lines show each issue. */
export function countLineIssues(perLine: LineIssueCode[][]): Record<LineIssueCode, number> {
  const counts: Record<LineIssueCode, number> = { repeated_start: 0, backwards_start: 0, cramped_lines: 0, untimed_lines: 0 }
  for (const codes of perLine) for (const c of codes) counts[c]++
  return counts
}
