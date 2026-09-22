// @vitest-environment jsdom

/**
 * The notes page renders and does the three things a person does first.
 *
 * A typecheck does not catch a component that throws on mount, and this page
 * is the whole feature: if it does not render, nothing else matters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Notes from '../Notes'
import type { Note } from '@/types/notes'

function makeNote(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    title: null,
    suggestedTitle: null,
    content: '',
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
    ...overrides,
  }
}

let notes: Note[]
let created: number
let api: Record<string, unknown>

beforeEach(() => {
  created = 0
  notes = [
    makeNote('n1', { content: 'Presupuesto de septiembre\nlos números', category: 'decision' }),
    makeNote('n2', { content: 'Otra cosa' }),
  ]
  api = {
    notes: {
      list: vi.fn(async () => ({ success: true, notes })),
      create: vi.fn(async () => {
        created += 1
        const note = makeNote(`new-${created}`)
        notes = [note, ...notes]
        return { success: true, note }
      }),
      get: vi.fn(async ({ id }: { id: string }) => ({ success: true, note: notes.find((n) => n.id === id) })),
      update: vi.fn(async (request: { id: string } & Partial<Note>) => {
        const note = { ...notes.find((n) => n.id === request.id)!, ...request }
        notes = notes.map((n) => (n.id === request.id ? note : n))
        return { success: true, note }
      }),
      delete: vi.fn(async () => ({ success: true })),
      analyze: vi.fn(async ({ id }: { id: string }) => ({
        success: true,
        note: { ...notes.find((n) => n.id === id)!, summary: 'Un resumen', category: 'decision' },
      })),
      related: vi.fn(async () => ({
        success: true,
        items: [
          {
            kind: 'transcript',
            id: 'rec-1',
            title: 'Revisión de calidad',
            excerpt: 'hablamos del presupuesto',
            score: 0.8,
            meetingId: 'm1',
            recordingId: 'rec-1',
          },
        ],
      })),
      meetingSuggestions: vi.fn(async () => ({
        success: true,
        suggestions: [
          {
            meetingId: 'm1',
            subject: 'Revisión de calidad',
            startTime: '2026-09-22T10:00:00.000Z',
            reason: 'You wrote this while that meeting was happening.',
            score: 1,
          },
        ],
      })),
    },
  }
  ;(globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = api
})

describe('the notes page', () => {
  it('renders the list, naming each note by its first line', async () => {
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Presupuesto de septiembre')).toBeTruthy())
    expect(screen.getByText('Otra cosa')).toBeTruthy()
  })

  it('tells a person with no notes what the button does', async () => {
    notes = []
    render(<Notes />)
    await waitFor(() =>
      expect(screen.getByText(/cursor already in it/i)).toBeTruthy()
    )
  })

  it('opens a new note with one click and nothing to fill in', async () => {
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Otra cosa')).toBeTruthy())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    })

    await waitFor(() => expect(screen.getByLabelText('Note')).toBeTruthy())
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText('Note title') as HTMLInputElement).value).toBe('')
  })

  it('shows the note when one is picked', async () => {
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Presupuesto de septiembre')).toBeTruthy())

    await act(async () => {
      fireEvent.click(screen.getByText('Presupuesto de septiembre'))
    })

    await waitFor(() =>
      expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toContain('los números')
    )
  })

  it('shows a meeting suggestion with its reason, and does not link it by itself', async () => {
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Presupuesto de septiembre')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText('Presupuesto de septiembre'))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Suggest a meeting/i }))
    })

    await waitFor(() =>
      expect(screen.getByText(/while that meeting was happening/i)).toBeTruthy()
    )
    // The link is a button the person still has to press.
    expect(screen.getByRole('button', { name: /Link to this meeting/i })).toBeTruthy()
  })

  it('says who set the category when the person did', async () => {
    notes[0] = { ...notes[0], category: 'decision', categorySource: 'user' }
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Presupuesto de septiembre')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText('Presupuesto de septiembre'))
    })

    await waitFor(() =>
      expect(screen.getByText(/re-analysing will not change it/i)).toBeTruthy()
    )
  })

  it('shows why the last analysis failed instead of an empty category', async () => {
    notes[0] = { ...notes[0], aiStatus: 'failed', aiError: 'no provider configured' }
    render(<Notes />)
    await waitFor(() => expect(screen.getByText('Presupuesto de septiembre')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText('Presupuesto de septiembre'))
    })

    await waitFor(() => expect(screen.getByText(/no provider configured/)).toBeTruthy())
  })
})
