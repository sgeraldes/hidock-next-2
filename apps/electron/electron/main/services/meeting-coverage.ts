/**
 * How much of a recording a meeting covers: the one rule the time-only linkers
 * share (the time-overlap pass in org-reconciler and recheckTimeLinks).
 *
 * A recording may start up to EARLY_START_TOLERANCE_MS before its meeting (the
 * owner joins early), so the meeting counts from that much earlier. A time-only
 * link needs the meeting to cover at least MIN_TIME_LINK_COVERAGE of the
 * recording: a 4-hour recording that holds lunch and three other meetings is
 * not "the lunch" (owner, 2-oct-2026). The transcript match decides those.
 */

/** Allow a recording to start this many ms before the meeting does. */
export const EARLY_START_TOLERANCE_MS = 15 * 60 * 1000

/** Share of the recording a meeting must cover for a link chosen only from the clock. */
export const MIN_TIME_LINK_COVERAGE = 0.5

/**
 * Share of [recStart, recEnd] inside the meeting, the meeting extended back by
 * the early-start tolerance. A recording with no length counts as covered when
 * it starts inside that window.
 */
export function meetingCoverage(
  recStart: number,
  recEnd: number,
  meetingStart: number,
  meetingEnd: number,
  earlyStartToleranceMs = EARLY_START_TOLERANCE_MS
): number {
  if (!Number.isFinite(recStart) || !Number.isFinite(meetingStart) || !Number.isFinite(meetingEnd)) return 0
  const from = meetingStart - earlyStartToleranceMs
  if (!(recEnd > recStart)) return recStart >= from && recStart < meetingEnd ? 1 : 0
  const overlap = Math.max(0, Math.min(recEnd, meetingEnd) - Math.max(recStart, from))
  return overlap / (recEnd - recStart)
}
