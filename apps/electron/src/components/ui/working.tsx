import { Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * What a loading or working state looks like, everywhere in the app.
 *
 * The owner, 2-oct-2026: "That should NOT be a text, it is a placeholder, an
 * animated background, an animated loader icon... something that gives the
 * idea of WORKING. That same experience is EVERYWHERE." So a state that waits
 * for content shows blocks in the shape of that content with a light band
 * crossing them, a spinner (a pulsing clock when it only waits its turn), and
 * a bar with the number when the progress is known. The words go to the
 * tooltip and to screen readers, never on screen.
 */

export type WorkingShape = 'lines' | 'list' | 'cards' | 'wave' | 'page' | 'block'

interface WorkingProps {
  /** What is happening, for the tooltip and screen readers: "Loading the library". */
  label: string
  /** The shape of the content that is coming. */
  shape?: WorkingShape
  /** How many lines, rows or cards to draw. */
  rows?: number
  /** 0-100 when known: adds a bar and the number. */
  progress?: number | null
  /** The work waits its turn (queued): a pulsing clock instead of the spinner. */
  waiting?: boolean
  className?: string
}

const LINE_WIDTHS = [92, 78, 86, 64, 88, 71, 80, 58, 90, 69]
const WAVE_HEIGHTS = Array.from({ length: 72 }, (_, i) =>
  Math.round(18 + 30 * Math.abs(Math.sin(i * 0.37)) * (0.55 + 0.45 * Math.abs(Math.cos(i * 0.11))))
)

/** A muted block with a light band crossing it. */
function Block({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      data-working-block
      className={cn('relative block overflow-hidden rounded bg-muted-foreground/15', className)}
      style={style}
    >
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/10 to-transparent motion-safe:animate-shimmer" />
    </span>
  )
}

function Shape({ shape, rows }: { shape: WorkingShape; rows: number }) {
  switch (shape) {
    case 'list':
      return (
        <div className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Block className="h-8 w-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Block className="h-3" style={{ width: `${LINE_WIDTHS[i % LINE_WIDTHS.length]}%` }} />
                <Block className="h-2.5 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )
    case 'cards':
      return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          {Array.from({ length: rows }, (_, i) => (
            <Block key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      )
    case 'wave':
      return (
        <div className="flex h-14 items-center gap-[2px]">
          {WAVE_HEIGHTS.map((h, i) => (
            <Block key={i} className="min-w-0 flex-1 rounded-sm" style={{ height: `${h}%` }} />
          ))}
        </div>
      )
    case 'page':
      return (
        <div className="space-y-4">
          <Block className="h-7 w-1/3" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Block key={i} className="h-20 rounded-lg" />
            ))}
          </div>
          <div className="space-y-2">
            {Array.from({ length: rows }, (_, i) => (
              <Block key={i} className="h-3" style={{ width: `${LINE_WIDTHS[i % LINE_WIDTHS.length]}%` }} />
            ))}
          </div>
        </div>
      )
    case 'block':
      return <Block className="h-24 w-full rounded-lg" />
    case 'lines':
    default:
      return (
        <div className="space-y-3">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Block className="h-3 w-12 shrink-0" />
              <Block className="h-3" style={{ width: `${LINE_WIDTHS[i % LINE_WIDTHS.length]}%` }} />
            </div>
          ))}
        </div>
      )
  }
}

export function Working({ label, shape = 'lines', rows = 5, progress = null, waiting = false, className }: WorkingProps) {
  const known = progress !== null && progress !== undefined && progress > 0
  const percent = known ? Math.min(100, Math.round(progress as number)) : null
  const name = percent !== null ? `${label}, ${percent}%` : label
  return (
    <div role="status" aria-label={name} title={name} className={cn('w-full py-3', className)}>
      <div className="mb-3 flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
        {waiting ? (
          <Clock className="h-4 w-4 motion-safe:animate-pulse" aria-hidden="true" />
        ) : (
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        )}
        {percent !== null && (
          <>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="h-full bg-yellow-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs font-medium tabular-nums" aria-hidden="true">{percent}%</span>
          </>
        )}
      </div>
      <Shape shape={shape} rows={rows} />
    </div>
  )
}

/** A single value that is still coming (a battery level, a count in a tile): a short shimmering bar. */
export function WorkingValue({ label, className }: { label: string; className?: string }) {
  return (
    <span role="status" aria-label={label} title={label} className={cn('inline-block align-middle', className ?? 'w-12')}>
      <Block className="h-[0.9em] w-full" />
    </span>
  )
}

/** A thin strip that moves while something runs in the background (a calendar sync, a lens loading). */
export function WorkingBar({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-label={label} title={label} className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}>
      <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-yellow-500/70 motion-safe:animate-shimmer" />
    </div>
  )
}

/** The icon a busy button or inline control shows in place of its own icon. */
export function BusyIcon({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 motion-safe:animate-spin', className)} aria-hidden="true" />
}
