/**
 * useStickySectionPins — which reader sections are currently stuck to the top.
 *
 * THE SECOND LAYER. `readerSectionModes` in the store is what the user CHOSE
 * and is the only thing persisted. This hook derives a PRESENTATION from scroll
 * position and keeps it here, in component state, for exactly as long as the
 * reader is mounted. Scrolling never writes a mode: a section the user set to
 * `compact` or `hidden` stays that way when they scroll back up.
 *
 * Mechanics, and why they are these mechanics:
 *
 *  - No scroll listener. Each section owns an absolutely-positioned sentinel at
 *    its top edge; one IntersectionObserver per section watches it against the
 *    scroll container. The browser batches those callbacks off the scroll path,
 *    and there are two per section for a whole scroll pass rather than one per
 *    frame.
 *  - Hysteresis is the sentinel's own height (SENTINEL_H). The state flips only
 *    on a COMPLETE crossing: fully visible → in flow, fully past → pinned,
 *    anything in between keeps the previous value. A scroll jitter smaller than
 *    the sentinel therefore cannot make a section flicker in and out.
 *  - The pinned stack has a budget, because five strips stacked at the top would
 *    eat the reader. See MAX_PINNED_FRACTION.
 *
 * Spec: docs/superpowers/specs/2026-09-22-reader-sticky-sections-design.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReaderSectionId } from '@/store/useLibraryStore'

/**
 * Height of one section header strip, in px, pinned AND in flow.
 *
 * Constant on purpose. A sticky element keeps its space in the document flow,
 * so a strip that changed height when it stuck would shift everything below it
 * by the difference — the jump that got scroll-driven pinning banned the first
 * time. With a fixed height, pinning costs zero layout.
 *
 * 32px is a `Button size="sm"` (h-8) row with no extra vertical padding. It is
 * also what makes the five-section stack fit the budget below in a 534px
 * reader; at the previous 36px it needed 600px.
 */
export const PINNED_STRIP_H = 32

/**
 * The pinned stack may never take more than this share of the reader's visible
 * height. A third for the fixed header leaves two thirds for the text being
 * read. Sections past the cap scroll away normally instead of piling up.
 */
export const MAX_PINNED_FRACTION = 0.3

/** Sentinel height in px, which is also the hysteresis band. */
export const SENTINEL_H = 12

/** How many strips fit the budget for a reader of `height` px. */
export function pinnedStackBudget(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1
  const fits = Math.floor((height * MAX_PINNED_FRACTION) / PINNED_STRIP_H)
  return Math.min(5, Math.max(1, fits))
}

export interface StickySectionPins {
  /** Ref for the scrolling column; its height drives the budget. */
  scrollRef: (node: HTMLDivElement | null) => void
  /** Ref factory for a section's sentinel element. */
  sentinelRef: (section: ReaderSectionId) => (node: HTMLDivElement | null) => void
  /** Whether this section's strip is currently stuck to the top. */
  isPinned: (section: ReaderSectionId) => boolean
  /** `top` offset in px for this section's sticky strip, or null when it does
   *  not participate in the stack (past the budget). */
  stickyTop: (section: ReaderSectionId) => number | null
  /** How many strips currently fit. Exposed for tests and for the comment above. */
  budget: number
}

/**
 * @param order  Sections in document order, HIDDEN ONES ALREADY REMOVED. A
 *               hidden section takes no slot in the stack, so the one after it
 *               inherits its place.
 */
export function useStickySectionPins(order: ReaderSectionId[]): StickySectionPins {
  const [pinned, setPinned] = useState<Partial<Record<ReaderSectionId, boolean>>>({})
  const [height, setHeight] = useState(0)
  const scrollNodeRef = useRef<HTMLDivElement | null>(null)
  const sentinelNodes = useRef(new Map<ReaderSectionId, HTMLDivElement>())
  // Bumped whenever a sentinel is attached or detached. The summary and
  // transcript sections only mount once the transcript has loaded, which is
  // AFTER the observer effect first ran; without this they would register their
  // sentinel into the map and never be observed, so they would never pin.
  const [nodesVersion, setNodesVersion] = useState(0)

  const budget = pinnedStackBudget(height)

  // Stack position per section: index among the sections that participate.
  const tops = useMemo(() => {
    const map = new Map<ReaderSectionId, number | null>()
    order.forEach((section, index) => {
      map.set(section, index < budget ? index * PINNED_STRIP_H : null)
    })
    return map
  }, [order, budget])

  // The scroll column's height drives the budget. Measured with a
  // ResizeObserver, NOT in a scroll handler: it only changes when the window or
  // the panes are resized.
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollNodeRef.current = node
    if (node) setHeight(node.getBoundingClientRect().height)
  }, [])

  useEffect(() => {
    const node = scrollNodeRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeight(node.getBoundingClientRect().height))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  // One STABLE callback per section, cached. A fresh closure per render would
  // make React detach and re-attach the ref every render, and since attaching
  // bumps nodesVersion that is an infinite loop.
  const sentinelCallbacks = useRef(new Map<ReaderSectionId, (node: HTMLDivElement | null) => void>())
  const sentinelRef = useCallback((section: ReaderSectionId) => {
    let fn = sentinelCallbacks.current.get(section)
    if (!fn) {
      fn = (node: HTMLDivElement | null) => {
        if ((sentinelNodes.current.get(section) ?? null) === node) return
        if (node) sentinelNodes.current.set(section, node)
        else sentinelNodes.current.delete(section)
        setNodesVersion((v) => v + 1)
      }
      sentinelCallbacks.current.set(section, fn)
    }
    return fn
  }, [])

  // One observer per section. rootMargin pulls the top edge down to the line
  // where THIS section's strip comes to rest, so "past the sentinel" means
  // exactly "the strip has reached its resting place".
  const orderKey = order.join(',')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const root = scrollNodeRef.current
    const observers: IntersectionObserver[] = []

    for (const section of order) {
      const node = sentinelNodes.current.get(section)
      const top = tops.get(section) ?? null
      if (!node || top === null) {
        // Not participating: make sure it is not left stuck from a bigger reader.
        setPinned((prev) => (prev[section] ? { ...prev, [section]: false } : prev))
        continue
      }
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            // Complete crossings only — the in-between band is the hysteresis.
            const next =
              entry.intersectionRatio >= 1 ? false : !entry.isIntersecting ? true : undefined
            if (next === undefined) continue
            setPinned((prev) => (prev[section] === next ? prev : { ...prev, [section]: next }))
          }
        },
        { root: root ?? null, rootMargin: `-${top}px 0px 0px 0px`, threshold: [0, 1] }
      )
      observer.observe(node)
      observers.push(observer)
    }

    return () => observers.forEach((o) => o.disconnect())
    // `orderKey` stands in for `order`, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, budget, tops, nodesVersion])

  const isPinned = useCallback(
    (section: ReaderSectionId) => (tops.get(section) ?? null) !== null && pinned[section] === true,
    [pinned, tops]
  )

  const stickyTop = useCallback((section: ReaderSectionId) => tops.get(section) ?? null, [tops])

  return { scrollRef, sentinelRef, isPinned, stickyTop, budget }
}
