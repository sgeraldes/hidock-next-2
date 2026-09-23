/**
 * How an action / decision / note reads, shared by the two places that draw one:
 * the numbered markers on the player's graph, and the reader's Actions &
 * decisions list.
 *
 * These used to live inside WaveformPlayer.tsx, where the list also lived. When
 * the list moved out on 2026-09-22 it kept importing them from there, and any
 * test that mocks WaveformPlayer broke the list with it. Shared values belong in
 * a module neither component owns.
 */

import { CheckSquare, GitBranch, StickyNote } from 'lucide-react'

export type TimelineEventKind = 'action' | 'decision' | 'note'

/** Marker accent per kind — actions vs decisions read as distinct colors. */
export const EVENT_KIND_COLOR: Record<TimelineEventKind, string> = {
  action: '#D97706', // amber-600
  decision: '#7C3AED', // violet-600
  note: '#64748B' // slate-500
}

export const EVENT_KIND_ICON = {
  action: CheckSquare,
  decision: GitBranch,
  note: StickyNote
} as const
