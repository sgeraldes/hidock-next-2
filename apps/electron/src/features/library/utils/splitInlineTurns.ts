/**
 * Render-time inline-turn splitting for LEGACY stored transcript segments.
 * The implementation lives in src/shared/inline-turns.ts, so the main process
 * computes the same turn positions the reader renders.
 */

import type { StoredSegment } from '../components/TranscriptViewer'
import { splitOnInlineTurns } from '@/shared/inline-turns'

/** Split one stored segment on any inline `[ts] Speaker N:` markers in its text. */
export function splitStoredSegmentOnInlineTurns(segment: StoredSegment): StoredSegment[] {
  return splitOnInlineTurns(segment)
}

/**
 * Expand a list of stored segments, splitting any legacy inline-marker segment
 * into its constituent turns. Well-formed segments pass through unchanged.
 */
export function expandInlineStoredSegments(segments: StoredSegment[]): StoredSegment[] {
  return segments.flatMap(splitStoredSegmentOnInlineTurns)
}
