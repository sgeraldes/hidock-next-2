/**
 * Transcript validity on the stored transcripts: computes the verdict of
 * transcript-validity.ts from the database and the audio envelope, stores it
 * on the transcript row, and walks the library when the rules change.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md
 */

import { yieldToEventLoop } from './event-loop'
import { getEventBus } from './event-bus'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { queryAll, queryOne, run, runNoSave, runInTransaction, saveDatabase, acquireOrganizationCheckpointBudget } from './database'
import { getCachePath } from './file-storage'
import {
  assessTranscriptValidity,
  VALIDITY_VERSION,
  isUnusableValidity,
  shouldWithholdDerivedContent,
  type TranscriptValidity,
  type ValidityInput,
  type ValiditySegment
} from './transcript-validity'

interface ValidityRow {
  recording_id: string
  filename: string
  full_text?: string | null
  word_count?: number | null
  speakers: string | null
  validity_status?: string | null
  integrity_status: string | null
  integrity_accepted_at: string | null
  category: string | null
  method: string | null
  attendees: string | null
  sample_fingerprint?: string | null
  sample_verdict?: string | null
}

/** Identifies the transcript a sample was taken of: a new or edited transcript has another. */
export function transcriptFingerprint(speakersJson: string | null | undefined): string {
  return createHash('sha1').update(speakersJson ?? '').digest('hex')
}

export function readEnvelope(recordingId: string, method: string | null): Uint8Array | null {
  // MP3 frame gains for the device's files, dBFS + 100 for a decoded import;
  // envelopeUnit tells the verdict which.
  if (method !== 'mp3-frame-gain' && method !== 'decoded') return null
  // The path envelopePath (audio-profile-store.ts) writes; importing it here
  // would close an import cycle through transcript-trust.ts.
  const path = join(getCachePath(), 'audio-envelope', `${recordingId}.u8`)
  if (!existsSync(path)) return null
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
}

function parseSegments(json: string | null): ValiditySegment[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as ValiditySegment[]) : []
  } catch {
    return []
  }
}

function attendeeCount(json: string | null): number {
  if (!json) return 0
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function rowFor(recordingId: string): ValidityRow | undefined {
  return queryOne<ValidityRow>(
    `SELECT t.recording_id, r.filename, t.full_text, t.word_count, t.speakers, t.validity_status, t.integrity_status, t.integrity_accepted_at,
            ap.category, ap.method, m.attendees,
            s.transcript_fingerprint AS sample_fingerprint, s.verdict AS sample_verdict
       FROM transcripts t
       JOIN recordings r ON r.id = t.recording_id
       LEFT JOIN audio_profiles ap ON ap.recording_id = t.recording_id
       LEFT JOIN meetings m ON m.id = r.meeting_id
       LEFT JOIN transcript_samples s ON s.recording_id = t.recording_id
      WHERE t.recording_id = ?`,
    [recordingId]
  )
}

type SpeechEvidence = Pick<ValidityInput, 'diarizedSegments' | 'vadSpeechSeconds' | 'providerSeconds' | 'durationSeconds'>

/** Independent evidence is retained in the ledger, including failed transcription attempts. */
export function readSpeechEvidence(recordingId: string): SpeechEvidence {
  const vad = queryOne<{ quality_json: string | null }>(
    `SELECT quality_json FROM processing_runs WHERE recording_id = ? AND stage = 'vad' AND status = 'completed'
      AND json_valid(quality_json) AND json_type(quality_json, '$.nonSilentSeconds') IN ('integer', 'real')
      ORDER BY started_at DESC LIMIT 1`, [recordingId])
  const diarization = queryOne<{ quality_json: string | null }>(
    "SELECT quality_json FROM processing_runs WHERE recording_id = ? AND stage = 'diarization' AND provider = 'pyannote' AND status = 'completed' ORDER BY started_at DESC LIMIT 1", [recordingId])
  const parse = (json: string | null | undefined): Record<string, unknown> => {
    try { return JSON.parse(json ?? '{}') } catch { return {} }
  }
  const v = parse(vad?.quality_json)
  const d = parse(diarization?.quality_json)
  const profile = queryOne<{ sound_seconds: number; duration_seconds: number }>(
    "SELECT sound_seconds, duration_seconds FROM audio_profiles WHERE recording_id = ? AND category = 'speech'", [recordingId])
  const provider = queryOne<{ usage_json: string | null }>(
    `SELECT pr.usage_json FROM processing_runs pr JOIN transcripts t ON t.transcription_run_id = pr.id
      WHERE t.recording_id = ?`, [recordingId])
  const traces = parse(provider?.usage_json).providerTimeline
  const completed = Array.isArray(traces) ? traces.filter(e => e.phase === 'provider-transcription' && e.status === 'completed' && typeof e.elapsedMs === 'number') : []
  const persisted = queryAll<{ start: number; end: number }>(
    `SELECT start, end FROM diarized_segments WHERE recording_id = ? AND run_id =
      (SELECT diarization_run_id FROM transcripts WHERE recording_id = ?) ORDER BY segment_index`, [recordingId, recordingId])
  return {
    // Historical recordings predate the VAD ledger. Their independent frame
    // activity profile retains non-silent seconds; use it only for speech audio,
    // never transcript timestamps or file duration as a speech estimate.
    vadSpeechSeconds: typeof v.nonSilentSeconds === 'number' ? v.nonSilentSeconds : profile?.sound_seconds ?? null,
    durationSeconds: typeof v.durationSeconds === 'number' ? v.durationSeconds : profile?.duration_seconds ?? null,
    providerSeconds: completed.length ? completed.reduce((sum, e) => sum + e.elapsedMs, 0) / 1000 : null,
    diarizedSegments: persisted.length ? persisted : Array.isArray(d.segments) ? d.segments as Array<{ start: number; end: number }> : undefined
  }
}

function assess(row: ValidityRow, speakersJson: string | null, evidence?: SpeechEvidence): TranscriptValidity {
  return assessTranscriptValidity({
    fileName: row.filename,
    segments: parseSegments(speakersJson),
    fullText: row.full_text,
    storedWordCount: row.word_count,
    envelope: readEnvelope(row.recording_id, row.method),
    envelopeUnit: row.method === 'decoded' ? 'db' : 'gain',
    audioCategory: row.category,
    attendees: attendeeCount(row.attendees),
    integrityStatus: row.integrity_status,
    accepted: !!row.integrity_accepted_at,
    sample: sampleFor(row, speakersJson),
    ...(evidence ?? readSpeechEvidence(row.recording_id))
  })
}

/** The stored sample's verdict, when it was taken of these very lines. */
function sampleFor(
  row: ValidityRow,
  speakersJson: string | null
): 'confirmed' | 'contradicted' | 'inconclusive' | 'incomplete' | null {
  if (!row.sample_verdict || row.sample_fingerprint !== transcriptFingerprint(speakersJson)) return null
  const v = row.sample_verdict
  return v === 'confirmed' || v === 'contradicted' || v === 'incomplete' ? v : 'inconclusive'
}

/**
 * The verdict a transcript would get, for lines not stored yet (the
 * transcription pipeline asks before its analysis call). The invite count is
 * the linked meeting's.
 */
export function previewTranscriptValidity(
  recordingId: string,
  speakersJson: string | null | undefined,
  options: { integrityStatus?: string | null } & SpeechEvidence = {}
): TranscriptValidity | null {
  const recording = queryOne<{ filename: string; attendees: string | null }>(
    `SELECT r.filename, m.attendees FROM recordings r LEFT JOIN meetings m ON m.id = r.meeting_id WHERE r.id = ?`,
    [recordingId]
  )
  if (!recording) return null
  const profile = queryOne<{ category: string | null; method: string | null }>(
    'SELECT category, method FROM audio_profiles WHERE recording_id = ?',
    [recordingId]
  )
  return assess(
    {
      recording_id: recordingId,
      filename: recording.filename,
      speakers: null,
      integrity_status: options.integrityStatus ?? null,
      integrity_accepted_at: null,
      category: profile?.category ?? null,
      method: profile?.method ?? null,
      attendees: recording.attendees
    },
    speakersJson ?? null,
    options.vadSpeechSeconds !== undefined || options.diarizedSegments !== undefined ? options : undefined
  )
}

/** Compute and store a recording's transcript validity. Null when it has no transcript. */
export function refreshTranscriptValidity(recordingId: string): TranscriptValidity | null {
  const row = rowFor(recordingId)
  if (!row) return null
  const validity = assess(row, row.speakers)
  run('UPDATE transcripts SET validity_status = ?, validity_json = ?, validity_version = ? WHERE recording_id = ?', [
    validity.status,
    JSON.stringify(validity),
    VALIDITY_VERSION,
    recordingId
  ])
  if (isUnusableValidity(validity.status)) {
    retractContentRating(recordingId)
    if (shouldWithhold(validity)) retireUnusableDerivedMetadata(recordingId)
  }
  if (!shouldWithhold(validity)) restoreWithheldMetadata(recordingId)
  validity.measures.attendees = attendeeCount(rowFor(recordingId)?.attendees ?? null)
  run('UPDATE transcripts SET validity_json = ? WHERE recording_id = ?', [JSON.stringify(validity), recordingId])
  return validity
}

/** A bad transcript cannot keep its own content rating as a recovery gate. */
function retractContentRating(recordingId: string): void {
  runNoSave(`UPDATE knowledge_captures SET quality_rating = 'unrated', quality_reasons = NULL,
    quality_source = NULL, quality_method = NULL, quality_confidence = NULL, quality_assessed_at = NULL
    WHERE source_recording_id = ? AND quality_source = 'ai' AND quality_method = 'content'
      AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = source_recording_id
        AND r.deleted_at IS NULL AND COALESCE(r.personal, 0) = 0)`, [recordingId])
}

const derivedFields = ['summary', 'title_suggestion', 'action_items', 'topics', 'key_points', 'sentiment',
  'sentiment_segments', 'event_markers', 'question_suggestions', 'mentioned_people'] as const

function shouldWithhold(validity: TranscriptValidity): boolean {
  return shouldWithholdDerivedContent(validity)
}

function metadataFingerprint(row: { speakers?: unknown; full_text?: unknown }): string {
  return transcriptFingerprint(JSON.stringify([row.speakers ?? null, row.full_text ?? null]))
}

function restoreWithheldMetadata(recordingId: string): boolean {
  return runInTransaction(() => restoreWithheldMetadataInTransaction(recordingId))
}

function restoreWithheldMetadataInTransaction(recordingId: string): boolean {
  const saved = queryOne<{ transcript_fingerprint: string; values_json: string }>(
    'SELECT * FROM transcript_withheld_metadata WHERE recording_id = ?', [recordingId])
  const current = queryOne<{ speakers: string | null; full_text: string }>('SELECT speakers, full_text FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!saved || !current || saved.transcript_fingerprint !== metadataFingerprint(current)) return false
  const values = JSON.parse(saved.values_json) as { transcript: Record<string, unknown>; captures: Array<Record<string, unknown>>; recording?: Record<string, unknown>; candidates?: Array<{ id: string; is_selected: number }> }
  for (const field of derivedFields) runNoSave(`UPDATE transcripts SET ${field} = COALESCE(${field}, ?) WHERE recording_id = ?`, [values.transcript[field] ?? null, recordingId])
  for (const capture of values.captures) {
    if (capture.summary_source === 'ai') runNoSave(`UPDATE knowledge_captures SET summary = COALESCE(summary, ?) WHERE id = ? AND summary_source = 'ai'`, [capture.summary ?? null, capture.id])
    if (capture.correlation_method === 'ai_transcript_match') runNoSave(`UPDATE knowledge_captures SET meeting_id = ?, correlation_confidence = ?, correlation_method = ?
      WHERE id = ? AND meeting_id IS NULL AND correlation_method IS NULL`, [capture.meeting_id, capture.correlation_confidence, capture.correlation_method, capture.id])
  }
  if (values.recording?.correlation_method === 'ai_transcript_match') runNoSave(`UPDATE recordings SET meeting_id = ?, correlation_confidence = ?, correlation_method = ?
    WHERE id = ? AND meeting_id IS NULL AND correlation_method IS NULL`, [values.recording.meeting_id, values.recording.correlation_confidence, values.recording.correlation_method, recordingId])
  for (const candidate of values.candidates ?? []) runNoSave(`UPDATE recording_meeting_candidates SET is_selected = ? WHERE id = ?
    AND is_user_confirmed = 0 AND is_ai_selected = 1 AND EXISTS (SELECT 1 FROM recordings r
      WHERE r.id = recording_meeting_candidates.recording_id AND r.correlation_method = 'ai_transcript_match'
        AND r.meeting_id = recording_meeting_candidates.meeting_id)`, [candidate.is_selected, candidate.id])
  runNoSave('DELETE FROM transcript_withheld_metadata WHERE recording_id = ?', [recordingId])
  return true
}

/** Retract machine results only. Audio, transcript text and owner decisions survive. */
function retireUnusableDerivedMetadata(recordingId: string): void {
  runInTransaction(() => retireUnusableDerivedMetadataInTransaction(recordingId))
}

function retireUnusableDerivedMetadataInTransaction(recordingId: string): void {
  const transcript = queryOne<Record<string, unknown>>('SELECT * FROM transcripts WHERE recording_id = ?', [recordingId])
  if (!transcript) return
  const captures = queryAll<Record<string, unknown>>(`SELECT id, summary, summary_source, meeting_id, correlation_confidence, correlation_method FROM knowledge_captures
    WHERE source_recording_id = ? AND (summary_source = 'ai' OR correlation_method = 'ai_transcript_match')`, [recordingId])
  const recording = queryOne<Record<string, unknown>>('SELECT meeting_id, correlation_confidence, correlation_method FROM recordings WHERE id = ?', [recordingId])
  const candidates = recording?.correlation_method === 'ai_transcript_match' ? queryAll<{ id: string; is_selected: number }>(
    'SELECT id, is_selected FROM recording_meeting_candidates WHERE recording_id = ? AND is_ai_selected = 1 AND is_user_confirmed = 0', [recordingId]) : []
  runNoSave(`INSERT INTO transcript_withheld_metadata (recording_id, transcript_fingerprint, values_json, withheld_at, validity_version)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(recording_id) DO UPDATE SET
      transcript_fingerprint = excluded.transcript_fingerprint, values_json = excluded.values_json,
      withheld_at = excluded.withheld_at, validity_version = excluded.validity_version
    WHERE transcript_withheld_metadata.transcript_fingerprint != excluded.transcript_fingerprint`,
    [recordingId, metadataFingerprint(transcript),
      JSON.stringify({ transcript: Object.fromEntries(derivedFields.map(field => [field, transcript[field]])), captures, recording, candidates }), new Date().toISOString(), VALIDITY_VERSION])
  runNoSave(`UPDATE transcripts SET summary = NULL, title_suggestion = NULL, action_items = NULL,
    topics = NULL, key_points = NULL, sentiment = NULL, sentiment_segments = NULL, event_markers = NULL,
    question_suggestions = NULL, mentioned_people = NULL WHERE recording_id = ?`, [recordingId])
  runNoSave(`UPDATE knowledge_captures SET summary = NULL
    WHERE source_recording_id = ? AND summary_source = 'ai'`, [recordingId])
  // A calendar time match is independent of the transcript; only text-made links go.
  runNoSave(`UPDATE recording_meeting_candidates SET is_selected = 0 WHERE recording_id = ?
    AND is_ai_selected = 1 AND is_user_confirmed = 0
    AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND correlation_method = 'ai_transcript_match')`, [recordingId, recordingId])
  runNoSave(`UPDATE knowledge_captures SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL
    WHERE source_recording_id = ? AND correlation_method = 'ai_transcript_match'`, [recordingId])
  runNoSave(`UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL
    WHERE id = ? AND correlation_method = 'ai_transcript_match'`, [recordingId])
}

/**
 * Check every transcript not yet checked under the current rules, or whose
 * linked meeting now invites a different number of people than when it was
 * checked (a meeting linked or unlinked later), in batches that yield to the
 * main thread. Idempotent: a transcript is read again only when one of those
 * changes. The integrity backfill clears validity_version on what it re-checks.
 */
let backfillTail: Promise<void> = Promise.resolve()
type BackfillOptions = { batchSize?: number; onHold?: (ms: number) => void }
type BackfillResult = { checked: number; changedIds: string[]; [status: string]: number | string[] }

/** Serialize Library and deferred organization passes so neither samples half-settled links. */
export function backfillTranscriptValidity(options: BackfillOptions = {}): Promise<BackfillResult> {
  const pass = backfillTail.then(() => runValidityBackfill(options))
  backfillTail = pass.then(() => undefined, () => undefined)
  return pass
}

async function runValidityBackfill(
  options: { batchSize?: number; onHold?: (ms: number) => void } = {}
): Promise<{ checked: number; changedIds: string[]; [status: string]: number | string[] }> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 1, 1))
  let rowsInSlice = 0
  let sliceStart = performance.now()
  let worstHoldMs = 0
  const checkpoint = async (): Promise<void> => {
    const hold = performance.now() - sliceStart
    worstHoldMs = Math.max(worstHoldMs, hold)
    options.onHold?.(hold)
    if (hold >= 100) console.warn(`[transcript-validity] batch held the main thread for ${Math.round(hold)}ms`)
    await yieldToEventLoop()
    rowsInSlice = 0
    sliceStart = performance.now()
  }
  const counts: Record<string, number> = { checked: 0 }
  const changedIds: string[] = []
  const metadataChangedIds: string[] = []
  let afterId = ''
  const releaseCheckpointBudget = acquireOrganizationCheckpointBudget()
  try {
    for (;;) {
      const ids = queryAll<{ recording_id: string; stale: number }>(
        `SELECT t.recording_id, CASE WHEN
             t.validity_version IS NULL OR t.validity_version < ?
             OR NOT json_valid(t.validity_json)
             OR COALESCE(json_extract(CASE WHEN json_valid(t.validity_json) THEN t.validity_json ELSE '{}' END, '$.measures.attendees'), -1) !=
                CASE WHEN json_valid(m.attendees) AND json_type(m.attendees) = 'array'
                     THEN json_array_length(m.attendees) ELSE 0 END
           THEN 1 ELSE 0 END AS stale
           FROM transcripts t
           JOIN recordings r ON r.id = t.recording_id
           LEFT JOIN meetings m ON m.id = r.meeting_id
          WHERE r.deleted_at IS NULL AND t.recording_id > ?
          ORDER BY t.recording_id LIMIT ?`,
        [VALIDITY_VERSION, afterId, 128]
      )
      if (ids.length === 0) break
      afterId = ids[ids.length - 1].recording_id
      const fresh = ids.filter(row => row.stale === 1)
      for (const { recording_id } of fresh) {
        const row = rowFor(recording_id)
        if (!row) continue
        const validity = assess(row, row.speakers)
        runNoSave('UPDATE transcripts SET validity_status = ?, validity_json = ?, validity_version = ? WHERE recording_id = ?', [
          validity.status,
          JSON.stringify(validity),
          VALIDITY_VERSION,
          recording_id
        ])
        if (isUnusableValidity(validity.status)) {
          retractContentRating(recording_id)
          if (shouldWithhold(validity)) retireUnusableDerivedMetadata(recording_id)
          // Graph and RAG reads already share the validity eligibility gate. A wiki
          // is an external file, so explicitly reconcile it when a verdict changes.
          if (shouldWithhold(validity) && row.validity_status !== validity.status) {
            try {
              await checkpoint()
              const { reconcileWikiEligibility } = await import('./meeting-wiki')
              rowsInSlice = 0
              sliceStart = performance.now()
              reconcileWikiEligibility(recording_id)
            } catch (error) {
              console.warn(`[transcript-validity] Wiki cleanup failed for ${recording_id}:`, error)
            }
          }
        }
        const restoredMetadata = !shouldWithhold(validity) && restoreWithheldMetadata(recording_id)
        const linked = queryOne<{ attendees: string | null }>(`SELECT m.attendees FROM recordings r LEFT JOIN meetings m ON m.id = r.meeting_id WHERE r.id = ?`, [recording_id])
        validity.measures.attendees = attendeeCount(linked?.attendees ?? null)
        runNoSave('UPDATE transcripts SET validity_json = ? WHERE recording_id = ?', [JSON.stringify(validity), recording_id])
        if (restoredMetadata || row.validity_status !== validity.status) changedIds.push(recording_id)
        if (restoredMetadata || (shouldWithhold(validity) && row.validity_status !== validity.status)) metadataChangedIds.push(recording_id)
        counts.checked++
        counts[validity.status] = (counts[validity.status] ?? 0) + 1
        if (++rowsInSlice >= batchSize || performance.now() - sliceStart >= 20) await checkpoint()
      }
      await checkpoint()
    }
  } finally { releaseCheckpointBudget() }
  if (counts.checked > 0) {
    saveDatabase()
    console.log(`[transcript-validity] checked ${counts.checked} transcript(s): ${JSON.stringify(counts)}; worst main-thread hold ${worstHoldMs.toFixed(1)}ms`)
  }
  if (counts.checked === 0) console.log('[transcript-validity] checked 0 transcript(s)')
  if (changedIds.length > 0) {
    getEventBus().emitDomainEvent({
      type: 'transcript:verdicts-updated', timestamp: new Date().toISOString(),
      payload: { recordingIds: changedIds, metadataChangedIds }
    })
  }
  return { ...counts, checked: counts.checked, changedIds, ...(counts.checked > 0 ? { worstHoldMs } : {}) }
}
