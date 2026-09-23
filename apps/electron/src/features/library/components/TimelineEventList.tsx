/**
 * TimelineEventList - the reader's actions, decisions and notes.
 *
 * Extracted from WaveformPlayer's full-mode timeline on 2026-09-22 so it can be
 * its own reader section. It used to live inside the graph, which meant it only
 * existed while the player was expanded, and a long list had to be capped at
 * `max-h-40` with its own inner scrollbar so it could not push the docked
 * essentials off-screen. As a section of the one scrolling column it has neither
 * problem: it scrolls with everything else and survives any player mode.
 *
 * The numbered markers stay on the graph. Cross-highlighting between a marker
 * and its row still works because SourceReader owns `activeEventId` and hands it
 * to both.
 *
 * This list does NOT filter by the recording duration. The graph's markers must
 * (they are positioned on a time axis, and a duration of 0 has no axis), but a
 * list of what was decided is readable before any duration is known.
 *
 * Spec: docs/superpowers/specs/2026-09-22-reader-sticky-sections-design.md
 */

import { useEffect, useState } from 'react'
import { ChevronDown, Pencil, CircleCheck, CircleDashed } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTimestamp } from '@/utils/audioUtils'
import { cn } from '@/lib/utils'
import { EVENT_KIND_COLOR, EVENT_KIND_ICON } from '../utils/timelineEventKinds'
import type { TimelineEvent, TimelineEventDetail, TimelineEventPatch } from './WaveformPlayer'

interface TimelineEventListProps {
  events: TimelineEvent[]
  eventDetails?: Record<string, TimelineEventDetail>
  onEventUpdate?: (event: TimelineEvent, patch: TimelineEventPatch) => Promise<boolean>
  /** Highlighted event id, owned by the reader and shared with the graph. */
  activeEventId?: string | null
  /** Seek to this event and highlight it in both places. */
  onActivate: (event: TimelineEvent) => void
  /** Resets the transient expand/edit state when the reader changes recording. */
  recordingId?: string
  className?: string
}

export function TimelineEventList({
  events,
  eventDetails,
  onEventUpdate,
  activeEventId = null,
  onActivate,
  recordingId,
  className
}: TimelineEventListProps) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  useEffect(() => {
    setExpandedEventId(null)
    setEditingEventId(null)
  }, [recordingId])

  if (events.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground" data-testid="timeline-events-empty">
        No actions or decisions were extracted from this recording.
      </p>
    )
  }

  return (
    <div className={cn('min-w-0', className)}>
      <TooltipProvider delayDuration={300}>
        <ul className="space-y-0.5" data-testid="timeline-events">
          {events.map((m) => {
            const kind = m.kind ?? 'note'
            const Icon = EVENT_KIND_ICON[kind]
            const isActive = activeEventId === m.id
            const detail = eventDetails?.[m.refId ?? m.id]
            const displayText = detail?.fullText ?? (m.label || `${kind} at ${formatTimestamp(m.timeSec)}`)
            const isExpanded = expandedEventId === m.id
            const isEditing = editingEventId === m.id
            const isCompleted = detail?.status === 'completed'
            const tooltipLines = [
              displayText,
              detail?.assignee ? `Assignee: ${detail.assignee}` : null,
              detail?.dueDate ? `Due: ${detail.dueDate}` : null,
              detail?.status ? `Status: ${detail.status}` : null
            ].filter(Boolean) as string[]
            return (
              <li key={m.id}>
                <div
                  className={cn(
                    'rounded transition-colors',
                    isActive ? 'bg-primary/10' : 'hover:bg-muted/60'
                  )}
                >
                  <div className="flex items-start gap-2 px-1.5 py-1">
                    <button
                      type="button"
                      onClick={() => setExpandedEventId(isExpanded ? null : m.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for item ${m.index ?? ''}`}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      <span
                        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                        style={{ backgroundColor: EVENT_KIND_COLOR[kind] }}
                      >
                        {m.index ?? ''}
                      </span>
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {isEditing ? (
                        <span className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                          <Textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            rows={3}
                            className="text-xs"
                            aria-label={`Edit item ${m.index ?? ''} text`}
                          />
                          <span className="mt-1.5 flex items-center gap-2">
                            <Button
                              size="sm"
                              className="h-6 px-2 text-xs"
                              disabled={editSaving || !editDraft.trim()}
                              onClick={() => {
                                setEditSaving(true)
                                void onEventUpdate?.(m, { content: editDraft.trim() }).then((ok) => {
                                  setEditSaving(false)
                                  if (ok) setEditingEventId(null)
                                })
                              }}
                            >
                              {editSaving ? 'Saving…' : 'Save'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              disabled={editSaving}
                              onClick={() => setEditingEventId(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        </span>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                'min-w-0 flex-1 whitespace-normal break-words leading-snug',
                                isCompleted && 'line-through text-muted-foreground'
                              )}
                            >
                              {displayText}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start" className="max-w-md">
                            {tooltipLines.map((line, i) => (
                              <p key={i} className={i === 0 ? 'whitespace-pre-wrap' : 'text-xs text-muted-foreground'}>
                                {line}
                              </p>
                            ))}
                            {!detail && <p className="text-xs text-muted-foreground">Click to seek; details unavailable</p>}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {!isEditing && (
                        <ChevronDown
                          className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-180')}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onActivate(m)}
                      aria-pressed={isActive}
                      title={`Seek to ${formatTimestamp(m.timeSec)}`}
                      className="shrink-0 rounded px-1 tabular-nums text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {formatTimestamp(m.timeSec)}
                    </button>
                  </div>
                  {isExpanded && !isEditing && (
                    <div className="space-y-2 px-1.5 pb-2 pl-9 text-xs" data-testid={`event-detail-${m.id}`}>
                      {detail?.context && (
                        <p className="whitespace-pre-wrap text-muted-foreground">
                          <span className="font-medium text-foreground">Context: </span>
                          {detail.context}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                        <span className="font-medium text-foreground capitalize">{kind}</span>
                        {detail?.status && <span>Status: <span className="capitalize">{detail.status.replace('_', ' ')}</span></span>}
                        {detail?.assignee && <span>Assignee: {detail.assignee}</span>}
                        {detail?.dueDate && <span>Due: {detail.dueDate}</span>}
                        {detail?.priority && <span>Priority: <span className="capitalize">{detail.priority}</span></span>}
                        {!detail?.editable && <span className="italic">Read-only item</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          onClick={() => onActivate(m)}
                        >
                          Seek to {formatTimestamp(m.timeSec)}
                        </Button>
                        {detail?.editable && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 gap-1 px-2 text-xs"
                            onClick={() => {
                              setEditDraft(displayText)
                              setEditingEventId(m.id)
                            }}
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                            Edit
                          </Button>
                        )}
                        {detail?.editable && kind === 'action' && detail?.status && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 gap-1 px-2 text-xs"
                            onClick={() => {
                              const next = isCompleted ? 'pending' : 'completed'
                              void onEventUpdate?.(m, { status: next })
                            }}
                          >
                            {isCompleted ? (
                              <><CircleDashed className="h-3 w-3" aria-hidden="true" /> Reopen</>
                            ) : (
                              <><CircleCheck className="h-3 w-3" aria-hidden="true" /> Mark complete</>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </TooltipProvider>
    </div>
  )
}
