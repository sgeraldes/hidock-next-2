/**
 * Automatic retry of summaries when every provider failed (Settings >
 * Transcription). A summary that fails first goes to the next available brain
 * in the same run; this timer only covers the case where all of them failed.
 * Sebastián, 28-oct-2026: the timer must be configurable, and a manual retry
 * must exist. The defaults are the values the hidden timer of #187 used.
 */
export interface SummaryRetrySettings {
  /** false: nothing retries on its own; the manual button still works. */
  auto: boolean
  /** Minutes between automatic passes, and the wait after a failed summary. */
  everyMinutes: number
  /** Summaries tried in one pass. */
  perPass: number
  /** Billed failures a week before a summary stops retrying on its own. */
  maxPerWeek: number
}

export const DEFAULT_SUMMARY_RETRY: SummaryRetrySettings = { auto: true, everyMinutes: 120, perPass: 3, maxPerWeek: 4 }

export const SUMMARY_RETRY_BOUNDS = {
  everyMinutes: { min: 15, max: 1440 },
  perPass: { min: 1, max: 20 },
  maxPerWeek: { min: 1, max: 50 },
} as const

function bounded(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** The saved settings with defaults filled in and every number inside its bounds. */
export function summaryRetrySettings(saved?: Partial<SummaryRetrySettings> | null): SummaryRetrySettings {
  return {
    auto: saved?.auto ?? DEFAULT_SUMMARY_RETRY.auto,
    everyMinutes: bounded(saved?.everyMinutes, DEFAULT_SUMMARY_RETRY.everyMinutes, SUMMARY_RETRY_BOUNDS.everyMinutes),
    perPass: bounded(saved?.perPass, DEFAULT_SUMMARY_RETRY.perPass, SUMMARY_RETRY_BOUNDS.perPass),
    maxPerWeek: bounded(saved?.maxPerWeek, DEFAULT_SUMMARY_RETRY.maxPerWeek, SUMMARY_RETRY_BOUNDS.maxPerWeek),
  }
}
