/**
 * The shapes a note crosses the IPC boundary in.
 *
 * Shared by the preload API surface and the renderer so the two cannot drift.
 * The main process has its own copy of `Note` in services/notes.ts, which is
 * where the row mapping lives; this is the wire shape.
 */

export type NoteLinkSource = 'live' | 'user' | 'suggested'
export type NoteAiStatus = 'none' | 'pending' | 'ready' | 'failed'

export interface Note {
  id: string
  /** What the person typed. Null until they type one. */
  title: string | null
  /** What the AI proposed. Never replaces `title`. */
  suggestedTitle: string | null
  content: string
  summary: string | null
  category: string | null
  /** Who decided the category. A 'user' category survives every re-analysis. */
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

export interface NoteRelatedItem {
  kind: 'note' | 'transcript'
  id: string
  title: string
  excerpt: string
  score: number
  meetingId: string | null
  recordingId: string | null
}

export interface NoteMeetingSuggestion {
  meetingId: string
  subject: string
  startTime: string
  /** Why this meeting, written out, because a score is not a reason. */
  reason: string
  score: number
}
