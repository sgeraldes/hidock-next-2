/**
 * Transcript validity on the stored transcripts: computes the verdict of
 * transcript-validity.ts from the database and the audio envelope, stores it
 * on the transcript row, and walks the library when the rules change.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md
 */

import { getEventBus } from './event-bus'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { queryAll, queryOne, run, runNoSave, saveDatabase } from './database'
import { getCachePath } from './file-storage'
import {
  assessTranscriptValidity,
  VALIDITY_VERSION,
  isUnusableValidity,
  type TranscriptValidity,
  type ValidityInput,
  type ValiditySegment
} from './transcript-validity'

interface ValidityRow {
  recording_id: string
  filename: string
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
    `SELECT t.recording_id, r.filename, t.speakers, t.validity_status, t.integrity_status, t.integrity_accepted_at,
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
    "SELECT quality_json FROM processing_runs WHERE recording_id = ? AND stage = 'vad' AND status = 'completed' ORDER BY started_at DESC LIMIT 1", [recordingId])
  const diarization = queryOne<{ quality_json: string | null }>(
    "SELECT quality_json FROM processing_runs WHERE recording_id = ? AND stage = 'diarization' AND provider = 'pyannote' AND status = 'completed' ORDER BY started_at DESC LIMIT 1", [recordingId])
  const parse = (json: string | null | undefined): Record<string, unknown> => {
    try { return JSON.parse(json ?? '{}') } catch { return {} }
  }
  const v = parse(vad?.quality_json)
  const d = parse(diarization?.quality_json)
  return {
    vadSpeechSeconds: typeof v.nonSilentSeconds === 'number' ? v.nonSilentSeconds : null,
    durationSeconds: typeof v.durationSeconds === 'number' ? v.durationSeconds : null,
    diarizedSegments: Array.isArray(d.segments) ? d.segments as Array<{ start: number; end: number }> : undefined
  }
}

function assess(row: ValidityRow, speakersJson: string | null, evidence?: SpeechEvidence): TranscriptValidity {
  return assessTranscriptValidity({
    fileName: row.filename,
    segments: parseSegments(speakersJson),
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
  if (isUnusableValidity(validity.status)) retireUnusableDerivedMetadata(recordingId)
  return validity
}

/** Retract machine results only. Audio, transcript text and owner decisions survive. */
function retireUnusableDerivedMetadata(recordingId: string): void {
  runNoSave(`UPDATE transcripts SET summary = NULL, title_suggestion = NULL, action_items = NULL,
    topics = NULL, key_points = NULL, sentiment = NULL, sentiment_segments = NULL, event_markers = NULL,
    question_suggestions = NULL, mentioned_people = NULL WHERE recording_id = ?`, [recordingId])
  runNoSave(`UPDATE knowledge_captures SET summary = NULL,
    title = COALESCE(user_title, (SELECT filename FROM recordings WHERE id = ?), title)
    WHERE source_recording_id = ?`, [recordingId, recordingId])
  // A calendar time match is independent of the transcript; only text-made links go.
  runNoSave(`UPDATE knowledge_captures SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL
    WHERE source_recording_id = ? AND correlation_method = 'ai_transcript_match'`, [recordingId])
  runNoSave(`UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL
    WHERE id = ? AND correlation_method = 'ai_transcript_match'`, [recordingId])
  runNoSave(`UPDATE recording_meeting_candidates SET is_selected = 0 WHERE recording_id = ?`, [recordingId])
}

/**
 * Check every transcript not yet checked under the current rules, or whose
 * linked meeting now invites a different number of people than when it was
 * checked (a meeting linked or unlinked later), in batches that yield to the
 * main thread. Idempotent: a transcript is read again only when one of those
 * changes. The integrity backfill clears validity_version on what it re-checks.
 */
export async function backfillTranscriptValidity(
  options: { batchSize?: number } = {}
): Promise<{ checked: number; changedIds: string[]; [status: string]: number | string[] }> {
  const batchSize = options.batchSize ?? 50
  const counts: Record<string, number> = { checked: 0 }
  const changedIds: string[] = []
  const seen = new Set<string>()
  for (;;) {
    const ids = queryAll<{ recording_id: string }>(
      `SELECT t.recording_id FROM transcripts t
         JOIN recordings r ON r.id = t.recording_id
         LEFT JOIN meetings m ON m.id = r.meeting_id
        WHERE r.deleted_at IS NULL
          AND (t.validity_version IS NULL OR t.validity_version < ?
               OR NOT json_valid(t.validity_json)
               OR COALESCE(json_extract(t.validity_json, '$.measures.attendees'), -1) !=
                  CASE WHEN json_valid(m.attendees) AND json_type(m.attendees) = 'array'
                       THEN json_array_length(m.attendees) ELSE 0 END)
        LIMIT ?`,
      [VALIDITY_VERSION, batchSize]
    )
    const fresh = ids.filter((row) => !seen.has(row.recording_id))
    if (fresh.length === 0) break
    for (const { recording_id } of fresh) {
      seen.add(recording_id)
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
        retireUnusableDerivedMetadata(recording_id)
        // Graph and RAG reads already share the validity eligibility gate. A wiki
        // is an external file, so explicitly reconcile it when a verdict changes.
        if (row.validity_status !== validity.status) {
          try {
            const { reconcileWikiEligibility } = await import('./meeting-wiki')
            reconcileWikiEligibility(recording_id)
          } catch (error) {
            console.warn(`[transcript-validity] Wiki cleanup failed for ${recording_id}:`, error)
          }
        }
      }
      if (row.validity_status !== validity.status) changedIds.push(recording_id)
      counts.checked++
      counts[validity.status] = (counts[validity.status] ?? 0) + 1
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (counts.checked > 0) {
    saveDatabase()
    console.log(`[transcript-validity] checked ${counts.checked} transcript(s): ${JSON.stringify(counts)}`)
  }
  if (changedIds.length > 0) {
    getEventBus().emitDomainEvent({
      type: 'transcript:verdicts-updated', timestamp: new Date().toISOString(),
      payload: { recordingIds: changedIds }
    })
  }
  return { ...counts, checked: counts.checked, changedIds }
}
