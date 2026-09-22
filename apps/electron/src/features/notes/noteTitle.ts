import type { Note } from '@/types/notes'

/**
 * What the list shows for a note.
 *
 * Mirrors the main process's noteDisplayTitle deliberately: the list has to
 * name a note the instant it is created, before any save has come back and
 * before the AI has seen it, so it cannot wait for a stored title.
 *
 * Order: the title the person typed, then the note's own first line, then the
 * AI's suggestion, then "New note". The first line comes before the suggestion
 * because a note is usually identified by how it starts, and because the
 * suggestion arrives half a minute late.
 */
export function noteDisplayTitle(note: Pick<Note, 'title' | 'suggestedTitle' | 'content'>): string {
  const typed = note.title?.trim()
  if (typed) return typed

  const firstLine = note.content
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  if (firstLine) return firstLine.slice(0, 120)

  const suggested = note.suggestedTitle?.trim()
  if (suggested) return suggested

  return 'New note'
}

/** The second line of a row: when it changed, and what it is about. */
export function noteSubtitle(note: Note, now = new Date()): string {
  const updated = new Date(note.updatedAt)
  const parts: string[] = [formatWhen(updated, now)]
  if (note.category) parts.push(note.category)
  if (note.linkSource === 'live') parts.push('written during a meeting')
  return parts.join(' · ')
}

function formatWhen(then: Date, now: Date): string {
  if (Number.isNaN(then.getTime())) return 'unknown'
  const sameDay = then.toDateString() === now.toDateString()
  if (sameDay) {
    return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
