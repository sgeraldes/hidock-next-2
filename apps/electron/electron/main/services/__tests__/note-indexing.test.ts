// @vitest-environment node

/**
 * A note reaches the semantic index, and leaves it cleanly.
 *
 * The index is what makes a note findable by the assistant alongside the
 * transcripts, so the two things that matter are that a saved note gets in and
 * that an edited one does not leave its old text behind.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-note-index-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp'), getName: vi.fn().mockReturnValue('test') },
}))

const addDocument = vi.fn(async () => 'vector-1')
vi.mock('../vector-store', () => ({
  getVectorStore: () => ({ addDocument, search: vi.fn(async () => []) }),
}))

import { indexNote } from '../note-intelligence'
import { createNote, updateNote } from '../notes'
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
  addDocument.mockClear()
  addDocument.mockResolvedValue('vector-1')
  getDatabase().run('DELETE FROM notes')
  getDatabase().run('DELETE FROM vector_embeddings')
})

describe('indexNote', () => {
  it('sends the note to the index labelled as a note', async () => {
    const note = createNote({ content: 'presupuesto de septiembre' })

    expect(await indexNote(note.id)).toBe(true)
    const [content, metadata] = addDocument.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(content).toBe('presupuesto de septiembre')
    expect(metadata.sourceType).toBe('note')
    expect(metadata.captureId).toBe(note.id)
  })

  it('carries the title so a search result can name what it found', async () => {
    const note = createNote({ content: 'cuerpo' })
    updateNote(note.id, { title: 'Presupuesto' })

    await indexNote(note.id)
    const metadata = (addDocument.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(metadata.subject).toBe('Presupuesto')
  })

  it('removes the old vectors before adding the new ones', async () => {
    // addDocument builds its row id from Date.now(), so without the delete an
    // edited note would sit in the index twice and the assistant would quote a
    // sentence the person had removed.
    const note = createNote({ content: 'primera versión' })
    getDatabase().run(
      `INSERT INTO vector_embeddings (id, content, embedding, source_type, capture_id, chunk_index)
       VALUES ('old', 'primera versión', '[]', 'note', ?, 0)`,
      [note.id]
    )

    await indexNote(note.id)

    expect(queryAll(`SELECT id FROM vector_embeddings WHERE id = 'old'`)).toHaveLength(0)
  })

  it('leaves another note’s vectors alone', async () => {
    const mine = createNote({ content: 'mía' })
    const other = createNote({ content: 'ajena' })
    getDatabase().run(
      `INSERT INTO vector_embeddings (id, content, embedding, source_type, capture_id, chunk_index)
       VALUES ('theirs', 'ajena', '[]', 'note', ?, 0)`,
      [other.id]
    )

    await indexNote(mine.id)

    expect(queryAll(`SELECT id FROM vector_embeddings WHERE id = 'theirs'`)).toHaveLength(1)
  })

  it('does not index an empty note', async () => {
    const note = createNote()
    expect(await indexNote(note.id)).toBe(false)
    expect(addDocument).not.toHaveBeenCalled()
  })

  it('does not index a note that is gone', async () => {
    expect(await indexNote('no-such-note')).toBe(false)
    expect(addDocument).not.toHaveBeenCalled()
  })

  it('says it failed when there is no embedder, instead of claiming success', async () => {
    // With no embeddings provider addDocument returns null. The note is still
    // saved; it is only missing from semantic search until the next edit.
    addDocument.mockResolvedValue(null as never)
    const note = createNote({ content: 'algo' })

    expect(await indexNote(note.id)).toBe(false)
  })
})
