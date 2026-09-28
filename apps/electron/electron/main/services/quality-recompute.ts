/**
 * What a saved Settings > Quality checks change recomputes (28-sep-2026).
 *
 *  - An audio-versus-transcript warning key: recomputeAudioWarnings() refreshes
 *    every stored warning from numbers the database already holds.
 *  - reasonProbability: recomputeEvaluationReasons() re-derives stored reason
 *    tags from the Jev answers kept in answers_json. No Jev call.
 *  - Every other key applies to work done from now on.
 *
 * Both jobs run in the background; a failure is logged, never thrown into the
 * save that triggered it. The jobs are injected so this stays testable
 * without a database. The import of value-classification is static on
 * purpose: other main modules import it statically, and a dynamic import next
 * to a static one is the mixed-import build warning (#91).
 */

import { changedQualityKeys, WARNING_RULE_KEYS, type QualityConfig } from './quality-rules'
import { recomputeAudioWarnings, recomputeEvaluationReasons } from './value-classification'

export interface QualityRecomputeJobs {
  recomputeAudioWarnings: () => Promise<number>
  recomputeEvaluationReasons: () => Promise<number>
}

const defaultJobs: QualityRecomputeJobs = {
  recomputeAudioWarnings: () => recomputeAudioWarnings(),
  recomputeEvaluationReasons: () => recomputeEvaluationReasons()
}

/**
 * Start the recomputes a change from `prev` to `next` calls for. Returns the
 * promise of the started jobs (for tests); callers do not await it.
 */
export function recomputeForQualityChange(
  prev: QualityConfig,
  next: QualityConfig,
  jobs: QualityRecomputeJobs = defaultJobs
): Promise<void> {
  const changed = changedQualityKeys(prev, next)
  const started: Promise<void>[] = []
  if (changed.some((k) => WARNING_RULE_KEYS.includes(k))) {
    started.push(
      jobs
        .recomputeAudioWarnings()
        .then((n) => console.log(`[Quality] warning rules changed; ${n} stored warning(s) updated`))
        .catch((err: unknown) => console.error('[Quality] recomputing audio warnings failed:', err))
    )
  }
  if (changed.includes('reasonProbability')) {
    started.push(
      jobs
        .recomputeEvaluationReasons()
        .then((n) => console.log(`[Quality] reason threshold changed; ${n} stored evaluation(s) updated`))
        .catch((err: unknown) => console.error('[Quality] recomputing evaluation reasons failed:', err))
    )
  }
  return Promise.all(started).then(() => undefined)
}
