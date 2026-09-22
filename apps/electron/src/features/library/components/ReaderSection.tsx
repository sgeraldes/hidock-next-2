/**
 * ReaderSection — one section of the reader's single scrolling column.
 *
 * Three parts, in this order:
 *   1. A sentinel: SENTINEL_H tall with an equal negative bottom margin, so it
 *      covers the section's first SENTINEL_H pixels and adds no height of its
 *      own. Its crossings are what `useStickySectionPins` observes, and its
 *      height is the hysteresis band.
 *   2. The header strip: `position: sticky` at this section's place in the
 *      pinned stack, fixed height, and the ONLY thing that changes appearance
 *      when the section pins.
 *   3. The body, which keeps scrolling under the strip.
 *
 * The wrapper is `display: contents`, which is what makes the stacking work at
 * all. A sticky element cannot leave its containing block, so a header inside a
 * section box pins only while that box is on screen and then leaves with it —
 * measured in the running app on 2026-09-22, four of the five strips sat at
 * -1138, -1106, -863 and -716 pixels while the design called for 0, 32, 64 and
 * 96. With no box of its own, each header's containing block becomes the scroll
 * body and the strips pile up as intended. Every ancestor between here and
 * `reader-scroll-body` has to stay box-less for the same reason.
 *
 * Pinning deliberately does NOT collapse the body. Collapsing it would delete
 * the height it occupied, the browser would clamp scrollTop, the page would jump
 * up, the sentinel would re-enter view, and the section would unpin — the
 * oscillation that got scroll-driven pinning banned in the first place. Letting
 * the body scroll under a stuck strip gives the same result the user asked for
 * (what remains of the section on screen is its strip) with zero layout change.
 *
 * Spec: docs/superpowers/specs/2026-09-22-reader-sticky-sections-design.md
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SENTINEL_H } from '../hooks/useStickySectionPins'
import { ReaderSectionControls } from './ReaderSectionControls'
import type { ReaderSectionId, ReaderSectionMode } from '@/store/useLibraryStore'

interface ReaderSectionProps {
  section: ReaderSectionId
  label: string
  mode: ReaderSectionMode
  onModeChange: (mode: ReaderSectionMode) => void
  onMaximize: () => void
  maximized: boolean
  /** Stuck to the top right now. Presentation only; never written to the store. */
  pinned: boolean
  /** Offset in the pinned stack, or null when this section is past the budget
   *  and should scroll away instead of stacking. */
  stickyTop: number | null
  sentinelRef: (node: HTMLDivElement | null) => void
  /** Rendered to the right of the label, inside the strip, at strip height. */
  headerExtra?: ReactNode
  /**
   * Keep rendering the body when the user minimizes the section, because the
   * body has a compact presentation of its own. The player is the one that does:
   * `compact` turns its graph into a pill, and hiding it outright would leave a
   * minimized player with no way to press Play.
   */
  keepBodyWhenCompact?: boolean
  children?: ReactNode
  /** Extra classes for the body. The wrapper has no box to put them on. */
  className?: string
}

export function ReaderSection({
  section,
  label,
  mode,
  onModeChange,
  onMaximize,
  maximized,
  pinned,
  stickyTop,
  sentinelRef,
  headerExtra,
  keepBodyWhenCompact = false,
  children,
  className
}: ReaderSectionProps) {
  const open = mode !== 'compact' || keepBodyWhenCompact
  const stacks = stickyTop !== null

  return (
    <section
      className="contents"
      aria-label={label}
      data-testid={`reader-section-${section}`}
      data-pinned={pinned ? 'true' : 'false'}
    >
      <div
        ref={sentinelRef}
        aria-hidden="true"
        // In flow rather than absolute: `display: contents` on the wrapper
        // leaves nothing to position against. The negative margin cancels the
        // height again, so the band sits over the section's first pixels
        // without moving anything below it.
        className="pointer-events-none w-px"
        style={{ height: SENTINEL_H, marginBottom: -SENTINEL_H }}
        data-testid={`reader-sentinel-${section}`}
      />
      <div
        className={cn(
          // h-8 on the STRIP itself, not just on the controls inside it: with
          // border-box the 1px bottom border lives inside those 32px, so the
          // strip measures exactly PINNED_STRIP_H and the stack's `index * 32`
          // offsets land flush instead of drifting 1px per section.
          'z-20 flex h-8 items-center gap-2 px-4',
          stacks ? 'sticky' : 'relative',
          // The whole animation. Nothing here changes the box's size, so it
          // cannot move the content below. `motion-safe:` is the repo's existing
          // way of honouring prefers-reduced-motion (see ReaderPlayer).
          'motion-safe:transition-[background-color,box-shadow,border-color] motion-safe:duration-[180ms] motion-safe:ease-out',
          pinned
            ? 'border-b border-border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80'
            : 'border-b border-transparent bg-transparent'
        )}
        style={stacks ? { top: stickyTop } : undefined}
      >
        <ReaderSectionControls
          className="min-w-0 flex-1"
          section={section}
          label={label}
          mode={mode}
          onModeChange={onModeChange}
          onMaximize={onMaximize}
          maximized={maximized}
          pinned={pinned}
        />
        {headerExtra}
      </div>
      {open && (
        <div id={`reader-${section}-content`} className={cn('px-4 pb-3 pt-1', className)}>
          {children}
        </div>
      )}
    </section>
  )
}
