/**
 * Sort keys of the Library list beyond the plain fields, and the direction each
 * one starts in when a column header is clicked. The header row and the
 * Filters & sort panel share them.
 */

import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { SortBy, SortOrder } from '@/store/useLibraryStore'
import type { LibraryError } from '@/features/library/utils/errorHandling'
import { getDisplayTitle } from './getDisplayTitle'
import { statusRank, transcriptionRank } from './rowState'

/** Keys whose value has to be worked out per recording (a title, a rank), not read from a field. */
const DERIVED: ReadonlySet<SortBy> = new Set<SortBy>(['name', 'stars', 'meeting', 'status', 'transcription'])

export function isDerivedSort(sortBy: SortBy): boolean {
  return DERIVED.has(sortBy)
}

/** The direction a column starts in: newest, longest, most stars and best first; titles A to Z; problems first. */
export function defaultSortOrder(sortBy: SortBy): SortOrder {
  switch (sortBy) {
    case 'date':
    case 'duration':
    case 'quality':
    case 'stars':
    case 'meeting':
      return 'desc'
    default:
      return 'asc'
  }
}

export interface SortContext {
  meeting?: Meeting
  transcript?: Transcript
  error?: LibraryError
}

/**
 * The value a derived key sorts on. Computed once per recording before the
 * sort, not inside the comparator: a title costs a lookup and a string build.
 */
export function derivedSortValue(sortBy: SortBy, recording: UnifiedRecording, ctx: SortContext): number | string {
  switch (sortBy) {
    case 'name':
      return getDisplayTitle(recording, ctx.meeting, ctx.transcript).primaryText.toLocaleLowerCase()
    case 'stars':
      return recording.evalStarLevel ?? 0
    case 'meeting':
      return recording.meetingId ? 1 : 0
    case 'status':
      return statusRank(recording, Boolean(ctx.error))
    case 'transcription':
      return transcriptionRank(recording, ctx.transcript)
    default:
      return 0
  }
}

/** Compare two derived values in the given direction; a title compares as text. */
export function compareDerived(a: number | string, b: number | string, order: SortOrder): number {
  const direction = order === 'asc' ? 1 : -1
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b) * direction
  return ((a as number) - (b as number)) * direction
}
