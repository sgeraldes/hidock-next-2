/**
 * The per-line timing rules of the transcript integrity check, shared by the
 * main process (transcript-integrity.ts counts them) and the transcript viewer
 * (which marks the lines themselves, owner 28-sep-2026). One source, so the
 * count in the warning and the lines marked in the text always agree.
 */

export type LineIssueCode = 'repeated_start' | 'backwards_start' | 'cramped_lines' | 'untimed_lines'

/** The codes a person can jump to in the transcript: each marks specific lines. */
export const JUMPABLE_LINE_ISSUES: readonly LineIssueCode[] = ['repeated_start', 'backwards_start', 'cramped_lines']

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
}

const WORD = /[\p{L}\p{N}]+/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

/**
 * The issues of each line, in line order. A repeated start is marked on the
 * later line; a backwards start on the line that goes back; a cramped line on
 * the line whose words do not fit before the next stated start.
 */
export function lineIssues(lines: TimedLine[]): LineIssueCode[][] {
  const out: LineIssueCode[][] = lines.map(() => [])
  const seenStarts = new Set<number>()
  let previousStart: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start
    if (start === null) {
      out[i].push('untimed_lines')
      continue
    }
    const instant = Math.round(start * SAME_START_RESOLUTION)
    if (seenStarts.has(instant)) out[i].push('repeated_start')
    seenStarts.add(instant)
    if (previousStart !== null && start < previousStart - BACKWARDS_TOLERANCE_SECONDS) out[i].push('backwards_start')
    previousStart = start
  }

  // Pace per line: words over the time until the next stated start.
  const timed = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.start !== null)
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
