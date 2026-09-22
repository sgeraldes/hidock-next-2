// @vitest-environment jsdom

/**
 * The editor's promise: a keystroke always reaches the database.
 *
 * Notepad never loses a sentence, so neither can this. These tests are about
 * the two moments where a draft can be dropped — the debounce and switching
 * away — and about not paying for the model on every keystroke.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useNotes, SAVE_DEBOUNCE_MS, ANALYZE_IDLE_MS } from '../useNotes'
import type { Note } from '@/types/notes'

function makeNote(id: string, content = ''): Note {
  return {
    id,
    title: null,
    suggestedTitle: null,
    content,
    summary: null,
    category: null,
    categorySource: null,
    tags: [],
    meetingId: null,
    recordingId: null,
    linkSource: null,
    aiStatus: 'none',
    aiError: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  }
}

let notes: Note[]
let updates: { id: string; content?: string }[]
let analyses: string[]

beforeEach(() => {
  vi.useFakeTimers()
  notes = [makeNote('n1', 'uno'), makeNote('n2', 'dos')]
  updates = []
  analyses = []
  const api = {
    notes: {
      list: vi.fn(async () => ({ success: true, notes })),
      create: vi.fn(async () => {
        const note = makeNote(`n${notes.length + 1}`)
        notes = [note, ...notes]
        return { success: true, note }
      }),
      get: vi.fn(async ({ id }: { id: string }) => ({ success: true, note: notes.find((n) => n.id === id) })),
      update: vi.fn(async (request: { id: string; content?: string }) => {
        updates.push(request)
        const note = { ...notes.find((n) => n.id === request.id)!, ...request }
        notes = notes.map((n) => (n.id === request.id ? note : n))
        return { success: true, note }
      }),
      delete: vi.fn(async () => ({ success: true })),
      analyze: vi.fn(async ({ id }: { id: string }) => {
        analyses.push(id)
        return { success: true, note: notes.find((n) => n.id === id) }
      }),
      related: vi.fn(async () => ({ success: true, items: [] })),
      meetingSuggestions: vi.fn(async () => ({ success: true, suggestions: [] })),
    },
  }
  ;(globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = api
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Let the hook's pending promises settle under fake timers. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('saving', () => {
  it('writes once for a burst of keystrokes, not once per keystroke', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))

    act(() => {
      result.current.edit('u')
      result.current.edit('un')
      result.current.edit('uno ')
      result.current.edit('uno y')
    })
    expect(updates).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    })
    await settle()

    expect(updates).toHaveLength(1)
    expect(updates[0].content).toBe('uno y')
  })

  it('does not write text that did not change', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))

    act(() => result.current.edit('uno'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    })
    await settle()
    expect(updates).toHaveLength(0)
  })

  it('writes the draft when the editor goes away', async () => {
    // The one failure this feature cannot have. Nothing has fired the debounce
    // yet, and the note still has to be on disk.
    const { result, unmount } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))
    act(() => result.current.edit('escrito y no guardado'))

    unmount()
    await settle()

    expect(updates.map((u) => u.content)).toContain('escrito y no guardado')
  })

  it('writes the old note before opening another one', async () => {
    // The failure this replaces: switching left the outgoing note's debounce
    // pending, and one keystroke in the new note cleared it. The first note's
    // sentence was gone, and the unmount flush now held the second note's text
    // and could not recover it.
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))
    act(() => result.current.edit('lo de la primera'))

    act(() => result.current.select(notes[1]))
    act(() => result.current.edit('lo de la segunda'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    })
    await settle()

    expect(updates.find((u) => u.id === 'n1')?.content).toBe('lo de la primera')
    expect(updates.find((u) => u.id === 'n2')?.content).toBe('lo de la segunda')
  })

  it('does not carry one note’s text into another', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))
    act(() => result.current.edit('texto de la primera'))
    act(() => result.current.select(notes[1]))
    await settle()

    // Nothing written for n2, and n2's editor shows n2's own text.
    expect(updates.filter((u) => u.id === 'n2')).toHaveLength(0)
    expect(result.current.draft).toBe('dos')
  })

  it('writes the old note before opening a new one', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))
    act(() => result.current.edit('lo de la primera'))

    await act(async () => {
      await result.current.create()
    })
    await settle()

    // The first note's text went to the FIRST note, not to the new one.
    const written = updates.find((u) => u.content === 'lo de la primera')
    expect(written?.id).toBe('n1')
  })
})

describe('paying for the model', () => {
  it('does not analyse while the person is still typing', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))

    act(() => result.current.edit('primera versión'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYZE_IDLE_MS - 1000)
    })
    act(() => result.current.edit('primera versión corregida'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYZE_IDLE_MS - 1000)
    })
    expect(analyses).toHaveLength(0)
  })

  it('analyses once the note has been still', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))

    act(() => result.current.edit('algo que decir'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYZE_IDLE_MS)
    })
    await settle()

    expect(analyses).toEqual(['n1'])
  })

  it('does not analyse a note nobody is editing', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    act(() => result.current.select(notes[0]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYZE_IDLE_MS * 3)
    })
    expect(analyses).toHaveLength(0)
  })
})

describe('the list', () => {
  it('loads on mount', async () => {
    // Real timers here: waitFor polls with a timer, so under fake ones it
    // would wait for a clock nobody is advancing.
    vi.useRealTimers()
    const { result } = renderHook(() => useNotes())
    await waitFor(() => expect(result.current.notes).toHaveLength(2))
  })

  it('shows a new note at the top and opens it', async () => {
    const { result } = renderHook(() => useNotes())
    await settle()
    await act(async () => {
      await result.current.create()
    })
    expect(result.current.notes[0].id).toBe('n3')
    expect(result.current.selected?.id).toBe('n3')
    expect(result.current.draft).toBe('')
  })
})
