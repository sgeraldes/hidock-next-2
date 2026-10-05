/**
 * Content ratings require a clean validity verdict. Derived content has a
 * narrower gate: only invalid text and density failures are withheld;
 * doubtful and gap-only transcripts keep their useful title and summary.
 */

import { getEventBus } from './event-bus'
import { queryOne, run, getRowsModified } from './database'
import { recomputeAudioWarnings } from './value-classification'
import { shouldWithholdDerivedContent } from './transcript-validity'
import { refreshTranscriptValidity } from './transcript-validity-store'

/**
 * True when derived content must be withheld: invalid text or a density
 * failure, unless the owner accepted it.
 */
export function isTranscriptUntrusted(recordingId: string): boolean {
  const row = queryOne<{ validity_json: string | null; validity_status: string | null; integrity_status: string | null; integrity_accepted_at: string | null }>(
    'SELECT validity_json, validity_status, integrity_status, integrity_accepted_at FROM transcripts WHERE recording_id = ?',
    [recordingId]
  )
  if (!row) return false
  if (row.integrity_accepted_at) return false
  if (row.validity_status === 'doubtful') return false
  try {
    return shouldWithholdDerivedContent({ status: row.validity_status as 'invalid', reasons: JSON.parse(row.validity_json ?? '{}').reasons ?? [] }) || (!row.validity_status && row.integrity_status === 'broken')
  } catch { return row.validity_status === 'incomplete' || row.integrity_status === 'broken' }
}

export interface TrustSyncResult {
  /** Content ratings taken back because the transcript is not valid. */
  cleared: number
  /** Old 'trust' ratings taken back. */
  withdrawn: number
}

/**
 * Bring a recording in line with its transcript after the transcript, its
 * audio profile or the owner's acceptance changed: check the validity again,
 * take back ratings read from a transcript that is not valid, and recompute
 * the stored stars, kind and context. The whole library when no id is given
 * (then the caller has run the validity backfill and recomputes itself).
 * Owner ratings, and the audio's own verdicts, are never touched.
 */
export function syncTrustVerdicts(recordingId?: string, options: { announce?: boolean } = {}): TrustSyncResult {
  const before = recordingId ? queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM knowledge_captures WHERE source_recording_id = ?
      AND quality_source = 'ai' AND quality_method = 'content'`, [recordingId])?.count ?? 0 : 0
  if (recordingId) refreshTranscriptValidity(recordingId)
  const after = recordingId ? queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM knowledge_captures WHERE source_recording_id = ?
      AND quality_source = 'ai' AND quality_method = 'content'`, [recordingId])?.count ?? 0 : 0
  const scope = recordingId ? 'AND source_recording_id = ?' : ''
  const params = recordingId ? [recordingId] : []

  run(
    `UPDATE knowledge_captures
        SET quality_rating = 'unrated', quality_reasons = NULL, quality_source = NULL,
            quality_method = NULL, quality_confidence = NULL, quality_assessed_at = NULL
      WHERE quality_source = 'ai' AND quality_method = 'trust' ${scope}`,
    params
  )
  const withdrawn = getRowsModified()

  // Retracted content ratings cannot return from stale transcript evaluations.
  // A new content assessment may rate the replacement. Personal and deleted
  // recordings are left as they are.
  run(
    `UPDATE knowledge_captures
        SET quality_rating = 'unrated', quality_reasons = NULL, quality_source = NULL,
            quality_method = NULL, quality_confidence = NULL, quality_assessed_at = NULL
      WHERE quality_source = 'ai' AND quality_method = 'content' AND deleted_at IS NULL
        AND source_recording_id IN (
          SELECT t.recording_id FROM transcripts t JOIN recordings r ON r.id = t.recording_id
           WHERE t.validity_status IN ('invalid', 'incomplete', 'doubtful')
             AND r.deleted_at IS NULL AND COALESCE(r.personal, 0) = 0
        )
        ${scope}`,
    params
  )
  const cleared = getRowsModified() + Math.max(0, before - after)

  if (recordingId) {
    // After the caller's own writes: the recompute announces the change, and
    // an open Library reloads the row.
    setImmediate(() => {
      recomputeAudioWarnings([recordingId]).catch((error) =>
        console.warn(`[TranscriptTrust] ${recordingId}: evaluation recompute failed:`, error)
      )
    })
  }
  if (withdrawn > 0 || cleared > 0) {
    console.log(`[TranscriptTrust] ${withdrawn} 'trust' rating(s) and ${cleared} content rating(s) on transcripts not valid taken back`)
  }
  if (recordingId && options.announce !== false) {
    getEventBus().emitDomainEvent({
      type: 'transcript:verdicts-updated', timestamp: new Date().toISOString(),
      payload: { recordingIds: [recordingId] }
    })
  }
  return { cleared, withdrawn }
}
