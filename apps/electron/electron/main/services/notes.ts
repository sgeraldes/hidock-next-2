/**
 * Hand-written notes.
 *
 * The thing this competes with is Notepad, which opens in under a second and
 * asks nothing. So creating a note takes no title, no category and no meeting:
 * it is a row with empty content and a cursor. Everything else — the title, the
 * category, the summary, the links — arrives afterwards and is correctable.
 *
 * The AI never owns a field the person has touched. `title` and `category` with
 * `category_source = 'user'` are theirs; `suggested_title`, `summary` and an
 * AI-set `category` are the model's and a re-analysis may refresh those freely.
 */

import { createHash, randomUUID } from 'crypto'
import { queryAll, queryOne, runNoSave, runInTransaction } from './database'

export type NoteLinkSource = 'live' | 'user' | 'suggested'
export type NoteAiStatus = 'none' | 'pending' | 'ready' | 'failed'

export interface Note {
  id: string
  title: string | null
  suggestedTitle: string | null
  content: string
  summary: string | null
  category: string | null
  categorySource: 'ai' | 'user' | null
  tags: string[]
  meetingId: string | null
  recordingId: string | null
  linkSource: NoteLinkSource | null
  aiStatus: NoteAiStatus
  aiError: string | null
  createdAt: string
  updatedAt: string
}

interface NoteRow {
  id: string
  title: string | null
  suggested_title: string | null
  content: string
  summary: string | null
  category: string | null
  category_source: 'ai' | 'user' | null
  tags: string | null
  meeting_id: string | null
  recording_id: string | null
  link_source: NoteLinkSource | null
  ai_status: NoteAiStatus | null
  ai_error: string | null
  created_at: string
  updated_at: string
}

/** Longest note we will accept in one row. Past this it is a document. */
export const MAX_NOTE_BYTES = 1024 * 1024

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title || null,
    suggestedTitle: row.suggested_title || null,
    content: row.content ?? '',
    summary: row.summary || null,
    category: row.category || null,
    categorySource: row.category_source || null,
    tags: parseTags(row.tags),
    meetingId: row.meeting_id || null,
    recordingId: row.recording_id || null,
    linkSource: row.link_source || null,
    aiStatus: row.ai_status || 'none',
    aiError: row.ai_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * What the list shows for a note.
 *
 * A note with no title of its own is identified by its first line, the same way
 * the library identifies a source with no calendar event. An empty note is not
 * "Untitled": it is new, and saying so is the truth.
 */
export function noteDisplayTitle(note: Pick<Note, 'title' | 'suggestedTitle' | 'content'>): string {
  const typed = note.title?.trim()
  if (typed) return typed
  const firstLine = note.content.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean)
  if (firstLine) return firstLine.slice(0, 120)
  const suggested = note.suggestedTitle?.trim()
  if (suggested) return suggested
  return 'New note'
}

/** Stable fingerprint of the text an analysis read, so identical text is free. */
export function contentFingerprint(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 32)
}

export function createNote(input: {
  content?: string
  recordingId?: string | null
  meetingId?: string | null
  linkSource?: NoteLinkSource | null
} = {}): Note {
  const id = randomUUID()
  const now = new Date().toISOString()
  runNoSave(
    `INSERT INTO notes (id, content, recording_id, meeting_id, link_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      (input.content ?? '').slice(0, MAX_NOTE_BYTES),
      input.recordingId ?? null,
      input.meetingId ?? null,
      input.linkSource ?? null,
      now,
      now,
    ]
  )
  return getNote(id) as Note
}

export function getNote(id: string): Note | null {
  const row = queryOne<NoteRow>('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL', [id])
  return row ? toNote(row) : null
}

export function listNotes(options: { limit?: number; offset?: number; search?: string } = {}): Note[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const offset = Math.max(options.offset ?? 0, 0)
  const search = options.search?.trim()
  if (search) {
    // Plain substring search. The semantic one is the vector index; this is the
    // one that has to work with no AI provider configured at all.
    const like = `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`
    return queryAll<NoteRow>(
      `SELECT * FROM notes
       WHERE deleted_at IS NULL
         AND (content LIKE ? ESCAPE '\\' OR COALESCE(title, '') LIKE ? ESCAPE '\\'
              OR COALESCE(suggested_title, '') LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [like, like, like, limit, offset]
    ).map(toNote)
  }
  return queryAll<NoteRow>(
    'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  ).map(toNote)
}

export interface NoteUpdate {
  content?: string
  title?: string | null
  category?: string | null
  tags?: string[]
  meetingId?: string | null
  recordingId?: string | null
  linkSource?: NoteLinkSource | null
}

/**
 * Save what the person changed.
 *
 * Setting `category` here always marks it `user`: this function is only ever
 * called from the editor, and a category that came from the model is written by
 * applyAnalysis instead. Keeping the two writers apart is what makes
 * "a correction survives a re-analysis" true rather than hopeful.
 */
export function updateNote(id: string, update: NoteUpdate): Note | null {
  const existing = getNote(id)
  if (!existing) return null

  const sets: string[] = []
  const values: unknown[] = []

  if (update.content !== undefined) {
    sets.push('content = ?')
    values.push(update.content.slice(0, MAX_NOTE_BYTES))
  }
  if (update.title !== undefined) {
    const trimmed = update.title?.trim() || null
    sets.push('title = ?')
    values.push(trimmed)
  }
  if (update.category !== undefined) {
    const trimmed = update.category?.trim() || null
    sets.push('category = ?', 'category_source = ?')
    values.push(trimmed, trimmed ? 'user' : null)
  }
  if (update.tags !== undefined) {
    sets.push('tags = ?')
    values.push(JSON.stringify(update.tags))
  }
  if (update.meetingId !== undefined) {
    sets.push('meeting_id = ?')
    values.push(update.meetingId)
  }
  if (update.recordingId !== undefined) {
    sets.push('recording_id = ?')
    values.push(update.recordingId)
  }
  if (update.linkSource !== undefined) {
    sets.push('link_source = ?')
    values.push(update.linkSource)
  }

  if (sets.length === 0) return existing

  sets.push('updated_at = ?')
  values.push(new Date().toISOString(), id)
  runNoSave(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, values)
  return getNote(id)
}

export interface NoteAnalysis {
  suggestedTitle?: string | null
  summary?: string | null
  category?: string | null
  tags?: string[]
}

/**
 * Write back what the model produced.
 *
 * It may set its own fields freely. It may set `category` only while nobody has
 * corrected it, which is the whole reason category_source exists.
 */
export function applyAnalysis(id: string, analysis: NoteAnalysis, contentHash: string): Note | null {
  const existing = queryOne<NoteRow>('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) return null

  const sets = ['suggested_title = ?', 'summary = ?', 'ai_status = ?', 'ai_error = NULL', 'ai_content_hash = ?']
  const values: unknown[] = [
    analysis.suggestedTitle?.trim() || null,
    analysis.summary?.trim() || null,
    'ready',
    contentHash,
  ]

  if (existing.category_source !== 'user' && analysis.category !== undefined) {
    sets.push('category = ?', 'category_source = ?')
    values.push(analysis.category?.trim() || null, analysis.category?.trim() ? 'ai' : null)
  }
  if (analysis.tags !== undefined) {
    sets.push('tags = ?')
    values.push(JSON.stringify(analysis.tags))
  }

  // Deliberately NOT touching updated_at: an analysis is not an edit, and
  // bumping it would push every analysed note to the top of a list sorted by
  // when the person last worked on it.
  values.push(id)
  runNoSave(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, values)
  return getNote(id)
}

export function markAnalysisPending(id: string): void {
  runNoSave(`UPDATE notes SET ai_status = 'pending', ai_error = NULL WHERE id = ?`, [id])
}

export function markAnalysisFailed(id: string, reason: string): void {
  runNoSave(`UPDATE notes SET ai_status = 'failed', ai_error = ? WHERE id = ?`, [reason.slice(0, 500), id])
}

/**
 * Has this exact text already been analysed?
 *
 * A note edited ten times in two minutes must not pay for ten calls, and text
 * that came back to where it started must not pay at all.
 */
export function needsAnalysis(id: string): boolean {
  const row = queryOne<{ content: string; ai_content_hash: string | null; ai_status: string | null }>(
    'SELECT content, ai_content_hash, ai_status FROM notes WHERE id = ? AND deleted_at IS NULL',
    [id]
  )
  if (!row) return false
  if (!row.content.trim()) return false
  if (row.ai_status === 'pending') return false
  return row.ai_content_hash !== contentFingerprint(row.content)
}

/**
 * Delete a note and the vectors that point at it, together.
 *
 * An orphan vector would make the assistant quote a note that no longer exists,
 * which is worse than not finding it. Same transaction, no window.
 */
export function deleteNote(id: string): boolean {
  const existing = getNote(id)
  if (!existing) return false
  runInTransaction(() => {
    runNoSave('UPDATE notes SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id])
    runNoSave(`DELETE FROM vector_embeddings WHERE source_type = 'note' AND capture_id = ?`, [id])
  })
  return true
}
