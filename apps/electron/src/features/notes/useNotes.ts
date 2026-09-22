/**
 * The state behind the notes page.
 *
 * The one rule everything else follows from: typing never waits for anything.
 * The editor holds the text, a debounce writes it, and the analysis runs long
 * after the person stopped caring about it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Note, NoteMeetingSuggestion, NoteRelatedItem } from '@/types/notes'

/** Long enough that a normal sentence is one write, short enough to feel safe. */
export const SAVE_DEBOUNCE_MS = 800
/**
 * How long a note must sit still before it is worth paying a model to read it.
 * A note edited ten times in two minutes would otherwise buy ten analyses.
 */
export const ANALYZE_IDLE_MS = 30_000

export interface NotesState {
  notes: Note[]
  selected: Note | null
  draft: string
  saving: boolean
  search: string
  related: NoteRelatedItem[]
  suggestions: NoteMeetingSuggestion[]
}

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [related, setRelated] = useState<NoteRelatedItem[]>([])
  const [suggestions, setSuggestions] = useState<NoteMeetingSuggestion[]>([])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const analyzeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The text the last write sent, so an unchanged draft writes nothing. */
  const lastSaved = useRef('')
  /**
   * The draft and the open note, as refs.
   *
   * The unmount effect needs both, and reading them from state would put them
   * in its dependency array — which makes the effect re-run on every keystroke,
   * and its cleanup then clears the timers that `edit` just set. The debounce
   * would be gone: every keystroke would write, and the analysis would never
   * fire at all. Refs keep that effect mounted once and torn down once.
   */
  const draftRef = useRef('')
  const selectedIdRef = useRef<string | null>(null)

  const selected = notes.find((note) => note.id === selectedId) ?? null

  const refresh = useCallback(async (term = search) => {
    const result = await window.electronAPI.notes.list({ search: term || undefined })
    if (result.success && result.notes) setNotes(result.notes)
  }, [search])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const select = useCallback((note: Note | null) => {
    setSelectedId(note?.id ?? null)
    selectedIdRef.current = note?.id ?? null
    setDraft(note?.content ?? '')
    draftRef.current = note?.content ?? ''
    lastSaved.current = note?.content ?? ''
    setRelated([])
    setSuggestions([])
  }, [])

  /** Write the draft now. Called by the debounce, on switching note, and on unmount. */
  const flush = useCallback(async (id: string, content: string) => {
    if (content === lastSaved.current) return
    setSaving(true)
    try {
      const result = await window.electronAPI.notes.update({ id, content })
      if (result.success && result.note) {
        lastSaved.current = content
        setNotes((current) => current.map((note) => (note.id === id ? result.note! : note)))
      }
      // A failed write leaves lastSaved alone, so the next keystroke tries
      // again instead of believing the text is on disk.
    } finally {
      setSaving(false)
    }
  }, [])

  const edit = useCallback(
    (content: string) => {
      setDraft(content)
      draftRef.current = content
      const id = selectedId
      if (!id) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (analyzeTimer.current) clearTimeout(analyzeTimer.current)
      saveTimer.current = setTimeout(() => void flush(id, content), SAVE_DEBOUNCE_MS)
      analyzeTimer.current = setTimeout(async () => {
        // The save is already in; this only asks for the enrichment.
        const result = await window.electronAPI.notes.analyze({ id })
        if (result.success && result.note) {
          setNotes((current) => current.map((note) => (note.id === id ? result.note! : note)))
        }
      }, ANALYZE_IDLE_MS)
    },
    [selectedId, flush]
  )

  // Leaving the page with an unsaved sentence is the one failure this feature
  // cannot have: it is exactly what Notepad never does.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (analyzeTimer.current) clearTimeout(analyzeTimer.current)
      if (selectedIdRef.current) void flush(selectedIdRef.current, draftRef.current)
    }
    // Empty on purpose: this runs when the editor really goes away, not on
    // every keystroke. See draftRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = useCallback(
    async (options: { live?: boolean } = {}) => {
      if (selectedId) await flush(selectedId, draft)
      const result = await window.electronAPI.notes.create({ live: options.live })
      if (!result.success || !result.note) return null
      setNotes((current) => [result.note!, ...current])
      select(result.note)
      return result.note
    },
    [selectedId, draft, flush, select]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.electronAPI.notes.delete({ id })
      setNotes((current) => current.filter((note) => note.id !== id))
      if (selectedId === id) select(null)
    },
    [selectedId, select]
  )

  const patch = useCallback(async (id: string, update: Record<string, unknown>) => {
    const result = await window.electronAPI.notes.update({ id, ...update })
    if (result.success && result.note) {
      setNotes((current) => current.map((note) => (note.id === id ? result.note! : note)))
    }
    return result
  }, [])

  const analyzeNow = useCallback(
    async (id: string) => {
      await flush(id, draft)
      const result = await window.electronAPI.notes.analyze({ id, force: true })
      if (result.success && result.note) {
        setNotes((current) => current.map((note) => (note.id === id ? result.note! : note)))
      }
      return result
    },
    [draft, flush]
  )

  const loadRelated = useCallback(async (id: string) => {
    const result = await window.electronAPI.notes.related({ id })
    setRelated(result.success && result.items ? result.items : [])
    return result
  }, [])

  const loadSuggestions = useCallback(async (id: string) => {
    const result = await window.electronAPI.notes.meetingSuggestions({ id })
    setSuggestions(result.success && result.suggestions ? result.suggestions : [])
    return result
  }, [])

  return {
    notes,
    selected,
    draft,
    saving,
    search,
    related,
    suggestions,
    setSearch,
    refresh,
    select,
    edit,
    create,
    remove,
    patch,
    analyzeNow,
    loadRelated,
    loadSuggestions,
  }
}
