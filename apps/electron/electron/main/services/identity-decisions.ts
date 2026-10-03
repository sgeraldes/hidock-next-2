/**
 * Identity decision journal (v65; spec 2026-10-03 "People: identity questions that resolve
 * themselves", section "How decisions are recorded").
 *
 * Every automatic identity decision writes one row: what was decided (kind + subject_key), by
 * which method, the evidence, and the state before. Undo puts the state before back and marks
 * the row undone; an undone decision is never made again by the same method for the same
 * subject (callers ask wasUndone before deciding).
 *
 * subject_key names the thing decided:
 *   recording:<id>:speaker:<label>             one transcript speaker
 *   recording:<id>:mention:<bucketContactId>   one ambiguous first-name mention
 *   merge:<keeperId>:<loserId>                 a contact merge
 *   cluster:<voiceClusterId>                   a voice cluster tied to a person
 *
 * Undo of 'merge' and 'voice-anchor' comes with the PRs that make those decisions; merges
 * already have merge_journal.
 */

import { randomUUID } from 'crypto'
import { queryAll, queryOne, runNoSave, runInTransaction } from './database'
import { normalizeName } from './entity-normalize'

export type DecisionKind = 'speaker' | 'mention' | 'merge' | 'voice-anchor'

/** The transcript_speakers row a speaker decision replaced (null: there was none). */
export interface SpeakerBefore {
  recordingId: string
  speakerLabel: string
  row: {
    id: string
    contact_id: string
    source: string | null
    confidence: number | null
    created_at: string | null
  } | null
}

/** The mention_resolutions row a mention decision replaced (null: there was none). */
export interface MentionBefore {
  recordingId: string
  /** As stored: normalizeName of the spoken name. */
  sourceName: string
  row: {
    id: string
    resolved_contact_id: string | null
    method: string | null
    confidence: number | null
    created_at: string | null
  } | null
}

export interface DecisionInput {
  kind: DecisionKind
  subjectKey: string
  method: string
  contactId: string | null
  evidence: unknown
  /** SpeakerBefore for 'speaker', MentionBefore for 'mention'; whatever undo needs for the rest. */
  before: unknown
}

export interface IdentityDecision {
  id: string
  kind: DecisionKind
  subjectKey: string
  method: string
  contactId: string | null
  evidence: unknown
  before: unknown
  createdAt: string
  undoneAt: string | null
}

interface DecisionRow {
  id: string
  kind: DecisionKind
  subject_key: string
  method: string
  contact_id: string | null
  evidence_json: string
  before_json: string | null
  created_at: string
  undone_at: string | null
}

export function speakerSubjectKey(recordingId: string, speakerLabel: string): string {
  return `recording:${recordingId}:speaker:${speakerLabel}`
}

export function mentionSubjectKey(recordingId: string, bucketContactId: string): string {
  return `recording:${recordingId}:mention:${bucketContactId}`
}

/** The state before a speaker decision. Read it inside the caller's transaction, before the write. */
export function snapshotSpeakerNoSave(recordingId: string, speakerLabel: string): SpeakerBefore {
  const row = queryOne<NonNullable<SpeakerBefore['row']>>(
    `SELECT id, contact_id, source, confidence, created_at FROM transcript_speakers
     WHERE recording_id = ? AND speaker_label = ?`,
    [recordingId, speakerLabel]
  )
  return { recordingId, speakerLabel, row: row ?? null }
}

/** The state before a mention decision. Read it inside the caller's transaction, before the write. */
export function snapshotMentionNoSave(recordingId: string, sourceName: string): MentionBefore {
  const key = normalizeName(sourceName)
  const row = queryOne<NonNullable<MentionBefore['row']>>(
    `SELECT id, resolved_contact_id, method, confidence, created_at FROM mention_resolutions
     WHERE recording_id = ? AND source_name = ?`,
    [recordingId, key]
  )
  return { recordingId, sourceName: key, row: row ?? null }
}

/** Journal one decision inside the caller's transaction (no save). Returns the row id. */
export function recordDecisionNoSave(input: DecisionInput): string {
  const id = randomUUID()
  runNoSave(
    `INSERT INTO identity_decisions
       (id, kind, subject_key, method, contact_id, evidence_json, before_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.subjectKey,
      input.method,
      input.contactId,
      JSON.stringify(input.evidence ?? {}),
      input.before === null || input.before === undefined ? null : JSON.stringify(input.before),
      new Date().toISOString()
    ]
  )
  return id
}

function toDecision(row: DecisionRow): IdentityDecision {
  return {
    id: row.id,
    kind: row.kind,
    subjectKey: row.subject_key,
    method: row.method,
    contactId: row.contact_id,
    evidence: JSON.parse(row.evidence_json),
    before: row.before_json === null ? null : JSON.parse(row.before_json),
    createdAt: row.created_at,
    undoneAt: row.undone_at
  }
}

/** The most recent decisions, newest first. Undone ones only when asked for. */
export function listDecisions(opts: { limit?: number; includeUndone?: boolean } = {}): IdentityDecision[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 100))
  const rows = queryAll<DecisionRow>(
    `SELECT * FROM identity_decisions
     ${opts.includeUndone ? '' : 'WHERE undone_at IS NULL'}
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [limit]
  )
  return rows.map(toDecision)
}

/** True when a decision by this method on this subject was undone: the method must not decide it again. */
export function wasUndone(kind: DecisionKind, subjectKey: string, method: string): boolean {
  return !!queryOne(
    `SELECT 1 FROM identity_decisions
     WHERE kind = ? AND subject_key = ? AND method = ? AND undone_at IS NOT NULL LIMIT 1`,
    [kind, subjectKey, method]
  )
}

/**
 * Undo one decision: put the state before back and mark the row undone. The state is put back
 * only while the subject still holds what the decision wrote; when someone changed it since
 * (the owner picked another person), that change stays and only the mark is written, and the
 * result says `restored: false`.
 *
 * @throws when the decision does not exist, is already undone, or its kind has no undo yet.
 */
export function undoDecision(id: string): { restored: boolean } {
  return runInTransaction(() => {
    const row = queryOne<DecisionRow>('SELECT * FROM identity_decisions WHERE id = ?', [id])
    if (!row) throw new Error(`Identity decision ${id} not found`)
    if (row.undone_at) throw new Error(`Identity decision ${id} is already undone`)
    const decision = toDecision(row)

    let restored: boolean
    if (decision.kind === 'speaker') restored = undoSpeakerNoSave(decision)
    else if (decision.kind === 'mention') restored = undoMentionNoSave(decision)
    else throw new Error(`Undo of a ${decision.kind} decision is not yet available`)

    runNoSave('UPDATE identity_decisions SET undone_at = ? WHERE id = ?', [new Date().toISOString(), id])
    return { restored }
  })
}

function undoSpeakerNoSave(decision: IdentityDecision): boolean {
  const before = decision.before as SpeakerBefore | null
  if (!before) throw new Error(`Identity decision ${decision.id} has no state to restore`)
  const current = queryOne<{ contact_id: string }>(
    'SELECT contact_id FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
    [before.recordingId, before.speakerLabel]
  )
  if (!current || current.contact_id !== decision.contactId) return false

  if (before.row === null) {
    runNoSave('DELETE FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?', [
      before.recordingId,
      before.speakerLabel
    ])
  } else {
    runNoSave(
      `INSERT OR REPLACE INTO transcript_speakers
         (id, recording_id, speaker_label, contact_id, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        before.row.id,
        before.recordingId,
        before.speakerLabel,
        before.row.contact_id,
        before.row.source,
        before.row.confidence,
        before.row.created_at
      ]
    )
  }
  return true
}

function undoMentionNoSave(decision: IdentityDecision): boolean {
  const before = decision.before as MentionBefore | null
  if (!before) throw new Error(`Identity decision ${decision.id} has no state to restore`)
  const current = queryOne<{ resolved_contact_id: string | null }>(
    'SELECT resolved_contact_id FROM mention_resolutions WHERE recording_id = ? AND source_name = ?',
    [before.recordingId, before.sourceName]
  )
  if (!current || current.resolved_contact_id !== decision.contactId) return false

  if (before.row === null) {
    runNoSave('DELETE FROM mention_resolutions WHERE recording_id = ? AND source_name = ?', [
      before.recordingId,
      before.sourceName
    ])
  } else {
    runNoSave(
      `INSERT OR REPLACE INTO mention_resolutions
         (id, recording_id, source_name, resolved_contact_id, method, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        before.row.id,
        before.recordingId,
        before.sourceName,
        before.row.resolved_contact_id,
        before.row.method,
        before.row.confidence,
        before.row.created_at
      ]
    )
  }
  return true
}
