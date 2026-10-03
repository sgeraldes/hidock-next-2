/**
 * What the People page and Settings show about identity questions (spec 2026-10-03, Phase 4).
 *
 * - describeDecisions: the decision journal with names, recording title and date, so each
 *   decision can be said in words and undone.
 * - listVoiceConflicts / resolveVoiceConflict: the voice conflicts written by the voice rules
 *   (speaker-linking.ts recordVoiceConflictNoSave), decided from their own card. The generic
 *   suggestion accept and reject keep refusing them: they would write the key as an alias.
 * - getQuestionCounts: pending, decided automatically and decided by the owner, per kind.
 */

import {
  assignSpeaker,
  getAmbiguousBucketIds,
  getAmbiguousBuckets,
  getIdentitySuggestionById,
  getIdentitySuggestions,
  isVoiceConflictSuggestion,
  queryAll,
  queryOne,
  runInTransaction,
  runNoSave,
  VOICE_CONFLICT_PREFIX,
  type IdentitySuggestion
} from './database'
import { filterSuggestionsForNonOwnerDisplay, revalidateSuggestionsForSurfacing } from './identity-discovery'
import { listDecisions, type IdentityDecision } from './identity-decisions'
import { isRecordingEligible } from './recording-eligibility'
import type {
  DecisionView,
  QuestionCounts,
  VoiceConflictChoice,
  VoiceConflictView
} from '../../../src/shared/identity-review'

/** A request the owner can fix by reading the message (shown as is by the page). */
export class IdentityReviewError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'SUGGESTION_STALE' | 'RECORDING_INELIGIBLE',
    message: string
  ) {
    super(message)
    this.name = 'IdentityReviewError'
  }
}

export const RECORDING_LEFT_LIBRARY =
  'That recording is no longer in the library (trashed or marked personal), so its speaker cannot be changed.'

/**
 * The suggestions the generic list shows (identity:getSuggestions): voice conflicts left out
 * (they have their own card), then the same surfacing revalidation and non-owner display gate.
 * The question counts go through this too, so Settings and People agree.
 */
export function listSurfacedSuggestions(status?: 'pending' | 'accepted' | 'rejected'): IdentitySuggestion[] {
  const listed = getIdentitySuggestions(status).filter((s) => !isVoiceConflictSuggestion(s))
  return filterSuggestionsForNonOwnerDisplay(revalidateSuggestionsForSurfacing(listed))
}

interface RecordingInfo {
  title: string | null
  date: string | null
  meetingSubject: string | null
}

function recordingInfo(recordingId: string): RecordingInfo | null {
  const row = queryOne<{ filename: string | null; date_recorded: string | null; subject: string | null; title: string | null }>(
    `SELECT r.filename, r.date_recorded, m.subject,
            (SELECT t.title_suggestion FROM transcripts t WHERE t.recording_id = r.id LIMIT 1) AS title
       FROM recordings r LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE r.id = ?`,
    [recordingId]
  )
  if (!row) return null
  return { title: row.title || row.filename || null, date: row.date_recorded, meetingSubject: row.subject || null }
}

function contactName(id: string | null | undefined): string | null {
  if (!id) return null
  return queryOne<{ name: string }>('SELECT name FROM contacts WHERE id = ?', [id])?.name ?? null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** recording:<id>:speaker:<label> or recording:<id>:mention:<bucketId>. */
function parseRecordingSubject(key: string): { recordingId: string; part: 'speaker' | 'mention'; rest: string } | null {
  const match = /^recording:(.+?):(speaker|mention):(.*)$/.exec(key)
  return match ? { recordingId: match[1], part: match[2] as 'speaker' | 'mention', rest: match[3] } : null
}

/** The name a merge folded away: the evidence when the rule kept it, else the merge journal's snapshot. */
function mergedAwayName(decision: IdentityDecision): string | null {
  const evidence = asRecord(decision.evidence)
  const fromEvidence = text(evidence.loserName)
  if (fromEvidence) return fromEvidence
  const before = asRecord(decision.before)
  const journalId = text(before.mergeJournalId)
  if (journalId) {
    const snapshot = queryOne<{ name: string | null }>(
      "SELECT json_extract(loser_snapshot, '$.name') AS name FROM merge_journal WHERE id = ? AND json_valid(loser_snapshot)",
      [journalId]
    )
    if (snapshot?.name) return snapshot.name
  }
  const suggestionId = text(evidence.suggestionId) ?? text(before.suggestionId)
  if (suggestionId) return getIdentitySuggestionById(suggestionId)?.candidate_name ?? null
  return contactName(text(before.loserId))
}

function votesOf(evidence: Record<string, unknown>): DecisionView['votes'] {
  if (!Array.isArray(evidence.votes)) return null
  const votes = { oneOnOne: 0, elimination: 0 }
  for (const vote of evidence.votes) {
    const method = asRecord(vote).method
    if (method === 'one-on-one') votes.oneOnOne++
    else if (method === 'elimination') votes.elimination++
  }
  return votes
}

function toView(decision: IdentityDecision): DecisionView {
  const evidence = asRecord(decision.evidence)
  const subject = parseRecordingSubject(decision.subjectKey)
  const recording = subject ? recordingInfo(subject.recordingId) : null

  let subjectName: string | null = null
  if (decision.kind === 'speaker' && subject) subjectName = subject.rest
  else if (decision.kind === 'mention' && subject) {
    subjectName =
      text(evidence.bucketName) ?? contactName(subject.rest) ?? text(asRecord(decision.before).sourceName)
  } else if (decision.kind === 'merge') subjectName = mergedAwayName(decision)

  const probability = typeof evidence.probability === 'number' ? evidence.probability : null
  return {
    id: decision.id,
    kind: decision.kind,
    method: decision.method,
    createdAt: decision.createdAt,
    undoneAt: decision.undoneAt,
    contactId: decision.contactId,
    personName: contactName(decision.contactId),
    subjectName,
    recordingId: subject?.recordingId ?? null,
    recordingTitle: recording?.title ?? null,
    recordingDate: recording?.date ?? null,
    meetingSubject: recording?.meetingSubject ?? null,
    probability,
    votes: decision.kind === 'voice-anchor' ? votesOf(evidence) : null
  }
}

/** The most recent automatic decisions, newest first, ready to be said in words. */
export function describeDecisions(opts: { limit?: number; includeUndone?: boolean } = {}): DecisionView[] {
  return listDecisions(opts).map(toView)
}

interface ConflictEvidence {
  recordingId?: string
  speakerLabel?: string
  voiceContactId?: string
  voiceContactName?: string | null
  boundContactId?: string
  boundContactName?: string | null
  boundSource?: string | null
}

function conflictEvidence(raw: string | null): ConflictEvidence {
  try {
    return asRecord(raw ? JSON.parse(raw) : null) as ConflictEvidence
  } catch {
    return {}
  }
}

/** The voice conflicts still waiting for the owner, newest first. */
export function listVoiceConflicts(): VoiceConflictView[] {
  const rows = queryAll<{ id: string; target_id: string; evidence: string | null }>(
    `SELECT id, target_id, evidence FROM identity_suggestions
      WHERE status = 'pending' AND kind = 'person' AND candidate_name LIKE ? || '%'
      ORDER BY created_at DESC, id`,
    [VOICE_CONFLICT_PREFIX]
  )
  const views: VoiceConflictView[] = []
  for (const row of rows) {
    const ev = conflictEvidence(row.evidence)
    if (!ev.recordingId || !ev.speakerLabel || !ev.boundContactId) continue
    const recording = recordingInfo(ev.recordingId)
    if (!recording) continue
    const voiceContactId = ev.voiceContactId ?? row.target_id
    views.push({
      id: row.id,
      recordingId: ev.recordingId,
      recordingTitle: recording.title,
      recordingDate: recording.date,
      meetingSubject: recording.meetingSubject,
      speakerLabel: ev.speakerLabel,
      voiceContactId,
      voiceContactName: contactName(voiceContactId) ?? ev.voiceContactName ?? null,
      boundContactId: ev.boundContactId,
      boundContactName: contactName(ev.boundContactId) ?? ev.boundContactName ?? null,
      boundSource: ev.boundSource ?? null
    })
  }
  return views
}

/**
 * Decide one voice conflict. 'keep' leaves the speaker as named and marks the suggestion
 * rejected; no alias is written (the suggestion's name is a key, not a person's name). 'voice'
 * names the speaker after the voice's person by hand (assignSpeaker, source 'manual') and marks
 * it accepted. When the recording left the library (trashed, personal, purged), its speaker can
 * no longer change: the question is closed (rejected, no alias) and the error says so for good.
 *
 * @throws IdentityReviewError when the suggestion is missing, not a voice conflict, already
 *   answered, or its recording left the library.
 */
export function resolveVoiceConflict(id: string, choice: VoiceConflictChoice): { status: 'accepted' | 'rejected' } {
  const result = runInTransaction((): { status: 'accepted' | 'rejected'; leftLibrary?: true } => {
    const suggestion = getIdentitySuggestionById(id)
    if (!suggestion) throw new IdentityReviewError('NOT_FOUND', 'This question no longer exists. Reload People to see what is left.')
    if (!isVoiceConflictSuggestion(suggestion)) {
      throw new IdentityReviewError('VALIDATION_ERROR', 'This question is not about a voice. Answer it from its own card.')
    }
    if (suggestion.status !== 'pending') {
      throw new IdentityReviewError('SUGGESTION_STALE', 'This question was already answered. Reload People to see what is left.')
    }
    if (choice === 'voice') {
      const ev = conflictEvidence(suggestion.evidence)
      const contactId = ev.voiceContactId ?? suggestion.target_id
      if (!ev.recordingId || !ev.speakerLabel || !contactId) {
        throw new IdentityReviewError('VALIDATION_ERROR', 'This question has lost its recording. Keep the name, then name the speaker in the recording.')
      }
      if (!isRecordingEligible(ev.recordingId)) {
        runNoSave("UPDATE identity_suggestions SET status = 'rejected' WHERE id = ?", [id])
        return { status: 'rejected', leftLibrary: true }
      }
      assignSpeaker(ev.recordingId, ev.speakerLabel, { contactId, source: 'manual', confidence: 1 })
    }
    const status = choice === 'voice' ? 'accepted' : 'rejected'
    runNoSave('UPDATE identity_suggestions SET status = ? WHERE id = ?', [status, id])
    return { status }
  })
  // Thrown after the commit, so the closed question stays closed.
  if (result.leftLibrary) throw new IdentityReviewError('RECORDING_INELIGIBLE', RECORDING_LEFT_LIBRARY)
  return { status: result.status }
}

const count = (sql: string, params: unknown[] = []): number => queryOne<{ n: number }>(sql, params)?.n ?? 0

/** Settings > Speakers & voices: pending, decided automatically, decided by the owner, per kind of question. */
export function getQuestionCounts(): QuestionCounts {
  const automatic = (kind: string) =>
    count('SELECT COUNT(*) AS n FROM identity_decisions WHERE kind = ? AND undone_at IS NULL', [kind])
  const voiceConflict = `candidate_name LIKE '${VOICE_CONFLICT_PREFIX}%'`

  const sharedFirstNames = getAmbiguousBuckets().reduce((sum, b) => sum + b.pendingCount, 0)
  const bucketIds = getAmbiguousBucketIds()
  // A suggestion a rule accepted is the rule's decision, not the owner's.
  const ruleAccepted = new Set(
    queryAll<{ suggestion_id: string | null }>(
      "SELECT json_extract(evidence_json, '$.suggestionId') AS suggestion_id FROM identity_decisions WHERE kind = 'merge'"
    )
      .map((r) => r.suggestion_id)
      .filter((v): v is string => !!v)
  )
  const ownerDuplicates = queryAll<{ id: string }>(
    `SELECT id FROM identity_suggestions
      WHERE kind = 'person' AND status IN ('accepted', 'rejected') AND NOT (${voiceConflict})`
  ).filter((r) => !ruleAccepted.has(r.id)).length

  return {
    rows: [
      {
        kind: 'shared-first-names',
        pending: sharedFirstNames,
        automatic: automatic('mention'),
        owner: count("SELECT COUNT(*) AS n FROM mention_resolutions WHERE method = 'manual'")
      },
      {
        kind: 'duplicate-people',
        // What People shows: the surfaced list, without merges whose keeper is a shared first
        // name (People answers those per meeting, IdentitySuggestionsSection).
        pending: listSurfacedSuggestions('pending').filter((s) => s.kind === 'person' && !bucketIds.has(s.target_id))
          .length,
        automatic: automatic('merge'),
        owner: ownerDuplicates
      },
      {
        kind: 'speakers',
        // A voice heard in a recording whose transcript speaker has no name yet.
        pending: count(
          `SELECT COUNT(*) AS n FROM (
             SELECT DISTINCT rvc.recording_id, rvc.transcript_speaker_label
               FROM recording_voice_clusters rvc
               JOIN recordings r ON r.id = rvc.recording_id AND r.deleted_at IS NULL
              WHERE rvc.transcript_speaker_label IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM transcript_speakers ts
                                 WHERE ts.recording_id = rvc.recording_id
                                   AND ts.speaker_label = rvc.transcript_speaker_label))`
        ),
        automatic: automatic('speaker'),
        owner: count("SELECT COUNT(*) AS n FROM transcript_speakers WHERE source = 'manual'")
      },
      {
        kind: 'voices',
        // A voice heard in a recording that is tied to nobody yet.
        pending: count(
          `SELECT COUNT(*) AS n FROM voice_clusters vc
            WHERE vc.contact_id IS NULL
              AND EXISTS (SELECT 1 FROM recording_voice_clusters rvc
                            JOIN recordings r ON r.id = rvc.recording_id AND r.deleted_at IS NULL
                           WHERE rvc.voice_cluster_id = vc.id)`
        ),
        automatic: automatic('voice-anchor'),
        owner: count("SELECT COUNT(*) AS n FROM voice_clusters WHERE contact_link_method = 'manual'")
      },
      {
        kind: 'voice-conflicts',
        pending: count(`SELECT COUNT(*) AS n FROM identity_suggestions WHERE status = 'pending' AND ${voiceConflict}`),
        automatic: 0,
        owner: count(
          `SELECT COUNT(*) AS n FROM identity_suggestions WHERE status IN ('accepted', 'rejected') AND ${voiceConflict}`
        )
      }
    ]
  }
}
