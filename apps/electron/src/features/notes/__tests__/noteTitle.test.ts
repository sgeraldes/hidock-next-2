import { describe, expect, it } from 'vitest'
import { noteDisplayTitle, noteSubtitle } from '../noteTitle'
import type { Note } from '@/types/notes'

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
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

describe('noteDisplayTitle', () => {
  it('uses the title the person typed', () => {
    expect(noteDisplayTitle(note({ title: 'Presupuesto', suggestedTitle: 'Otra cosa', content: 'x' })))
      .toBe('Presupuesto')
  })

  it('falls back to the first line, without its markdown heading marks', () => {
    expect(noteDisplayTitle(note({ content: '## Reunión con Yaraví\ndetalle' })))
      .toBe('Reunión con Yaraví')
  })

  it('skips blank lines at the top', () => {
    expect(noteDisplayTitle(note({ content: '\n\n   \nprimera de verdad' })))
      .toBe('primera de verdad')
  })

  it('prefers the first line over a suggestion, because the suggestion is 30 seconds late', () => {
    expect(noteDisplayTitle(note({ suggestedTitle: 'Del modelo', content: 'lo que escribí' })))
      .toBe('lo que escribí')
  })

  it('uses the suggestion only when there is nothing else', () => {
    expect(noteDisplayTitle(note({ suggestedTitle: 'Del modelo', content: '   ' })))
      .toBe('Del modelo')
  })

  it('says a brand new note is new, rather than calling it untitled', () => {
    expect(noteDisplayTitle(note())).toBe('New note')
  })

  it('does not let one long line become the whole row', () => {
    expect(noteDisplayTitle(note({ content: 'x'.repeat(400) }))).toHaveLength(120)
  })

  it('treats a whitespace-only title as no title', () => {
    expect(noteDisplayTitle(note({ title: '   ', content: 'cuerpo' }))).toBe('cuerpo')
  })
})

describe('noteSubtitle', () => {
  const now = new Date('2026-09-22T18:00:00.000Z')

  it('shows a time for something touched today and a date for older', () => {
    const today = noteSubtitle(note({ updatedAt: '2026-09-22T09:30:00.000Z' }), now)
    const older = noteSubtitle(note({ updatedAt: '2026-09-01T09:30:00.000Z' }), now)
    expect(today).not.toBe(older)
    expect(older).not.toMatch(/:/)
  })

  it('adds the category when there is one', () => {
    expect(noteSubtitle(note({ category: 'decision' }), now)).toContain('decision')
  })

  it('says when it was written during a meeting', () => {
    expect(noteSubtitle(note({ linkSource: 'live' }), now)).toContain('written during a meeting')
  })

  it('does not say that for a link the person made afterwards', () => {
    expect(noteSubtitle(note({ linkSource: 'user' }), now)).not.toContain('written during')
  })

  it('survives a timestamp it cannot read', () => {
    expect(noteSubtitle(note({ updatedAt: 'not a date' }), now)).toContain('unknown')
  })
})
