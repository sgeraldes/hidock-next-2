import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, EyeOff, Maximize2, Minimize2, PanelTop, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ReaderSectionId, ReaderSectionMode } from '@/store/useLibraryStore'

const ICON_BUTTON = 'h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground'

/**
 * One icon button with an accessible name and a hover/focus tooltip that says
 * the same thing. Icon-only controls get both: the name for screen readers and
 * tests, the tooltip for a sighted user who does not know the icon.
 */
function IconAction({
  label,
  onClick,
  children,
  testId
}: {
  label: string
  onClick: () => void
  children: ReactNode
  testId?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-2 py-1 text-xs">{label}</TooltipContent>
    </Tooltip>
  )
}

interface ReaderSectionActionsProps {
  section: ReaderSectionId
  label: string
  mode: ReaderSectionMode
  onModeChange: (mode: ReaderSectionMode) => void
  onMaximize: () => void
  maximized?: boolean
  /** Presentation only, mirrored as data-pinned. Never implies a mode. */
  pinned?: boolean
  /** Overrides the default `reader-<section>-actions` test id. */
  testId?: string
  className?: string
}

/**
 * The icon-only controls every reader section carries, in this order:
 *
 *   [Layout menu] [minimize or expand] [maximize] [hide]
 *
 * Layout is the full menu and keeps Dock, which has no quick icon. The three
 * after it are the one-click section modes asked for on 2026-09-22, so a
 * section can be expanded from its pinned strip without scrolling back up to
 * it. All of them go through the callbacks the reader passes in, which call the
 * existing store actions; nothing here owns state.
 *
 * The player renders this row next to its 1x speed selector, outside the
 * player's own box. Every other section renders it at the right of its strip.
 */
export function ReaderSectionActions({
  section,
  label,
  mode,
  onModeChange,
  onMaximize,
  maximized = false,
  pinned = false,
  testId,
  className
}: ReaderSectionActionsProps) {
  const open = mode === 'expanded' || mode === 'docked'
  const layoutLabel = `Layout options for ${label}`

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn('flex shrink-0 items-center gap-0.5', className)}
        role="group"
        aria-label={`${label} section controls`}
        data-testid={testId ?? `reader-${section}-actions`}
        data-pinned={pinned ? 'true' : 'false'}
      >
        {maximized ? (
          <IconAction label={`Return ${label} to reader`} onClick={onMaximize} testId={`reader-${section}-restore`}>
            <Minimize2 className="h-4 w-4" />
          </IconAction>
        ) : (
          <>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={ICON_BUTTON}
                      aria-label={layoutLabel}
                      data-testid={`reader-${section}-layout`}
                    >
                      <PanelTop className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="px-2 py-1 text-xs">{layoutLabel}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => onModeChange('expanded')} disabled={mode === 'expanded'}>
                  <Square className="h-4 w-4" />
                  Expand
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onModeChange('compact')} disabled={mode === 'compact'}>
                  <ChevronRight className="h-4 w-4" />
                  Minimize
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onModeChange('docked')} disabled={mode === 'docked'}>
                  <PanelTop className="h-4 w-4" />
                  {section === 'player' ? 'Dock small player' : 'Dock to top'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onMaximize}>
                  <Maximize2 className="h-4 w-4" />
                  Maximize section
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onModeChange('hidden')} className="text-muted-foreground">
                  <EyeOff className="h-4 w-4" />
                  Hide section
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <IconAction
              label={open ? `Minimize ${label}` : `Expand ${label}`}
              onClick={() => onModeChange(open ? 'compact' : 'expanded')}
              testId={`reader-${section}-toggle`}
            >
              {open ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
            </IconAction>
            <IconAction label={`Maximize ${label}`} onClick={onMaximize} testId={`reader-${section}-maximize`}>
              <Maximize2 className="h-4 w-4" />
            </IconAction>
            <IconAction label={`Hide ${label}`} onClick={() => onModeChange('hidden')} testId={`reader-${section}-hide`}>
              <EyeOff className="h-4 w-4" />
            </IconAction>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}

interface ReaderSectionControlsProps {
  section: ReaderSectionId
  label: string
  mode: ReaderSectionMode
  onModeChange: (mode: ReaderSectionMode) => void
  onMaximize: () => void
  maximized?: boolean
  /** The strip is currently stuck to the top of the reader. Presentation only —
   *  it never implies anything about `mode`, which is the user's own choice. */
  pinned?: boolean
  className?: string
}

/**
 * The content of a labeled section strip: the label, which also toggles
 * minimize and expand, then the icon row. There is no mode pill any more: the
 * chevron already says whether the section is open, and the pill spent width
 * on a word.
 */
export function ReaderSectionControls({
  section,
  label,
  mode,
  onModeChange,
  onMaximize,
  maximized = false,
  pinned = false,
  className
}: ReaderSectionControlsProps) {
  const expanded = mode === 'expanded' || mode === 'docked'

  return (
    <div
      // FIXED height, pinned or not (PINNED_STRIP_H, set by the strip around
      // this row). A sticky element keeps its space in the flow, so a strip that
      // grew or shrank on pinning would shift everything below it. Constant
      // height means pinning costs zero layout.
      className={cn('flex h-full min-h-8 items-center gap-1.5', className)}
      data-testid={`reader-${section}-controls`}
      data-pinned={pinned ? 'true' : 'false'}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold text-foreground hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        onClick={() => onModeChange(expanded ? 'compact' : 'expanded')}
        aria-expanded={expanded}
        aria-controls={`reader-${section}-content`}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="truncate">{label}</span>
      </button>

      <ReaderSectionActions
        section={section}
        label={label}
        mode={mode}
        onModeChange={onModeChange}
        onMaximize={onMaximize}
        maximized={maximized}
        pinned={pinned}
      />
    </div>
  )
}

interface HiddenReaderSectionsProps {
  hidden: Array<{ id: ReaderSectionId; label: string }>
  onRestore: (section: ReaderSectionId) => void
}

export function HiddenReaderSections({ hidden, onRestore }: HiddenReaderSectionsProps) {
  if (hidden.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-4 py-1.5 text-xs" data-testid="reader-hidden-sections">
      <span className="mr-1 text-muted-foreground">Hidden</span>
      {hidden.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onRestore(id)}
          className="rounded-full border bg-background px-2.5 py-1 font-medium text-foreground hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          Show {label}
        </button>
      ))}
    </div>
  )
}
