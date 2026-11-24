import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { buildFindIndex, searchFindIndex, wrapFindIndex, type FindDocument, type FindMatch } from '../utils/transcriptFind'
import { formatTimestamp } from '../utils/formatTimestamp'
import { highlightRanges } from '../utils/highlightText'

export function isFindTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}
export interface ReaderFindSession { sourceId?: string; open: boolean; query: string; position: number }
export function useReaderFind({ sourceId, documents, onSeek, onReveal, enabled = true, session }: {
  sourceId?: string
  /** The documents, or a builder that runs only while the bar is open (keep its identity stable). */
  documents: FindDocument[] | (() => FindDocument[]); onSeek: (ms: number) => void
  onReveal?: (match: FindMatch) => void; enabled?: boolean; session?: MutableRefObject<ReaderFindSession>
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const saved = session && session.current.sourceId === sourceId ? session.current : undefined
  const [open, setOpen] = useState(saved?.open ?? false)
  const [query, updateQuery] = useState(saved?.query ?? '')
  const [position, setPosition] = useState(saved?.position ?? 0)
  // Normalizing every character costs real time on a long transcript: only
  // while the bar is open.
  const index = useMemo(() => buildFindIndex(enabled && open ? (typeof documents === 'function' ? documents() : documents) : []), [documents, enabled, open])
  const matches = useMemo(() => open ? searchFindIndex(index, query) : [], [index, query, open])
  const current = matches[Math.min(position, Math.max(0, matches.length - 1))]
  const byKey = useMemo(() => {
    const map = new Map<string, FindMatch[]>()
    for (const match of matches) {
      const list = map.get(match.key) ?? []
      list.push(match)
      map.set(match.key, list)
    }
    return map
  }, [matches])
  const setQuery = useCallback((value: string) => { updateQuery(value); setPosition(0) }, [])
  // The bar debounces typing; Enter first applies a query still waiting there.
  const flushPendingQuery = useRef<(() => boolean) | null>(null)
  const close = useCallback(() => { setOpen(false); updateQuery(''); setPosition(0) }, [])
  const previousSource = useRef(sourceId)
  useLayoutEffect(() => {
    if (previousSource.current !== sourceId) {
      previousSource.current = sourceId
      close()
      if (session) session.current = { sourceId, open: false, query: '', position: 0 }
    } else if (session) session.current = { sourceId, open, query, position }
  }, [sourceId, open, query, position, session, close])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  const callbacks = useRef({ onSeek, onReveal })
  callbacks.current = { onSeek, onReveal }
  useEffect(() => {
    if (!current) return
    callbacks.current.onReveal?.(current)
    const frame = requestAnimationFrame(() => {
      const marks = rootRef.current?.querySelectorAll<HTMLElement>('[data-find-current="true"]')
      marks?.[0]?.scrollIntoView({ block: 'center', behavior: 'auto' })
    })
    return () => cancelAnimationFrame(frame)
  }, [current])
  const move = useCallback((direction: number) => setPosition(p => wrapFindIndex(Math.min(p, Math.max(0, matches.length - 1)), direction, matches.length)), [matches.length])
  const seek = useCallback(() => { if (current?.timeMs != null) callbacks.current.onSeek(current.timeMs) }, [current])
  // Shift+Enter or Alt+Enter on a query still being typed: applied first, then
  // run once the new matches exist. Plain Enter just shows the first match.
  const afterQuery = useRef<'previous' | 'seek' | null>(null)
  useEffect(() => {
    const action = afterQuery.current
    if (!action) return
    afterQuery.current = null
    if (action === 'previous') move(-1)
    else seek()
  }, [matches, move, seek])
  useEffect(() => {
    if (!enabled || !sourceId) return
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const owner = event.target instanceof HTMLElement ? event.target.closest('[data-reader-find]') : null
      if (owner && owner !== rootRef.current) return
      const inFind = event.target === inputRef.current
      if (isFindTypingTarget(event.target) && !inFind) return
      // Keys go to find from its input, from inside this reader, or when nothing
      // has focus. A dialog or menu elsewhere keeps its own Escape.
      const target = event.target
      const inReader = target instanceof Node && !!rootRef.current?.contains(target)
      const unfocused = !(target instanceof Element) || target === document.body || target === document.documentElement
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation()
        window.dispatchEvent(new CustomEvent('hidock:reader-find-open', { detail: rootRef.current }))
        setOpen(true); inputRef.current?.focus(); inputRef.current?.select()
      } else if (open && (((event.key === 'Escape' || event.key === 'F3') && (inFind || inReader || unfocused)) || (event.key === 'Enter' && (inFind || (event.altKey && (inReader || unfocused)))))) {
        // Plain Enter belongs to the find input only: on a reader button it
        // activates the button. Alt+Enter seeks from anywhere in the reader.
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Enter' && flushPendingQuery.current?.()) {
          afterQuery.current = event.altKey ? 'seek' : event.shiftKey ? 'previous' : null
          return
        }
        if (event.key === 'Escape') close()
        else if (event.altKey && event.key === 'Enter') seek()
        else move(event.shiftKey ? -1 : 1)
      }
    }
    const openedElsewhere = (event: Event) => { if (!(event instanceof CustomEvent) || event.detail !== rootRef.current) close() }
    window.addEventListener('hidock:reader-find-open', openedElsewhere)
    window.addEventListener('keydown', handle, true)
    return () => {
      window.removeEventListener('keydown', handle, true)
      window.removeEventListener('hidock:reader-find-open', openedElsewhere)
    }
  }, [enabled, sourceId, open, close, move, seek])
  return { rootRef, inputRef, flushPendingQuery, open, query, setQuery, matches, current, position: Math.min(position, Math.max(0, matches.length - 1)), byKey, close, move, seek }
}
export type ReaderFindState = ReturnType<typeof useReaderFind>
const labels = { summary: 'Summary', moments: 'Actions & decisions', transcript: 'Transcript' }
export function ReaderFindBar({ find }: { find: ReaderFindState }) {
  // Keep draft keystrokes local: the large transcript rerenders only after debounce.
  const [draft, setDraft] = useState(find.query)
  const update = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef<string | null>(null)
  useEffect(() => { if (!find.open) { setDraft(''); clearTimeout(update.current); pending.current = null } }, [find.open])
  useEffect(() => () => clearTimeout(update.current), [])
  const { flushPendingQuery, setQuery, query } = find
  useEffect(() => {
    flushPendingQuery.current = () => {
      // Nothing waiting, or it is already the query: Enter acts at once.
      if (pending.current === null || pending.current === query) return false
      clearTimeout(update.current)
      setQuery(pending.current)
      pending.current = null
      return true
    }
    return () => { flushPendingQuery.current = null }
  }, [flushPendingQuery, setQuery, query])
  if (!find.open) return null
  return <div role="search" aria-label="Find in this source" className="sticky top-0 z-40 flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-3 py-2">
    <input ref={find.inputRef} aria-label="Find in transcript" placeholder="Find in transcript" value={draft}
      onChange={event => { const value = event.target.value; setDraft(value); pending.current = value; clearTimeout(update.current); update.current = setTimeout(() => { pending.current = null; find.setQuery(value) }, 120) }}
      className="min-w-24 flex-1 rounded border bg-background px-2 py-1 text-sm" />
    <span role="status" aria-live="polite" className="text-xs tabular-nums">{find.current ? find.position + 1 : 0} of {find.matches.length}{find.current && ` · ${labels[find.current.section]}`}</span>
    {find.current?.timeMs != null && <button type="button" aria-label={`Seek to ${formatTimestamp(find.current.timeMs / 1000)}`} onClick={find.seek} className="px-1 text-xs text-primary underline">{formatTimestamp(find.current.timeMs / 1000)}</button>}
    <button type="button" aria-label="Previous match" title="Previous (Shift+Enter / Shift+F3)" disabled={!find.matches.length} onClick={() => find.move(-1)} className="rounded p-1 hover:bg-accent disabled:opacity-40"><ChevronUp size={16} /></button>
    <button type="button" aria-label="Next match" title="Next (Enter / F3)" disabled={!find.matches.length} onClick={() => find.move(1)} className="rounded p-1 hover:bg-accent disabled:opacity-40"><ChevronDown size={16} /></button>
    <button type="button" aria-label="Close find" title="Close (Esc)" onClick={find.close} className="rounded p-1 hover:bg-accent"><X size={16} /></button>
  </div>
}
export function FindText({ find, documentKey, text }: { find?: ReaderFindState; documentKey: string; text: string }) {
  const ranges = find?.byKey.get(documentKey)
  if (!ranges?.length) return <>{text}</>
  return <Fragment>{highlightRanges(text, ranges, find?.current?.id)}</Fragment>
}
