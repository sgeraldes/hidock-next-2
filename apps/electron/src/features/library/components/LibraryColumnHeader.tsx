import type { ReactNode } from 'react'
import { Calendar, ChevronDown, ChevronUp, FileText, HardDrive } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SortBy, SortOrder } from '@/store/useLibraryStore'
import { COLUMN_HEADER_HEIGHT_PX, COLUMN_WIDTH, PLACE_WIDTH, type PlaceName } from './libraryColumns'

interface LibraryColumnHeaderProps {
  sortBy: SortBy
  sortOrder: SortOrder
  onSort: (sortBy: SortBy) => void
}

interface ColumnProps {
  sortKey: SortBy
  active: boolean
  order: SortOrder
  onSort: (sortBy: SortBy) => void
}

/** A text column: the name, and an arrow while the list is sorted by it. */
function TextColumn({
  sortKey,
  label,
  hint,
  align = 'left',
  arrow = true,
  active,
  order,
  onSort
}: ColumnProps & { label: string; hint: string; align?: 'left' | 'right'; arrow?: boolean }) {
  const Arrow = order === 'asc' ? ChevronUp : ChevronDown
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          aria-pressed={active}
          aria-label={`Sort by ${label}`}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-0.5 rounded px-0.5 font-medium uppercase tracking-wide transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            align === 'right' && 'w-full justify-end',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          data-sort-key={sortKey}
        >
          <span className="truncate">{label}</span>
          {active && arrow && <Arrow className="h-3 w-3 shrink-0" aria-hidden="true" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{hint}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/** An icon column: the icon the rows use in that place, over a cell as wide as the place. */
function IconColumn({
  sortKey,
  icon,
  title,
  hint,
  active,
  order,
  onSort
}: ColumnProps & { icon: ReactNode; title: string; hint: string }) {
  const Arrow = order === 'asc' ? ChevronUp : ChevronDown
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          aria-pressed={active}
          aria-label={`Sort by ${title}`}
          className={cn(
            'relative flex h-6 shrink-0 items-center justify-center rounded transition-colors',
            PLACE_WIDTH[sortKey as PlaceName],
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          data-sort-key={sortKey}
        >
          {icon}
          {active && <Arrow className="absolute -bottom-0.5 h-2.5 w-2.5" aria-hidden="true" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The header of the wide list: one cell over each column of a row, in the same
 * widths, so it names what the column holds. Clicking a cell sorts the list by
 * that column; clicking it again turns the order around. The three icon cells
 * show the icon the rows use in that place, and their tooltips say what it can
 * mean (owner, 30-sep-2026: "a header with each one as reference").
 */
export function LibraryColumnHeader({ sortBy, sortOrder, onSort }: LibraryColumnHeaderProps) {
  const col = (key: SortBy): ColumnProps => ({ sortKey: key, active: sortBy === key, order: sortOrder, onSort })
  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="group"
        aria-label="Sort the list by column"
        className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-border bg-background px-3 text-[11px] leading-none select-none"
        style={{ height: COLUMN_HEADER_HEIGHT_PX }}
        data-testid="library-column-header"
      >
        <div className="min-w-0 flex-1">
          <TextColumn {...col('name')} label="Title" hint="Sort by title" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={COLUMN_WIDTH.date}>
            <TextColumn {...col('date')} label="Date" hint="Sort by date and time recorded" />
          </span>
          <span className={COLUMN_WIDTH.time}>
            <TextColumn {...col('date')} label="Time" hint="Sort by date and time recorded" align="right" arrow={false} />
          </span>
          <span className={COLUMN_WIDTH.duration}>
            <TextColumn {...col('duration')} label="Length" hint="Sort by length of the recording" align="right" />
          </span>
          <span className={cn('ml-2', COLUMN_WIDTH.chips)}>
            <TextColumn {...col('stars')} label="Rating" hint="Sort by stars. The chips also show the kind of recording, the audio check and a low value." />
          </span>
          <IconColumn
            {...col('meeting')}
            icon={<Calendar className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Calendar meeting"
            hint="The recording is linked to a meeting on your calendar. Sorts linked recordings first."
          />
          <IconColumn
            {...col('status')}
            icon={<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />}
            title="File status"
            hint="Where the file is: on the device only, downloaded, or both. A download from the device shows its percentage here, and a processing error takes this place. Sorts errors first."
          />
          <IconColumn
            {...col('transcription')}
            icon={<FileText className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Transcript"
            hint="Whether it is transcribed. A running transcription shows its percentage here. A problem with the transcript (wrong timing, text that does not fit the audio, text that may be invented or missing) takes this place. Sorts problems first."
          />
          <span className="h-6 w-6" aria-hidden="true" />
        </div>
      </div>
    </TooltipProvider>
  )
}
