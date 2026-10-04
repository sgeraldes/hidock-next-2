/**
 * Transcript validity on the stored transcripts: computes the verdict of
 * transcript-validity.ts from the database and the audio envelope, stores it
 * on the transcript row, and walks the library when the rules change.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { queryAll, queryOne, run, runNoSave, saveDatabase } from './database'
import { getCachePath } from './file-storage'
import {
  assessTranscriptValidity,
  VALIDITY_VERSION,
  type TranscriptValidity,
  type ValiditySegment
} from './transcript-validity'

interface ValidityRow {
  recording_id: string
  filename: string
  speakers: string | null
  integrity_status: string | null
  integrity_accepted_at: string | null
  category: string | null
  method: string | null
  attendees: string | null
}

function readEnvelope(recordingId: string, method: string | null): Uint8Array | null {
  // Only the device's MP3 frame gains have a floor to measure against; a
  // decoded envelope stores dBFS and the gain rules do not apply to it.
  if (method !== 'mp3-frame-gain') return null
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
    `SELECT t.recording_id, r.filename, t.speakers, t.integrity_status, t.integrity_accepted_at,
            ap.category, ap.method, m.attendees
       FROM transcripts t
       JOIN recordings r ON r.id = t.recording_id
       LEFT JOIN audio_profiles ap ON ap.recording_id = t.recording_id
       LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE t.recording_id = ?`,
    [recordingId]
  )
}

function assess(row: ValidityRow, speakersJson: string | null): TranscriptValidity {
  return assessTranscriptValidity({
    fileName: row.filename,
    segments: parseSegments(speakersJson),
    envelope: readEnvelope(row.recording_id, row.method),
    audioCategory: row.category,
    attendees: attendeeCount(row.attendees),
    integrityStatus: row.integrity_status,
    accepted: !!row.integrity_accepted_at
  })
}

/**
 * The verdict a transcript would get, for lines not stored yet (the
 * transcription pipeline asks before its analysis call). The invite count is
 * the linked meeting's.
 */
export function previewTranscriptValidity(
  recordingId: string,
  speakersJson: string | null | undefined,
  options: { integrityStatus?: string | null } = {}
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
    speakersJson ?? null
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
  return validity
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
): Promise<Record<string, number>> {
  const batchSize = options.batchSize ?? 50
  const counts: Record<string, number> = { checked: 0 }
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
      counts.checked++
      counts[validity.status] = (counts[validity.status] ?? 0) + 1
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (counts.checked > 0) {
    saveDatabase()
    console.log(`[transcript-validity] checked ${counts.checked} transcript(s): ${JSON.stringify(counts)}`)
  }
  return counts
}
