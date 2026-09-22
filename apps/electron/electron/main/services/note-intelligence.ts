/**
 * The four things the AI does to a note: categorise, summarise, cross-reference
 * and suggest a meeting.
 *
 * None of them is on the path of typing. A note is written, saved and searched
 * by text with no AI provider configured at all; everything here is an
 * enrichment that can be absent, late or wrong without costing the person their
 * note.
 */

import { getBrainRouter } from './brains'
import { getVectorStore } from './vector-store'
import { getDatabase, queryAll, queryOne } from './database'
import {
  applyAnalysis,
  contentFingerprint,
  getNote,
  markAnalysisFailed,
  markAnalysisPending,
  needsAnalysis,
  type Note,
  type NoteAnalysis,
} from './notes'

/** Categories the model may choose from. A free-text category is unsortable. */
export const NOTE_CATEGORIES = [
  'meeting',
  'idea',
  'task',
  'decision',
  'research',
  'personal',
  'reference',
  'other',
] as const

export type NoteCategory = (typeof NOTE_CATEGORIES)[number]

/** Enough text for a category and a summary; past this it is the same answer. */
const MAX_ANALYSIS_CHARS = 12_000

const SYSTEM_PROMPT = `You organise short hand-written notes.
Return ONLY a JSON object with these keys and nothing else:
  "title": a specific title of at most 8 words, in the note's own language
  "summary": one or two sentences, in the note's own language
  "category": exactly one of ${NOTE_CATEGORIES.join(', ')}
  "tags": 2 to 5 short lowercase tags
Never invent facts the note does not contain. If the note is too short to
summarise, set summary to null and still give a title and a category.`

/** Pull the JSON object out of an answer that may be fenced or chatty. */
export function parseAnalysis(raw: string | null): NoteAnalysis | null {
  if (!raw) return null
  const withoutFence = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    return null
  }

  const category = typeof parsed.category === 'string' ? parsed.category.trim().toLowerCase() : ''
  return {
    suggestedTitle: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : null,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 1000) : null,
    // A category outside the list is not a category: it would make the filter
    // grow a bucket per hallucination.
    category: (NOTE_CATEGORIES as readonly string[]).includes(category) ? category : 'other',
    tags: Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 5)
      : [],
  }
}

/**
 * Categorise and summarise in ONE call.
 *
 * Asking for the category and the summary separately pays twice for reading the
 * same text, and the two answers can then disagree with each other.
 */
export async function analyzeNote(
  noteId: string,
  options: { force?: boolean } = {}
): Promise<Note | null> {
  const note = getNote(noteId)
  if (!note) return null
  if (!note.content.trim()) return note
  if (!options.force && !needsAnalysis(noteId)) return note

  const hash = contentFingerprint(note.content)
  markAnalysisPending(noteId)
  try {
    const answer = await getBrainRouter().chat(
      'suggestions',
      [{ role: 'user', content: note.content.slice(0, MAX_ANALYSIS_CHARS) }],
      { systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 500 }
    )
    const analysis = parseAnalysis(answer)
    if (!analysis) {
      markAnalysisFailed(noteId, 'The model did not return a result this note could use.')
      return getNote(noteId)
    }
    return applyAnalysis(noteId, analysis, hash)
  } catch (error) {
    // A note whose analysis failed is still a note. The reason is kept so the
    // editor can say what happened instead of showing an empty category.
    markAnalysisFailed(noteId, (error as Error).message || 'analysis failed')
    return getNote(noteId)
  }
}

/**
 * Put the note in the semantic index, replacing whatever was there for it.
 *
 * addDocument builds its row id from Date.now(), so indexing the same note
 * twice would leave both versions in the index and the assistant would quote
 * a sentence the person deleted.
 */
export async function indexNote(noteId: string): Promise<boolean> {
  const note = getNote(noteId)
  if (!note || !note.content.trim()) return false

  getDatabase().run(`DELETE FROM vector_embeddings WHERE source_type = 'note' AND capture_id = ?`, [
    noteId,
  ])

  const id = await getVectorStore().addDocument(note.content.slice(0, MAX_ANALYSIS_CHARS), {
    chunkIndex: 0,
    sourceType: 'note',
    captureId: noteId,
    meetingId: note.meetingId || undefined,
    recordingId: note.recordingId || undefined,
    subject: note.title || note.suggestedTitle || undefined,
    timestamp: note.updatedAt,
  })
  return id !== null
}

export interface RelatedItem {
  kind: 'note' | 'transcript'
  id: string
  title: string
  excerpt: string
  score: number
  meetingId: string | null
  recordingId: string | null
}

/**
 * What else in the library is about this.
 *
 * The note itself always comes back first from a search of its own text, so it
 * is dropped by id rather than by comparing text.
 */
export async function findRelated(noteId: string, limit = 8): Promise<RelatedItem[]> {
  const note = getNote(noteId)
  if (!note || !note.content.trim()) return []

  const hits = await getVectorStore().search(note.content.slice(0, 2000), limit + 5)
  const out: RelatedItem[] = []
  for (const hit of hits) {
    const meta = hit.document.metadata
    const captureId = meta?.captureId
    const isNote = meta?.sourceType === 'note'
    if (isNote && captureId === noteId) continue
    if (out.length >= limit) break

    if (isNote && captureId) {
      const other = getNote(captureId)
      if (!other) continue
      out.push({
        kind: 'note',
        id: other.id,
        title: other.title || other.suggestedTitle || 'Note',
        excerpt: (hit.document.content || other.content).slice(0, 200),
        score: hit.score,
        meetingId: other.meetingId,
        recordingId: other.recordingId,
      })
      continue
    }

    out.push({
      kind: 'transcript',
      id: meta?.recordingId || hit.document.id,
      title: meta?.subject || 'Recording',
      excerpt: (hit.document.content || '').slice(0, 200),
      score: hit.score,
      meetingId: meta?.meetingId || null,
      recordingId: meta?.recordingId || null,
    })
  }
  return out
}

/**
 * The meeting happening right now, if the calendar knows of one.
 *
 * This is what a note created during a recording gets attached to. The device
 * has no recording id until its file is downloaded, and the moment cannot be
 * reconstructed afterwards, so the calendar's answer at write time is the only
 * one that is free of guessing.
 */
export function meetingHappeningNow(at: string = new Date().toISOString()): string | null {
  const row = queryOne<{ id: string }>(
    `SELECT id FROM meetings
     WHERE start_time <= ? AND end_time >= ?
     ORDER BY start_time DESC LIMIT 1`,
    [at, at]
  )
  return row?.id ?? null
}

export interface MeetingSuggestion {
  meetingId: string
  subject: string
  startTime: string
  /** Said in words, because a number the person cannot check is not a reason. */
  reason: string
  score: number
}

/**
 * Which meeting this note probably belongs to, and why.
 *
 * Two signals, both already in the database: the calendar event that covers the
 * moment the note was written, and how much the note reads like a transcript.
 * They are returned as candidates with their reason written out. Nothing here
 * links anything: a suggestion the person did not accept is not a link.
 */
export async function suggestMeetings(noteId: string, limit = 5): Promise<MeetingSuggestion[]> {
  const note = getNote(noteId)
  if (!note) return []

  const byId = new Map<string, MeetingSuggestion>()

  // Written during the meeting. The strongest signal there is, and the only one
  // that stops being recoverable once the moment has passed.
  const covering = queryAll<{ id: string; subject: string; start_time: string }>(
    `SELECT id, subject, start_time FROM meetings
     WHERE start_time <= ? AND end_time >= ?
     ORDER BY start_time DESC LIMIT 3`,
    [note.createdAt, note.createdAt]
  )
  for (const meeting of covering) {
    byId.set(meeting.id, {
      meetingId: meeting.id,
      subject: meeting.subject || 'Untitled meeting',
      startTime: meeting.start_time,
      reason: 'You wrote this while that meeting was happening.',
      score: 1,
    })
  }

  if (note.content.trim()) {
    const hits = await getVectorStore().search(note.content.slice(0, 2000), limit + 5)
    for (const hit of hits) {
      const meetingId = hit.document.metadata?.meetingId
      if (!meetingId || byId.has(meetingId)) continue
      const meeting = queryOne<{ id: string; subject: string; start_time: string }>(
        'SELECT id, subject, start_time FROM meetings WHERE id = ?',
        [meetingId]
      )
      if (!meeting) continue
      byId.set(meetingId, {
        meetingId,
        subject: meeting.subject || 'Untitled meeting',
        startTime: meeting.start_time,
        reason: 'This note says the same things as that meeting’s transcript.',
        score: hit.score,
      })
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
