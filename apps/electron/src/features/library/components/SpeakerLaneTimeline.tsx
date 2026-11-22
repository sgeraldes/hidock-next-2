/**
 * SpeakerLaneTimeline
 *
 * One time row per speaker, drawn from the persisted speaker ranges the reader
 * already derives (`deriveSpeakerRanges`). It is NOT the physical per-channel
 * waveform: lanes are keyed by the resolved speaker key only, never by stereo
 * channel, and a label that has no resolved name stays exactly as stored
 * (an ID such as "Voice CAE244" is never turned into Mic, System or a person).
 *
 * Nothing here is estimated. Every interval is one stored range, clamped to the
 * recording; a range with a non-finite bound or no width after clamping is
 * dropped rather than repaired. The only figure shown per speaker is how many
 * stored turns it has.
 *
 * Action and decision events draw as thin dotted numbered lines across the lanes,
 * at the timestamp the caller passes. Events that land on the same moment are
 * spread sideways by a few pixels so each stays a separate, reachable line.
 *
 * Exports only the component so a hot reload of this file stays a component
 * boundary.
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { DerivedSpeakerRange, SpeakerLegendEntry } from '@/features/library/utils/speakerRanges'

interface LaneEvent {
  id: string
  /** The number shown on the line; matches the action row and chip. */
  number: number
  /** Real timestamp of the item, in seconds. */
  timeSec: number
  kind: 'action' | 'decision' | 'note'
  label?: string
}

interface SpeakerLaneTimelineProps {
  ranges: readonly DerivedSpeakerRange[]
  /** Optional lane order, names and colors; ranges alone are enough. */
  legend?: readonly SpeakerLegendEntry[]
  /** Recording length in seconds. When unknown (<= 0) the axis ends at the last stored range. */
  durationSec: number
  /** Playhead in seconds; the turn under it is marked. Omit when nothing is playing. */
  activeTimeSec?: number
  /** Called with the turn's start and end in milliseconds. */
  onSeek: (startMs: number, endMs?: number) => void
  /** Timed actions and decisions, drawn as numbered dotted lines. */
  events?: readonly LaneEvent[]
  /** The line to emphasise (hovered or focused action row or chip). */
  highlightedEventId?: string | null
  onEventHover?: (id: string | null) => void
  onEventActivate?: (id: string) => void
  className?: string
}

interface LaneInterval {
  startSec: number
  endSec: number
}

interface Lane {
  key: string
  name: string
  color: string
  intervals: LaneInterval[]
}

const RULER_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const
const LABEL_COLUMN = '9.5rem'
const COLUMN_GAP = '0.75rem'
const COINCIDENT_WITHIN_SEC = 1
const COINCIDENT_SPREAD_PX = 10
const EVENT_COLOR: Record<LaneEvent['kind'], string> = {
  action: '#D97706',
  decision: '#7C3AED',
  note: '#64748B'
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

function buildLanes(
  ranges: readonly DerivedSpeakerRange[],
  legend: readonly SpeakerLegendEntry[] | undefined,
  durationSec: number
): { lanes: Lane[]; axisSec: number } {
  const finite = ranges.filter(
    (r) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec)
  )
  const knownDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const axisSec = knownDuration || finite.reduce((max, r) => Math.max(max, r.endSec), 0)
  if (!(axisSec > 0)) return { lanes: [], axisSec: 0 }

  const byKey = new Map<string, Lane>()
  const legendByKey = new Map((legend ?? []).map((entry) => [entry.speakerKey, entry]))

  for (const range of finite) {
    const startSec = Math.min(Math.max(range.startSec, 0), axisSec)
    const endSec = Math.min(Math.max(range.endSec, 0), axisSec)
    if (!(endSec > startSec)) continue
    let lane = byKey.get(range.speakerKey)
    if (!lane) {
      const entry = legendByKey.get(range.speakerKey)
      lane = {
        key: range.speakerKey,
        name: entry?.name || range.name,
        color: entry?.color || range.color,
        intervals: []
      }
      byKey.set(range.speakerKey, lane)
    }
    lane.intervals.push({ startSec, endSec })
  }

  const lanes = Array.from(byKey.values())
  if (legend && legend.length > 0) {
    const order = new Map(legend.map((entry, index) => [entry.speakerKey, index]))
    lanes.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity))
  }
  for (const lane of lanes) lane.intervals.sort((a, b) => a.startSec - b.startSec)
  return { lanes, axisSec }
}

interface PlacedEvent extends LaneEvent {
  /** Sideways offset in px that keeps events on the same moment apart. */
  shiftPx: number
}

function placeEvents(events: readonly LaneEvent[] | undefined, axisSec: number): PlacedEvent[] {
  if (!events || axisSec <= 0) return []
  const valid = events
    .filter((e) => Number.isFinite(e.timeSec) && e.timeSec >= 0 && e.timeSec <= axisSec)
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec || a.number - b.number)

  const placed: PlacedEvent[] = []
  let cluster: LaneEvent[] = []
  const flush = () => {
    cluster.forEach((event, rank) => {
      placed.push({ ...event, shiftPx: (rank - (cluster.length - 1) / 2) * COINCIDENT_SPREAD_PX })
    })
    cluster = []
  }
  for (const event of valid) {
    const previous = cluster[cluster.length - 1]
    if (previous && event.timeSec - previous.timeSec >= COINCIDENT_WITHIN_SEC) flush()
    cluster.push(event)
  }
  flush()
  return placed
}

export function SpeakerLaneTimeline({
  ranges,
  legend,
  durationSec,
  activeTimeSec,
  onSeek,
  events,
  highlightedEventId = null,
  onEventHover,
  onEventActivate,
  className
}: SpeakerLaneTimelineProps) {
  const { lanes, axisSec } = useMemo(
    () => buildLanes(ranges, legend, durationSec),
    [ranges, legend, durationSec]
  )
  const placedEvents = useMemo(() => placeEvents(events, axisSec), [events, axisSec])
  if (lanes.length === 0) return null

  return (
    <section
      aria-label="Speakers by time"
      className={cn('space-y-1.5', className)}
      data-testid="speaker-lane-timeline"
    >
      <h3 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        Speakers
        <span className="text-xs font-normal text-muted-foreground">{lanes.length}</span>
      </h3>
      <div
        aria-hidden="true"
        className="flex justify-between text-[11px] tabular-nums text-muted-foreground"
        style={{ marginLeft: `calc(${LABEL_COLUMN} + ${COLUMN_GAP})` }}
        data-testid="speaker-lane-ruler"
      >
        {RULER_FRACTIONS.map((fraction) => (
          <span key={fraction}>{clock(axisSec * fraction)}</span>
        ))}
      </div>
      <div className="relative">
        <div
          className="grid items-center gap-y-1"
          style={{ gridTemplateColumns: `${LABEL_COLUMN} minmax(0, 1fr)`, columnGap: COLUMN_GAP }}
        >
          {lanes.map((lane) => {
            const turns = lane.intervals.length
            return (
              <div key={lane.key} className="contents" data-testid="speaker-lane" data-speaker-key={lane.key}>
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: lane.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-xs text-foreground" title={lane.name}>
                    {`${lane.name} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`}
                  </span>
                </div>
                <div
                  role="group"
                  aria-label={`${lane.name}: ${turns} ${turns === 1 ? 'turn' : 'turns'}`}
                  className="relative h-4 overflow-hidden rounded-sm bg-muted/60"
                >
                  {lane.intervals.map((interval) => {
                    const active =
                      activeTimeSec !== undefined &&
                      activeTimeSec >= interval.startSec &&
                      activeTimeSec < interval.endSec
                    return (
                      <button
                        key={`${interval.startSec}-${interval.endSec}`}
                        type="button"
                        onClick={() =>
                          onSeek(Math.round(interval.startSec * 1000), Math.round(interval.endSec * 1000))
                        }
                        aria-label={`Seek to ${lane.name} at ${clock(interval.startSec)}`}
                        title={`${lane.name} · ${clock(interval.startSec)}–${clock(interval.endSec)}`}
                        data-testid="speaker-turn"
                        data-active={active ? 'true' : undefined}
                        className={cn(
                          'absolute top-[18%] h-[64%] min-w-[2px] rounded-sm opacity-90 transition-[filter] hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                          active && 'opacity-100 ring-1 ring-foreground'
                        )}
                        style={{
                          left: `${(interval.startSec / axisSec) * 100}%`,
                          width: `${((interval.endSec - interval.startSec) / axisSec) * 100}%`,
                          backgroundColor: lane.color
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        {placedEvents.length > 0 && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0"
            style={{ left: `calc(${LABEL_COLUMN} + ${COLUMN_GAP})` }}
            data-testid="speaker-event-layer"
          >
            {placedEvents.map((event) => {
              const highlighted = highlightedEventId === event.id
              const color = EVENT_COLOR[event.kind]
              const noun = event.kind === 'decision' ? 'Decision' : event.kind === 'note' ? 'Note' : 'Action'
              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onEventActivate?.(event.id)}
                  onPointerEnter={() => onEventHover?.(event.id)}
                  onPointerLeave={() => onEventHover?.(null)}
                  onFocus={() => onEventHover?.(event.id)}
                  onBlur={() => onEventHover?.(null)}
                  aria-label={`${noun} ${event.number} at ${clock(event.timeSec)}`}
                  title={`${noun} ${event.number} · ${clock(event.timeSec)}${event.label ? ` · ${event.label}` : ''}`}
                  data-testid="speaker-event-line"
                  data-event-id={event.id}
                  data-highlighted={highlighted ? 'true' : undefined}
                  className="pointer-events-auto absolute inset-y-0 w-2 -translate-x-1/2 cursor-pointer focus-visible:outline-hidden"
                  style={{ left: `${(event.timeSec / axisSec) * 100}%`, marginLeft: event.shiftPx }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-1/2 -translate-x-1/2"
                    style={{
                      borderLeft: `${highlighted ? 2 : 1}px ${highlighted ? 'solid' : 'dotted'} ${color}`
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute -top-1 left-1/2 flex h-3.5 min-w-[0.875rem] -translate-x-1/2 items-center justify-center rounded-full border bg-background px-0.5 text-[9px] font-bold leading-none',
                      highlighted && 'scale-125 ring-2 ring-foreground/70'
                    )}
                    style={{ borderColor: color, color }}
                  >
                    {event.number}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
