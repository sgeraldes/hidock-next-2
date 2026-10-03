/**
 * Whether anything may be built on a recording's transcript, and the rating
 * that follows from it.
 *
 * Spec: docs/superpowers/specs/2026-10-03-pipeline-trust-design.md, sections 3 and 4.
 *
 * A transcript is untrusted when its integrity check says 'broken' (the text
 * cannot have come from this audio: invented over noise, far more words than
 * the sound holds, looping lines, or faster than anyone speaks) and the owner
 * has not accepted it. An untrusted transcript rates its recording "no value"
 * with method 'trust'. That one rating is what keeps search, the graph, the
 * timeline, People and identity rules, speaker naming and handover away from
 * it: every one of them already honours a value exclusion. Nothing stored is
 * deleted; accepting the transcript, or a new trusted one, takes the rating
 * back.
 */

import { queryAll, queryOne, run, getRowsModified } from './database'
import { applyCaptureValueClassification, type ValueClassification } from './value-classification'

export const TRUST_REASON = 'transcript_untrusted'

const UNTRUSTED: ValueClassification = { value: 'none', reasons: [TRUST_REASON], confidence: 1 }

/** True when the recording's transcript is broken and the owner has not accepted it. */
export function isTranscriptUntrusted(recordingId: string): boolean {
  const row = queryOne<{ untrusted: number }>(
    `SELECT 1 AS untrusted FROM transcripts
      WHERE recording_id = ? AND integrity_status = 'broken' AND integrity_accepted_at IS NULL`,
    [recordingId]
  )
  return !!row
}

export interface TrustSyncResult {
  rated: number
  cleared: number
}

/**
 * Bring the 'trust' ratings in line with the transcripts: rate the recordings
 * whose transcript is untrusted, and take the rating back where it no longer
 * is. One recording, or the whole library when no id is given. Owner ratings
 * and personal recordings are never touched, and a recording the audio already
 * rated "no value" keeps that verdict, which says more (silent or noise).
 */
export function syncTrustVerdicts(recordingId?: string): TrustSyncResult {
  const scope = recordingId ? 'AND r.id = ?' : ''
  const params = recordingId ? [recordingId] : []
  const toRate = queryAll<{ id: string }>(
    `SELECT kc.id FROM knowledge_captures kc
       JOIN recordings r ON r.id = kc.source_recording_id
       JOIN transcripts t ON t.recording_id = r.id
      WHERE t.integrity_status = 'broken' AND t.integrity_accepted_at IS NULL
        AND kc.deleted_at IS NULL AND r.deleted_at IS NULL
        AND COALESCE(r.personal, 0) = 0
        AND COALESCE(kc.quality_source, '') != 'user'
        AND NOT (COALESCE(kc.quality_method, '') = 'audio' AND kc.quality_rating = 'garbage')
        AND NOT (COALESCE(kc.quality_method, '') = 'trust' AND kc.quality_rating = 'garbage')
        ${scope}`,
    params
  )
  let rated = 0
  for (const capture of toRate) {
    if (applyCaptureValueClassification(capture.id, UNTRUSTED, 'trust').applied) rated++
  }

  run(
    `UPDATE knowledge_captures
        SET quality_rating = 'unrated', quality_reasons = NULL, quality_source = NULL,
            quality_method = NULL, quality_confidence = NULL, quality_assessed_at = NULL
      WHERE quality_source = 'ai' AND quality_method = 'trust'
        AND source_recording_id IN (
          SELECT r.id FROM recordings r
           WHERE NOT EXISTS (
             SELECT 1 FROM transcripts t
              WHERE t.recording_id = r.id AND t.integrity_status = 'broken' AND t.integrity_accepted_at IS NULL
           )
           ${scope}
        )`,
    params
  )
  const cleared = getRowsModified()
  if (rated > 0 || cleared > 0) {
    console.log(`[TranscriptTrust] ${rated} recording(s) rated no value for an untrusted transcript, ${cleared} taken back`)
  }
  return { rated, cleared }
}
