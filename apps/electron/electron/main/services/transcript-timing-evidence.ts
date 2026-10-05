import { countWords, timingOutlierIndices } from '../../../src/shared/transcript-line-issues'
import type { TimingFinding, TimingReviewAction, TimingSegment } from '../../../src/shared/transcript-timing'

/** Sound is evidence of possible speech, never evidence that particular words match. */
export function assessTimingEvidence(
  segments: TimingSegment[],
  hasAudio: (start: number, end: number) => boolean | null
): TimingFinding[] {
  const outliers = new Set(timingOutlierIndices(segments.map(s => ({ ...s, end: s.end ?? null }))))
  return [...outliers].map(index => {
    const segment = segments[index]
    let left = index - 1
    let right = index + 1
    while (left >= 0 && (outliers.has(left) || segments[left].timingHidden)) left--
    while (right < segments.length && (outliers.has(right) || segments[right].timingHidden)) right++
    const low = left >= 0 ? segments[left].end ?? segments[left].start : 0
    const high = right < segments.length ? segments[right].start : null
    const duration = Math.max(0.6, countWords(segment.text) / 3)
    // Search the available sequence gap rather than assuming speech immediately
    // precedes the next turn. Rec28's greeting is near 4.5 s, then silence to 13 s.
    // Very wide gaps cannot support a specific placement from sound alone.
    let candidate: number | null = null
    let impliedAudio: boolean | null = null
    if (high !== null && high - low >= duration && high - low <= 60) {
      impliedAudio = hasAudio(low, high)
      if (impliedAudio === true) {
        for (let at = low; at <= high - Math.min(duration, 0.5); at += 0.25) {
          if (hasAudio(at, Math.min(high, at + 0.5)) === true) {
            candidate = Math.min(at, high - duration)
            break
          }
        }
      }
    }
    const claimedAudio = hasAudio(segment.start - 1, segment.start + Math.max(duration, 2) + 1)
    const classification = impliedAudio === true && candidate !== null
      ? 'out_of_place' : claimedAudio === false && impliedAudio === false
        ? 'probable_hallucination' : 'unsure'
    return {
      index, claimedStart: segment.start, impliedStart: candidate,
      suggestedStart: classification === 'out_of_place' ? candidate : null,
      classification, claimedAudio, impliedAudio,
      detail: classification === 'out_of_place'
        ? 'Sound exists in the gap implied by surrounding lines. This is a suggested placement, not a word-aligned time; listen before moving.'
        : classification === 'probable_hallucination'
          ? 'No sound was detected near either position. This line may have been invented; hiding it can be undone.'
          : 'Sound alone cannot place these words. Listen and review; no automatic correction was made.'
    }
  })
}

export function applyTimingReview(
  segments: TimingSegment[], index: number, action: TimingReviewAction, suggestedStart?: number
): TimingSegment[] {
  if (!segments[index]) throw new Error('Line no longer exists')
  return segments.map((segment, i) => {
    if (i !== index) return { ...segment }
    if (action === 'hide' || action === 'show') return { ...segment, timingHidden: action === 'hide', timingReviewed: true }
    if (action === 'undo_move') {
      if (segment.timingOriginalStart === undefined) throw new Error('No move to undo')
      const { timingOriginalStart, timingOriginalEnd, ...rest } = segment
      return { ...rest, start: timingOriginalStart, end: timingOriginalEnd, timingReviewed: true }
    }
    if (suggestedStart === undefined || !Number.isFinite(suggestedStart) || suggestedStart < 0) throw new Error('No supported move')
    // The old end is also a model claim. Bound the new span by the next ordered line.
    const next = segments.slice(index + 1).find(s => !s.timingHidden && s.start > suggestedStart)?.start
    const duration = Math.max(0.6, countWords(segment.text) / 3)
    return { ...segment, start: suggestedStart, end: Math.min(suggestedStart + duration, next ?? Infinity),
      timingOriginalStart: segment.timingOriginalStart ?? segment.start,
      timingOriginalEnd: segment.timingOriginalEnd ?? segment.end, timingReviewed: true }
  })
}
