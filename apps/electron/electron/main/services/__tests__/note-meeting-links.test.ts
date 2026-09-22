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
import { createNote } from '../notes'
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

    expect(suggestions).toHaveLength(1)
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

    expect(suggestions.map((s) => s.meetingId)).toEqual(['m-later'])
    expect(suggestions[0].reason).toMatch(/same things/)
  })

  it('does not offer the same meeting twice when both signals point at it', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [DURING, note.id])
    search.mockResolvedValue([
      { document: { id: 'c1', metadata: { meetingId: 'm-now' } }, score: 0.9 },
    ])

    const suggestions = await suggestMeetings(note.id)

    expect(suggestions).toHaveLength(1)
    // The stronger reason wins: being there beats sounding similar.
    expect(suggestions[0].reason).toMatch(/while that meeting was happening/)
  })

  it('ignores a chunk that points at a meeting the database does not have', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])
    search.mockResolvedValue([
      { document: { id: 'c1', metadata: { meetingId: 'm-deleted' } }, score: 0.9 },
    ])

    expect(await suggestMeetings(note.id)).toEqual([])
  })

  it('suggests nothing for an empty note and never asks the index', async () => {
    const note = createNote()
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [AFTER, note.id])

    expect(await suggestMeetings(note.id)).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('links nothing by itself', async () => {
    const note = createNote({ content: 'algo' })
    getDatabase().run('UPDATE notes SET created_at = ? WHERE id = ?', [DURING, note.id])

    await suggestMeetings(note.id)

    const row = getDatabase()
      .exec('SELECT meeting_id, link_source FROM notes WHERE id = ?', [note.id])[0]
    expect(row.values[0]).toEqual([null, null])
  })
})
