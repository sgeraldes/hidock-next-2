/**
 * Jev evaluation of recent recordings nobody asked for yet (30-sep-2026).
 *
 * The evaluation (stars, kind, work or personal, transcript trust) used to come
 * only from the Settings "Rescan with Jev" button. Nothing ran it when a new
 * transcript finished, so every recording after the last scan showed no
 * "4★ Team meeting" chip in the Library: 15 recordings from 28-sep on.
 *
 * This is the small, bounded counterpart of the scan. It looks only at the last
 * few weeks and at a handful of recordings, one at a time, and it stops at the
 * first sign that Jev is unavailable. It runs after each finished transcript and
 * once after boot, and only when Jev is the value classifier (a key is set and
 * the value job is on). The big historical scan stays a button.
 */

import { queryAll } from './database'
import { classifyCaptureValue, getValueClassifierKind, lowValueMaxSeconds } from './value-classification'
import { isCapturePrivacyBlocked, isClassifierAuthError, isValueBackfillRunning } from './value-backfill'
import { EVALUATION_VERSION } from './jev-evaluation'

/** Recordings looked at per run. A run after each transcript finds one or two. */
export const CATCHUP_LIMIT = 20
/** How far back a run looks. Older recordings belong to the Settings scan. */
export const CATCHUP_WINDOW_DAYS = 30
/** Failures in a row that end a run: Jev is down, the next call would fail too. */
export const CATCHUP_MAX_CONSECUTIVE_FAILURES = 3

export interface EvaluationCatchupResult {
  evaluated: number
  failed: number
  stopped?: 'not-jev' | 'busy' | 'auth' | 'failures'
}

let running = false
// Captures whose evaluation failed since the app started. A transcript that
// Jev cannot read would otherwise be retried on every run.
const failedThisSession = new Set<string>()

function pendingCaptureIds(limit: number, sinceDays: number): string[] {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const rows = queryAll<{ id: string }>(
    `SELECT kc.id AS id
       FROM knowledge_captures kc
       JOIN transcripts t ON t.recording_id = kc.source_recording_id
       JOIN recordings r ON r.id = kc.source_recording_id
      WHERE kc.deleted_at IS NULL
        AND COALESCE(kc.quality_source, '') != 'user'
        AND COALESCE(r.personal, 0) = 0
        AND r.deleted_at IS NULL
        AND t.full_text IS NOT NULL AND TRIM(t.full_text) != ''
        AND (r.duration_seconds IS NULL OR r.duration_seconds >= ${lowValueMaxSeconds()})
        AND r.date_recorded >= ?
        AND NOT EXISTS (
          SELECT 1 FROM recording_evaluations re WHERE re.capture_id = kc.id AND re.version >= ?
        )
      ORDER BY r.date_recorded DESC
      LIMIT ?`,
    [since, EVALUATION_VERSION, limit + failedThisSession.size]
  )
  return rows
    .map((row) => row.id)
    .filter((id) => !failedThisSession.has(id))
    .slice(0, limit)
}

/** Evaluate the recent recordings that have no evaluation yet, newest first. */
export async function evaluateRecentUnevaluated(
  opts: { limit?: number; sinceDays?: number } = {}
): Promise<EvaluationCatchupResult> {
  if (getValueClassifierKind() !== 'jev') return { evaluated: 0, failed: 0, stopped: 'not-jev' }
  if (running || isValueBackfillRunning()) return { evaluated: 0, failed: 0, stopped: 'busy' }
  running = true
  let evaluated = 0
  let failed = 0
  let consecutiveFailures = 0
  try {
    const ids = pendingCaptureIds(opts.limit ?? CATCHUP_LIMIT, opts.sinceDays ?? CATCHUP_WINDOW_DAYS)
    for (const captureId of ids) {
      // The list is a snapshot: a recording marked personal or deleted since
      // then must not reach the provider.
      if (isCapturePrivacyBlocked(captureId)) continue
      try {
        await classifyCaptureValue(captureId)
        evaluated++
        consecutiveFailures = 0
      } catch (e) {
        failed++
        consecutiveFailures++
        failedThisSession.add(captureId)
        console.warn(`[Evaluation] catch-up failed for capture ${captureId}:`, e instanceof Error ? e.message : e)
        if (isClassifierAuthError(e)) return { evaluated, failed, stopped: 'auth' }
        if (consecutiveFailures >= CATCHUP_MAX_CONSECUTIVE_FAILURES) return { evaluated, failed, stopped: 'failures' }
      }
    }
    if (evaluated > 0) console.log(`[Evaluation] catch-up evaluated ${evaluated} recent recording(s)`)
    return { evaluated, failed }
  } finally {
    running = false
  }
}

/**
 * Run the catch-up in the background and never let it reach the caller: the
 * transcription pipeline and the boot scheduler must not wait for Jev or fail
 * because of it.
 */
export function scheduleEvaluationCatchup(): void {
  void evaluateRecentUnevaluated().catch((e) => {
    console.warn('[Evaluation] catch-up error:', e instanceof Error ? e.message : e)
  })
}

export function _resetEvaluationCatchupForTests(): void {
  running = false
  failedThisSession.clear()
}
