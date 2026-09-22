// @vitest-environment node

/**
 * Which meeting a note belongs to, and who decided.
 *
 * The rule: a note written while a meeting is happening is attached to it
 * without asking, because that is the one link nobody can reconstruct
 * afterwards. Everything else is a candidate with its reason written out, and
 * nothing here links anything by itself.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-note-links-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp'), getName: vi.fn().mockReturnValue('test') },
}))

/** The semantic half of the suggestion, without an embedder. */
const search = vi.fn(async () => [] as unknown[])
vi.mock('../vector-store', () => ({
  getVectorStore: () => ({ search, addDocument: vi.fn(async () => 'v1') }),
}))

import { meetingHappeningNow, suggestMeetings } from '../note-intelligence'
import { createNote, getNote } from '../notes'
import { closeDatabase, getDatabase, initializeDatabase } from '../database'

const DURING = '2026-09-22T10:30:00.000Z'
const AFTER = '2026-09-22T23:00:00.000Z'

beforeAll(async () => {
  await initializeDatabase()
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true })
  }
})

beforeEach(() => {
  search.mockReset()
  search.mockResolvedValue([])
  getDatabase().run('DELETE FROM notes')
  getDatabase().run('DELETE FROM meetings')
  getDatabase().run(
    `INSERT INTO meetings (id, subject, start_time, end_time) VALUES
      ('m-now', 'Revisión de calidad', '2026-09-22T10:00:00.000Z', '2026-09-22T11:00:00.000Z'),
      ('m-later', 'Otra reunión', '2026-09-22T15:00:00.000Z', '2026-09-22T16:00:00.000Z')`
  )
})

describe('a note written during a meeting', () => {
  it('finds the meeting that covers that moment', () => {
    expect(meetingHappeningNow(DURING)).toBe('m-now')
  })

  it('finds nothing when no meeting covers it, rather than picking the nearest', () => {
    // Guessing here would attach a note to a meeting it has nothing to do with,
    // and nobody would ever know why.
    expect(meetingHappeningNow(AFTER)).toBe(null)
  })

  it('finds nothing at the exact moment a meeting has ended', () => {
    expect(meetingHappeningNow('2026-09-22T11:00:00.001Z')).toBe(null)
  })
})

describe('suggesting a meeting afterwards', () => {
  it('offers the meeting the note was written during, and says so in words', async () => {
    const note = createNote({ content: 'lo que se habló' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [DURING, note.id])

    const suggestions = await suggestMeetings(note.id)

    // First, above the same-day meetings offered so the person can pick by hand.
    expect(suggestions[0].meetingId).toBe('m-now')
    expect(suggestions[0].reason).toMatch(/while that meeting was happening/)
  })

  it('offers a meeting whose transcript says the same things', async () => {
    const note = createNote({ content: 'presupuesto y alcance' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])
    search.mockResolvedValue([
      { document: { id: 'c1', metadata: { meetingId: 'm-later' } }, score: 0.81 },
    ])

    const suggestions = await suggestMeetings(note.id)

    expect(suggestions[0].meetingId).toBe('m-later')
    expect(suggestions[0].reason).toMatch(/same things/)
  })

  it('does not offer the same meeting twice when both signals point at it', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [DURING, note.id])
    search.mockResolvedValue([
      { document: { id: 'c1', metadata: { meetingId: 'm-now' } }, score: 0.9 },
    ])

    const suggestions = await suggestMeetings(note.id)

    // Once, not twice, and with the stronger reason: being there beats
    // sounding similar.
    expect(suggestions.filter((s) => s.meetingId === 'm-now')).toHaveLength(1)
    expect(suggestions[0].meetingId).toBe('m-now')
    expect(suggestions[0].reason).toMatch(/while that meeting was happening/)
  })

  it('ignores a chunk that points at a meeting the database does not have', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])
    search.mockResolvedValue([
      { document: { id: 'c1', metadata: { meetingId: 'm-deleted' } }, score: 0.9 },
    ])

    // The chunk contributes nothing; only the same-day list is left.
    const suggestions = await suggestMeetings(note.id)
    expect(suggestions.map((s) => s.meetingId)).not.toContain('m-deleted')
    expect(suggestions.every((s) => /same day/.test(s.reason))).toBe(true)
  })

  it('never asks the index for an empty note', async () => {
    const note = createNote()
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])

    await suggestMeetings(note.id)
    expect(search).not.toHaveBeenCalled()
  })

  it('offers the meetings of that day so a note can be linked by hand', async () => {
    // Two signals that both come up empty is not an answer. Picking one off a
    // list IS choosing by hand, and it is the only way to link a note the
    // calendar and the transcript both failed to connect.
    const note = createNote({ content: 'algo que no se parece a nada' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])

    const suggestions = await suggestMeetings(note.id)

    expect(suggestions.map((s) => s.meetingId).sort()).toEqual(['m-later', 'm-now'])
    expect(suggestions.every((s) => /Pick it if it is the right one/.test(s.reason))).toBe(true)
  })

  it('offers nothing for a day with no meetings at all', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', ['2026-01-05T10:00:00.000Z', note.id])

    expect(await suggestMeetings(note.id)).toEqual([])
  })

  it('the strongest candidate is still only a candidate', async () => {
    // suggestMeetings is a read, so asserting it wrote nothing proves nothing.
    // What this pins is that the note comes back UNLINKED even when one
    // candidate is the meeting it was written during — the moment where a
    // "helpful" auto-link would be most tempting to add.
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [DURING, note.id])

    const suggestions = await suggestMeetings(note.id)
    expect(suggestions[0].meetingId).toBe('m-now')

    const after = getNote(note.id)
    expect(after?.meetingId).toBe(null)
    expect(after?.linkSource).toBe(null)
  })

  it('the same-day list follows the person’s day, not the UTC one', async () => {
    // Argentina is UTC-3, so a note written at 21:30 local is already the next
    // day in UTC. Comparing UTC dates offered tomorrow's meetings for a note
    // written this evening.
    const localEvening = new Date('2026-09-22T00:30:00.000Z') // 21:30 del 21-sep en AR
    const note = createNote({ content: 'algo que no se parece a nada' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [
      localEvening.toISOString(),
      note.id,
    ])

    const suggestions = await suggestMeetings(note.id)
    const offset = -localEvening.getTimezoneOffset() / 60
    if (offset >= 0) {
      // On a UTC or eastern machine that note is already the 22nd locally too,
      // so there is nothing to tell apart and the case does not apply.
      expect(Array.isArray(suggestions)).toBe(true)
      return
    }
    // The meetings in the fixture are on the 22nd; locally the note is the 21st.
    expect(suggestions).toEqual([])
  })
})
