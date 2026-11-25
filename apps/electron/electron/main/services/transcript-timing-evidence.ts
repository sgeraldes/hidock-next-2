import { duplicateGroups, timingOutlierIndices, timingRanges, type TimedLine } from '../../../src/shared/transcript-line-issues'
import { OVERLAP_SECONDS } from '../../../src/shared/transcript-timing'
import type {
  TimingFinding, TimingFixedRange, TimingReviewAction, TimingSectionRun, TimingSegment
} from '../../../src/shared/transcript-timing'
import { alignToSpeech, type AlignmentResult, type SpeechSpan } from './transcript-time-aligner'
import { hasInlineTurns } from '../../../src/shared/inline-turns'

/**
 * What the audio of one recording can say. Sound is evidence of possible
 * speech, never evidence that particular words match. null means unknown:
 * missing evidence never turns into invented silence.
 */
export interface SpeechEvidence {
  hasAudio: (start: number, end: number) => boolean | null
  spansIn: (start: number, end: number) => SpeechSpan[] | null
}

export const NO_EVIDENCE: SpeechEvidence = { hasAudio: () => null, spansIn: () => null }


function asLines(segments: TimingSegment[]): TimedLine[] {
  return segments.map((s) => ({
    start: typeof s.start === 'number' && Number.isFinite(s.start) ? s.start : null,
    end: typeof s.end === 'number' && Number.isFinite(s.end) ? s.end : null,
    text: typeof s.text === 'string' ? s.text : '',
    speaker: s.speaker ?? null,
    timingHidden: s.timingHidden === true
  }))
}

function trusted(segments: TimingSegment[], outliers: Set<number>, index: number): boolean {
  const s = segments[index]
  return !!s && !s.timingHidden && typeof s.start === 'number' && Number.isFinite(s.start) && !outliers.has(index)
}

/**
 * Where a range belongs according to the trusted lines around it: from the end
 * of the ordered line before it (its start when that end overlaps the next
 * one) to the start of the ordered line after it.
 */
export function rangeWindow(
  segments: TimingSegment[], from: number, to: number, outliers: Set<number>, durationSeconds?: number | null
): { start: number; end: number } | null {
  let before = from - 1
  while (before >= 0 && !trusted(segments, outliers, before)) before--
  let after = to + 1
  while (after < segments.length && !trusted(segments, outliers, after)) after++
  const next = after < segments.length ? segments[after].start : null
  const prior = before >= 0 ? segments[before] : null
  const start = prior ? (typeof prior.end === 'number' && (next === null || prior.end <= next) ? prior.end : prior.start) : 0
  const end = next ?? (typeof durationSeconds === 'number' && durationSeconds > 0 ? durationSeconds : null)
  if (end === null || end <= start) return null
  return { start, end }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function assessTimingEvidence(
  segments: TimingSegment[], evidence: SpeechEvidence, durationSeconds?: number | null
): TimingFinding[] {
  const lines = asLines(segments)
  const outliers = new Set(timingOutlierIndices(lines))
  const findings: TimingFinding[] = []

  for (const range of timingRanges(lines)) {
    const flagged = range.lines.map((i) => segments[i])
    const claimedStart = Math.min(...flagged.map((s) => s.start))
    const claimedEnd = Math.max(...flagged.map((s) => Math.max(s.start, s.end ?? s.start)))
    const window = rangeWindow(segments, range.from, range.to, outliers, durationSeconds)
    const impliedAudio = window ? evidence.hasAudio(window.start, window.end) : null
    const claimedAudio = evidence.hasAudio(claimedStart - 1, Math.max(claimedEnd, claimedStart + 2) + 1)
    const spans = window ? evidence.spansIn(window.start, window.end) : null
    const alignment: AlignmentResult | null = window && spans ? alignToSpeech(flagged, window, spans) : null
    const displacement = window
      ? claimedStart < window.start ? window.start - claimedStart : claimedStart > window.end ? claimedStart - window.end : 0
      : 0
    const overlap = window !== null && displacement < OVERLAP_SECONDS
    const fix = alignment
      ? { ok: alignment.ok, confidence: alignment.confidence, firstStart: alignment.ok ? alignment.starts[0] : null,
          reason: overlap && !alignment.ok
            ? `${range.kind === 'odd_line' ? 'It starts' : 'They start'} ${displacement.toFixed(1)} s from where the lines around ${range.kind === 'odd_line' ? 'it' : 'them'} say, as when two people speak at once. Nothing needs fixing unless it sounds wrong.`
            : alignment.reason,
          offerSection: !alignment.ok && !overlap, displacement }
      : { ok: false, confidence: 0, firstStart: null, offerSection: false, displacement,
          reason: window ? 'This recording has no speech evidence to place the lines on.' : 'No ordered line follows this range, so where it belongs is unknown.' }
    // A legacy line holding "[MM:SS] Speaker N:" turns shows them at their own
    // times, which moving the line does not change (CodeRabbit review of #195).
    if (fix.ok && flagged.some((s) => hasInlineTurns(s.text))) {
      Object.assign(fix, {
        ok: false, firstStart: null, offerSection: !overlap,
        reason: 'This line holds turns with their own times, so moving the line would not move them.'
      })
    }
    const classification = impliedAudio === true && fix.ok
      ? 'out_of_place' : claimedAudio === false && impliedAudio === false ? 'probable_hallucination' : 'unsure'
    const what = range.kind === 'odd_line' ? 'This line' : `These ${range.lines.length} lines`
    const where = window ? `between ${clock(window.start)} and ${clock(window.end)}` : 'elsewhere'
    findings.push({
      id: `${range.kind}:${range.from}-${range.to}`,
      kind: range.kind, index: range.from, from: range.from, to: range.to, lines: range.lines,
      claimedStart, claimedEnd,
      windowStart: window?.start ?? null, windowEnd: window?.end ?? null,
      impliedStart: alignment?.ok ? alignment.starts[0] : null,
      suggestedStart: classification === 'out_of_place' ? fix.firstStart : null,
      classification, claimedAudio, impliedAudio, fix,
      detail: classification === 'out_of_place'
        ? `${what} ${range.kind === 'odd_line' ? 'says' : 'say'} ${clock(claimedStart)}, but the lines around ${range.kind === 'odd_line' ? 'it' : 'them'} place ${range.kind === 'odd_line' ? 'it' : 'them'} ${where}, where there is speech. Fix times lays the words on that speech; it does not recognise them, so listen, and undo if it is wrong.`
        : classification === 'probable_hallucination'
          ? `No speech was found at ${clock(claimedStart)} or ${where}. ${what} may have been invented; hiding can be undone.`
          : fix.ok
            ? `The sound cannot confirm where ${what.toLowerCase()} ${range.kind === 'odd_line' ? 'belongs' : 'belong'}. Fix times would place ${range.kind === 'odd_line' ? 'it' : 'them'} ${where}; listen first.`
            : `${fix.reason} Transcribing this section again writes it from the audio ${where}.`
    })
  }

  for (const group of duplicateGroups(lines)) {
    const first = segments[group.originals[0]]
    const copy = segments[group.copies[0]]
    const from = group.copies[0]
    const to = group.copies[group.copies.length - 1]
    findings.push({
      id: `duplicate:${from}-${to}`,
      kind: 'duplicate', index: from, from, to, lines: group.copies, originals: group.originals,
      claimedStart: copy.start,
      claimedEnd: Math.max(...group.copies.map((i) => segments[i].end ?? segments[i].start)),
      windowStart: null, windowEnd: null, impliedStart: null, suggestedStart: null,
      classification: 'duplicate', claimedAudio: null, impliedAudio: null,
      detail: `${group.kind === 'section' ? `These ${group.copies.length} lines repeat` : 'This line repeats'} what ${group.kind === 'section' ? 'the lines' : 'the line'} at ${clock(first.start)} already ${group.kind === 'section' ? 'say' : 'says'}, as where two pieces of audio overlap. Hiding the copy keeps it in the stored transcript and can be undone.`
    })
  }
  return findings.sort((a, b) => a.from - b.from)
}

function groupConsecutive(indices: number[]): TimingFixedRange[] {
  const ranges: TimingFixedRange[] = []
  for (const index of indices) {
    const last = ranges[ranges.length - 1]
    if (last && index === last.to + 1) last.to = index
    else ranges.push({ from: index, to: index })
  }
  return ranges
}

export function fixedRanges(segments: TimingSegment[]): TimingFixedRange[] {
  return groupConsecutive(segments.flatMap((s, i) => s.timingOriginalStart !== undefined ? [i] : []))
}

/** Section transcriptions that can be undone now: not replaced by a later one. */
export function sectionRuns(segments: TimingSegment[]): TimingSectionRun[] {
  const runs = new Map<string, TimingSectionRun>()
  const superseded = new Set(segments.flatMap((s) => s.sectionRunId && s.sectionReplacedBy ? [s.sectionRunId] : []))
  segments.forEach((s, i) => {
    if (s.sectionRunId && superseded.has(s.sectionRunId)) return
    if (!s.sectionRunId) return
    const run = runs.get(s.sectionRunId)
    if (run) run.to = i
    else runs.set(s.sectionRunId, { runId: s.sectionRunId, from: i, to: i })
  })
  return [...runs.values()]
}

export interface TimingReviewRequest {
  action: TimingReviewAction
  /** hide/show: the lines. fix_times: the finding's lines, in order. */
  indices?: number[]
  /** fix_times: the aligner's result for those lines. undo_fix: the range. */
  alignment?: Pick<AlignmentResult, 'starts' | 'ends'>
  range?: TimingFixedRange
  /** undo_section: the run to take back. */
  runId?: string
}

/** Pure: returns new segments, never changes the input. Each change keeps what it replaced. */
export function applyTimingReview(segments: TimingSegment[], request: TimingReviewRequest): TimingSegment[] {
  const copy = segments.map((s) => ({ ...s }))
  const indices = request.indices ?? []
  for (const i of indices) if (!copy[i]) throw new Error('Line no longer exists')
  switch (request.action) {
    case 'hide':
    case 'show':
      if (!indices.length) throw new Error('No line chosen')
      for (const i of indices) copy[i] = { ...copy[i], timingHidden: request.action === 'hide', timingReviewed: true }
      return copy
    case 'fix_times': {
      const { alignment } = request
      if (!alignment || alignment.starts.length !== indices.length || !indices.length) throw new Error('No alignment for these lines')
      indices.forEach((i, k) => {
        const line = copy[i]
        // The transcriber's times are captured once, on the first fix; a line
        // that had no end keeps having none to go back to.
        const first = line.timingOriginalStart === undefined
        copy[i] = {
          ...line,
          start: alignment.starts[k],
          end: alignment.ends[k],
          timingOriginalStart: first ? line.start : line.timingOriginalStart,
          ...(first && line.end !== undefined ? { timingOriginalEnd: line.end } : {}),
          timingReviewed: true
        }
      })
      return copy
    }
    case 'undo_fix': {
      const range = request.range
      if (!range) throw new Error('No fixed range chosen')
      let restored = 0
      for (let i = range.from; i <= range.to; i++) {
        const line = copy[i]
        if (!line || line.timingOriginalStart === undefined) continue
        const { timingOriginalStart, timingOriginalEnd, ...rest } = line
        copy[i] = { ...rest, start: timingOriginalStart, ...(timingOriginalEnd !== undefined ? { end: timingOriginalEnd } : {}), timingReviewed: true }
        if (timingOriginalEnd === undefined) delete copy[i].end
        restored++
      }
      if (!restored) throw new Error('Nothing to undo here')
      return copy
    }
    case 'undo_section': {
      const runId = request.runId
      if (!runId || !copy.some((s) => s.sectionRunId === runId)) throw new Error('No section transcription to undo')
      // Its lines were replaced again by a later run: undoing this one first
      // would show the original lines next to the later run's.
      if (copy.some((s) => s.sectionRunId === runId && s.sectionReplacedBy)) {
        throw new Error('A later section transcription replaced this one; undo the later one first')
      }
      return copy.filter((s) => s.sectionRunId !== runId).map((s) => {
        if (s.sectionReplacedBy !== runId) return s
        const { sectionReplacedBy: _replaced, ...rest } = s
        return { ...rest, timingHidden: false, timingReviewed: true }
      })
    }
  }
}

/**
 * Put a new transcription of a section in place of the range's lines. The old
 * lines stay, hidden and marked with the run that replaced them, so undoing
 * the run brings them back exactly.
 */
export function spliceSection(
  segments: TimingSegment[], from: number, to: number, replacement: TimingSegment[], runId: string
): TimingSegment[] {
  if (from < 0 || to >= segments.length || from > to) throw new Error('Line no longer exists')
  if (!replacement.length) throw new Error('The new transcription of this section has no lines')
  const old = segments.slice(from, to + 1).map((s) =>
    s.timingHidden ? { ...s } : { ...s, timingHidden: true, sectionReplacedBy: runId, timingReviewed: true })
  const fresh = replacement.map((s) => ({ ...s, sectionRunId: runId, timingReviewed: true }))
  return [...segments.slice(0, from).map((s) => ({ ...s })), ...old, ...fresh, ...segments.slice(to + 1).map((s) => ({ ...s }))]
}
