// @vitest-environment node

/**
 * Notes, against a real database.
 *
 * The two rules these tests defend, because both were bought with pain
 * elsewhere in this app: a correction the person made survives a re-analysis,
 * and deleting a note takes its vectors with it so the assistant cannot quote
 * something that no longer exists.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { vi } from 'vitest'

const dbPath = join(tmpdir(), `hidock-notes-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import {
  applyAnalysis,
  contentFingerprint,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  needsAnalysis,
  noteDisplayTitle,
  updateNote,
  markAnalysisFailed,
  MAX_NOTE_BYTES,
} from '../notes'
import { closeDatabase, getDatabase, initializeDatabase, queryAll } from '../database'

beforeAll(async () => {
  await initializeDatabase()
  getDatabase().run(`
    CREATE TABLE IF NOT EXISTS vector_embeddings (
      id TEXT PRIMARY KEY, content TEXT, embedding TEXT,
      meeting_id TEXT, recording_id TEXT, chunk_index INTEGER,
      timestamp TEXT, subject TEXT, source_type TEXT, capture_id TEXT
    )
  `)
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true })
  }
})

beforeEach(() => {
  getDatabase().run('DELETE FROM notes')
  getDatabase().run('DELETE FROM vector_embeddings')
  getDatabase().run('DELETE FROM meetings')
})

describe('creating and writing', () => {
  it('a new note is a row with nothing in it', () => {
    const note = createNote()
    expect(note.content).toBe('')
    expect(note.title).toBe(null)
    expect(note.category).toBe(null)
    expect(note.aiStatus).toBe('none')
    expect(getNote(note.id)).not.toBe(null)
  })

  it('records that it was written during a meeting', () => {
    getDatabase().run(
      `INSERT INTO meetings (id, subject, start_time, end_time)
       VALUES ('meet-1', 'Revisión', '2026-09-22T10:00:00Z', '2026-09-22T11:00:00Z')`
    )
    const note = createNote({ meetingId: 'meet-1', linkSource: 'live' })
    expect(note.meetingId).toBe('meet-1')
    expect(note.linkSource).toBe('live')
  })

  it('refuses to link a meeting that does not exist', () => {
    // The foreign key is the point: a note pointing at nothing would show an
    // empty meeting in the editor and be impossible to explain afterwards.
    expect(() => createNote({ meetingId: 'no-such-meeting', linkSource: 'live' })).toThrow()
  })

  it('keeps what was typed, exactly', () => {
    const note = createNote()
    const text = '# Reunión\n\n- uno\n- dos\n\n```\ncódigo\n```\n'
    const saved = updateNote(note.id, { content: text })
    expect(saved?.content).toBe(text)
  })

  it('refuses to store more than a note', () => {
    const note = createNote()
    const saved = updateNote(note.id, { content: 'x'.repeat(MAX_NOTE_BYTES + 5000) })
    expect(saved?.content.length).toBe(MAX_NOTE_BYTES)
  })

  it('lists the most recently touched first', async () => {
    const first = createNote({ content: 'primera' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = createNote({ content: 'segunda' })
    expect(listNotes().map((note) => note.id)).toEqual([second.id, first.id])
  })

  it('finds a note by its text with no AI anywhere', () => {
    createNote({ content: 'presupuesto de septiembre' })
    createNote({ content: 'otra cosa' })
    expect(listNotes({ search: 'presupuesto' })).toHaveLength(1)
  })

  it('does not treat a wildcard in the search as a wildcard', () => {
    createNote({ content: 'presupuesto' })
    expect(listNotes({ search: '%' })).toHaveLength(0)
  })
})

describe('what the list calls a note', () => {
  it('prefers the typed title, then the first line, then the suggestion', () => {
    expect(noteDisplayTitle({ title: 'Mío', suggestedTitle: 'Suyo', content: 'texto' })).toBe('Mío')
    expect(noteDisplayTitle({ title: null, suggestedTitle: 'Suyo', content: '# Hola\nmás' })).toBe('Hola')
    expect(noteDisplayTitle({ title: null, suggestedTitle: 'Suyo', content: '   ' })).toBe('Suyo')
    expect(noteDisplayTitle({ title: null, suggestedTitle: null, content: '' })).toBe('New note')
  })

  it('does not count whitespace as a title', () => {
    expect(noteDisplayTitle({ title: '   ', suggestedTitle: null, content: 'cuerpo' })).toBe('cuerpo')
  })
})

describe('the AI never owns a correction', () => {
  it('a suggested title does not replace the typed one', () => {
    const note = createNote({ content: 'algo' })
    updateNote(note.id, { title: 'Como lo llamo yo' })
    applyAnalysis(note.id, { suggestedTitle: 'Como lo llama el modelo' }, 'hash')
    const after = getNote(note.id)
    expect(after?.title).toBe('Como lo llamo yo')
    expect(after?.suggestedTitle).toBe('Como lo llama el modelo')
  })

  it('a category the person set survives a re-analysis', () => {
    const note = createNote({ content: 'algo' })
    updateNote(note.id, { category: 'decision' })
    applyAnalysis(note.id, { category: 'idea' }, 'hash')
    const after = getNote(note.id)
    expect(after?.category).toBe('decision')
    expect(after?.categorySource).toBe('user')
  })

  it('a category the model set may be refreshed by the model', () => {
    const note = createNote({ content: 'algo' })
    applyAnalysis(note.id, { category: 'idea' }, 'h1')
    applyAnalysis(note.id, { category: 'task' }, 'h2')
    const after = getNote(note.id)
    expect(after?.category).toBe('task')
    expect(after?.categorySource).toBe('ai')
  })

  it('an analysis is not an edit, so it leaves updated_at alone', async () => {
    // Asserting only the list order passed either way: the analysis was applied
    // to the OLDER note, so even a bumped updated_at would have left the newer
    // one on top. The timestamp itself is what has to be pinned.
    const note = createNote({ content: 'algo' })
    const before = getNote(note.id)!.updatedAt

    await new Promise((resolve) => setTimeout(resolve, 20))
    applyAnalysis(note.id, { summary: 'resumen', suggestedTitle: 'título' }, 'hash')

    expect(getNote(note.id)!.updatedAt).toBe(before)
    expect(getNote(note.id)!.summary).toBe('resumen')
  })

  it('an edit IS an edit, so it does move the note to the top', async () => {
    const older = createNote({ content: 'vieja' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    createNote({ content: 'nueva' })
    expect(listNotes()[0].content).toBe('nueva')

    await new Promise((resolve) => setTimeout(resolve, 5))
    updateNote(older.id, { content: 'vieja, retocada' })
    expect(listNotes()[0].content).toBe('vieja, retocada')
  })
})

describe('paying for the model only once per text', () => {
  it('does not re-analyse text that has not changed', () => {
    const note = createNote({ content: 'contenido estable' })
    expect(needsAnalysis(note.id)).toBe(true)
    applyAnalysis(note.id, { summary: 's' }, contentFingerprint('contenido estable'))
    expect(needsAnalysis(note.id)).toBe(false)
  })

  it('re-analyses once the text really changed', () => {
    const note = createNote({ content: 'uno' })
    applyAnalysis(note.id, { summary: 's' }, contentFingerprint('uno'))
    updateNote(note.id, { content: 'uno y dos' })
    expect(needsAnalysis(note.id)).toBe(true)
  })

  it('does not pay for text that came back to where it started', () => {
    const note = createNote({ content: 'uno' })
    applyAnalysis(note.id, { summary: 's' }, contentFingerprint('uno'))
    updateNote(note.id, { content: 'uno y dos' })
    updateNote(note.id, { content: 'uno' })
    expect(needsAnalysis(note.id)).toBe(false)
  })

  it('never analyses an empty note', () => {
    const note = createNote()
    expect(needsAnalysis(note.id)).toBe(false)
  })

  it('keeps the note when the analysis failed, and says why', () => {
    const note = createNote({ content: 'algo' })
    markAnalysisFailed(note.id, 'no provider configured')
    const after = getNote(note.id)
    expect(after?.content).toBe('algo')
    expect(after?.aiStatus).toBe('failed')
    expect(after?.aiError).toBe('no provider configured')
  })
})

describe('deleting', () => {
  it('takes the vectors with it, so nothing can quote a deleted note', () => {
    const note = createNote({ content: 'secreto' })
    getDatabase().run(
      `INSERT INTO vector_embeddings (id, content, embedding, source_type, capture_id, chunk_index)
       VALUES ('v1', 'secreto', '[]', 'note', ?, 0)`,
      [note.id]
    )
    expect(deleteNote(note.id)).toBe(true)
    expect(getNote(note.id)).toBe(null)
    expect(queryAll(`SELECT id FROM vector_embeddings WHERE capture_id = ?`, [note.id])).toHaveLength(0)
  })

  it('leaves other notes’ vectors alone', () => {
    const doomed = createNote({ content: 'uno' })
    const kept = createNote({ content: 'dos' })
    for (const [id, noteId] of [['v1', doomed.id], ['v2', kept.id]]) {
      getDatabase().run(
        `INSERT INTO vector_embeddings (id, content, embedding, source_type, capture_id, chunk_index)
         VALUES (?, 'x', '[]', 'note', ?, 0)`,
        [id, noteId]
      )
    }
    deleteNote(doomed.id)
    expect(queryAll(`SELECT id FROM vector_embeddings`)).toHaveLength(1)
  })

  it('a deleted note stays out of the list and out of get', () => {
    const note = createNote({ content: 'uno' })
    deleteNote(note.id)
    expect(listNotes()).toHaveLength(0)
    expect(getNote(note.id)).toBe(null)
    expect(deleteNote(note.id)).toBe(false)
  })
})
