/**
 * The per-line timing rules of the transcript integrity check, shared by the
 * main process (transcript-integrity.ts counts them) and the transcript viewer
 * (which marks the lines themselves, owner 28-sep-2026). One source, so the
 * count in the warning and the lines marked in the text always agree.
 */

/**
 * backwards_start: one line outside the time order of the lines around it (the
 * odd one out, never its ordered neighbour). mistimed_run: two or more
 * consecutive lines outside that order, a section whose times shifted.
 * duplicate_line: a line, or a block of lines, the transcriber wrote twice.
 */
export type LineIssueCode =
  | 'repeated_start'
  | 'backwards_start'
  | 'mistimed_run'
  | 'duplicate_line'
  | 'cramped_lines'
  | 'untimed_lines'

/** The codes a person can jump to in the transcript: each marks specific lines. */
export const JUMPABLE_LINE_ISSUES: readonly LineIssueCode[] = [
  'repeated_start', 'backwards_start', 'mistimed_run', 'duplicate_line', 'cramped_lines', 'untimed_lines'
]

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

/** A repeated line needs this many different words, so "Sí, sí." or "Okay." is never a duplicate. */
export const DUPLICATE_MIN_DISTINCT_WORDS = 2
/**
 * Below this many different words, a repeat counts only when one of the two
 * copies is also out of time order, the mark of two overlapping audio chunks.
 * People say "Uh-huh.", "Thank you." or "Buenos días." again on their own.
 */
export const DUPLICATE_UNORDERED_BELOW_WORDS = 5
/** A copy this close to the first one, in time and in lines, is the transcriber repeating itself. */
export const DUPLICATE_WINDOW_SECONDS = 30
export const DUPLICATE_WINDOW_LINES = 8
/** A repeated block: at least this many lines and words, within this many lines of the first. */
export const DUPLICATE_SECTION_MIN_LINES = 2
export const DUPLICATE_SECTION_MIN_WORDS = 6
export const DUPLICATE_SECTION_WINDOW_LINES = 40

export interface TimedLine {
  /** Seconds, or null for a line with no time. */
  start: number | null
  end: number | null
  text: string
  /** Voice label, when the transcript has one: a repeat by another voice is an echo. */
  speaker?: string | null
  /** Retained source line omitted from derived content at the owner's request. */
  timingHidden?: boolean
}

const WORD = /[\p{L}\p{N}]+/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

/** Lowercase words without accents or punctuation: two copies of a line compare equal. */
export function normalizedWords(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(WORD) ?? [])
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

export interface TimingRange {
  /** One line out of order, or a section of consecutive lines out of order. */
  kind: 'odd_line' | 'mistimed_run'
  /** First and last source line of the range, inclusive. */
  from: number
  to: number
  /** The out-of-order lines in it; hidden and untimed lines between them are skipped. */
  lines: number[]
}

/**
 * The out-of-order lines grouped as the owner reads them: consecutive ones are
 * one section with shifted times, reported once, never as dozens of lines.
 * Hidden and untimed lines between two of them do not split the section.
 */
export function timingRanges(lines: TimedLine[]): TimingRange[] {
  const outliers = timingOutlierIndices(lines)
  const ranges: TimingRange[] = []
  let current: number[] = []
  const close = () => {
    if (!current.length) return
    ranges.push({ kind: current.length === 1 ? 'odd_line' : 'mistimed_run', from: current[0], to: current[current.length - 1], lines: current })
    current = []
  }
  for (const index of outliers) {
    const last = current[current.length - 1]
    if (last !== undefined) {
      let adjacent = true
      for (let between = last + 1; between < index; between++) {
        const line = lines[between]
        if (!line.timingHidden && line.start !== null && Number.isFinite(line.start)) { adjacent = false; break }
      }
      if (!adjacent) close()
    }
    current.push(index)
  }
  close()
  return ranges
}

export interface DuplicateGroup {
  /** One repeated line, or a repeated block of lines. */
  kind: 'line' | 'section'
  /** The first copy, kept. */
  originals: number[]
  /** The later copy, the one to hide; same order as originals. */
  copies: number[]
}

/**
 * Lines the transcriber wrote twice, as happens where two chunks of audio
 * overlap. A block of lines repeated in order is one section. A single line
 * counts only when the same voice says it again within seconds and it has at
 * least two different words: people echo each other ("Buenos días.") and
 * repeat one-word answers, and neither is a transcription error.
 */
export function duplicateGroups(lines: TimedLine[]): DuplicateGroup[] {
  // A sound tag such as "[Environmental Sounds]" is not speech written twice.
  const keys = lines.map((line) => line.timingHidden || /^\s*\[[^\]]*\]\s*$/u.test(line.text) ? null : normalizedWords(line.text))
  const outOfOrder = new Set(timingOutlierIndices(lines))
  const key = (i: number) => keys[i]?.join(' ') ?? null
  const visible = lines.flatMap((line, i) => line.timingHidden || !keys[i]?.length ? [] : [i])
  const near = (a: number, b: number) => {
    const sa = lines[a].start
    const sb = lines[b].start
    return sa === null || sb === null || Math.abs(sa - sb) <= DUPLICATE_WINDOW_SECONDS
  }
  const groups: DuplicateGroup[] = []
  const used = new Set<number>()

  // Sections first: a block of visible lines repeated in the same order.
  for (let p = 0; p < visible.length; p++) {
    for (let q = p + 1; q < visible.length && q - p <= DUPLICATE_SECTION_WINDOW_LINES; q++) {
      if (used.has(visible[p]) || used.has(visible[q])) continue
      let length = 0
      while (q + length < visible.length && p + length < q &&
        key(visible[p + length]) === key(visible[q + length]) &&
        !used.has(visible[q + length])) length++
      if (length < DUPLICATE_SECTION_MIN_LINES) continue
      const originals = visible.slice(p, p + length)
      const copies = visible.slice(q, q + length)
      const words = originals.reduce((sum, i) => sum + (keys[i]?.length ?? 0), 0)
      if (words < DUPLICATE_SECTION_MIN_WORDS || !near(originals[0], copies[0])) continue
      groups.push({ kind: 'section', originals, copies })
      for (const i of [...originals, ...copies]) used.add(i)
      break
    }
  }

  // Then single lines, by the same voice, close in time and in lines.
  for (let q = 0; q < visible.length; q++) {
    const copy = visible[q]
    const distinct = new Set(keys[copy]).size
    if (used.has(copy) || distinct < DUPLICATE_MIN_DISTINCT_WORDS) continue
    for (let p = q - 1; p >= 0 && q - p <= DUPLICATE_WINDOW_LINES; p--) {
      const original = visible[p]
      if (used.has(original) || key(original) !== key(copy)) continue
      const voiceA = lines[original].speaker
      const voiceB = lines[copy].speaker
      if (voiceA && voiceB && voiceA !== voiceB) continue
      if (!near(original, copy)) continue
      if (distinct < DUPLICATE_UNORDERED_BELOW_WORDS && !outOfOrder.has(copy) && !outOfOrder.has(original)) continue
      groups.push({ kind: 'line', originals: [original], copies: [copy] })
      used.add(original)
      used.add(copy)
      break
    }
  }
  return groups.sort((a, b) => a.copies[0] - b.copies[0])
}

/** One source for counts and row marks: flag the outlier, not its neighbour. */
export function lineIssues(lines: TimedLine[]): LineIssueCode[][] {
  const out: LineIssueCode[][] = lines.map(() => [])
  const ranges = timingRanges(lines)
  const outliers = new Set(ranges.flatMap((range) => range.lines))
  const inRun = new Set(ranges.filter((range) => range.kind === 'mistimed_run').flatMap((range) => range.lines))
  const seenStarts = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const { start, timingHidden } = lines[i]
    if (timingHidden) continue
    if (start === null || !Number.isFinite(start)) {
      out[i].push('untimed_lines')
      continue
    }
    if (outliers.has(i)) {
      out[i].push(inRun.has(i) ? 'mistimed_run' : 'backwards_start')
      continue
    }
    const instant = Math.round(start * SAME_START_RESOLUTION)
    if (seenStarts.has(instant)) out[i].push('repeated_start')
    seenStarts.add(instant)
  }
  for (const group of duplicateGroups(lines)) for (const i of group.copies) out[i].push('duplicate_line')
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
  const counts: Record<LineIssueCode, number> = {
    repeated_start: 0, backwards_start: 0, mistimed_run: 0, duplicate_line: 0, cramped_lines: 0, untimed_lines: 0
  }
  for (const codes of perLine) for (const c of codes) counts[c]++
  return counts
}
