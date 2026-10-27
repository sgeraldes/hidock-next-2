/**
 * What kind of failure a transcription attempt ended in, decided in one place.
 *
 * Until 16-oct-2026 the queue matched raw messages against a list of
 * "non-retryable" fragments, so a quota answer that said "Please retry in 39s"
 * stopped the recording for good, and a Gemini answer judged short ended it in
 * `error` with no second engine tried. The class decides what happens next:
 * wait and repeat, split the interval, move to the next engine, or stop.
 *
 * The patterns come from messages seen in the queue and logs, 13-15 Oct 2026.
 * Plan: docs/superpowers/plans/2026-10-16-transcription-retry-and-fallback.md
 */

import { DEFAULT_ENGINE_RETRIES } from '../../../src/shared/transcription-engines'

/**
 * The wait a provider asks for, in seconds: "retry in 52s", "1m30s", or a
 * daily quota's "18h17m50s" (27-oct-2026). The Gemini engine reads the same
 * forms (packages/transcription gemini-engine.ts retryAfterSeconds); this
 * module stays free of the engine so the classifier needs no mocks.
 */
function retryAfterSeconds(message: string): number | null {
  const phrase = /retry in\s+((?:\d+(?:\.\d+)?\s*(?:h|ms|m|s)\s*)+)/i.exec(message)?.[1]
  if (!phrase) return null
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 }
  let total = 0
  for (const [, value, name] of phrase.matchAll(/(\d+(?:\.\d+)?)\s*(h|ms|m|s)/gi)) total += Number(value) * unit[name.toLowerCase()]
  return total
}

export type TranscriptionErrorClass =
  /** Network, 5xx, timeouts, a remote job in a temporary state: the same engine may succeed shortly. */
  | 'transient'
  /** The provider's rate limit or quota: wait (as long as it asks) and repeat. */
  | 'quota'
  /** The engine answered, but the text stops while the voice goes on. */
  | 'incomplete'
  /** The engine cannot be used right now: not paired, model not prepared, runner missing, host away. */
  | 'unavailable'
  /** No key, a rejected key, no credit: no repeat helps until the owner acts. */
  | 'credentials'
  /** This engine cannot take this audio or setting (format, length, language). Another engine may. */
  | 'input'
  /** The recording itself is missing or excluded: no engine can help. */
  | 'recording'
  /** Cancelled by the owner or because the recording became ineligible. */
  | 'cancelled'
  | 'unknown'

export interface ClassifiedError {
  class: TranscriptionErrorClass
  /** Seconds the provider asked to wait, when it said so. */
  retryAfterSeconds?: number
  /** Whether a later engine in the chain could still succeed. */
  nextEngineMayHelp: boolean
}

const RULES: Array<{ test: RegExp; class: TranscriptionErrorClass }> = [
  { test: /cancell?ed|became ineligible|no longer eligible|TranscriptionCancelled/i, class: 'cancelled' },
  { test: /Recording not found|no local file|Recording file not found|personal, deleted|is not eligible/i, class: 'recording' },
  { test: /\b429\b|rate limit|quota|RESOURCE_EXHAUSTED|too many requests/i, class: 'quota' },
  { test: /API key not configured|API key not valid|invalid api key|PERMISSION_DENIED|\b401\b|\b403\b|billing|credit/i, class: 'credentials' },
  { test: /not advertised the selected ASR engine|Pair (a|with the) (remote worker|model host)|runner not found|failed to spawn|No module named|ECONNREFUSED|stepped aside|step-aside|host (is )?(paused|unavailable)|Remote transcription requires HTTPS/i, class: 'unavailable' },
  { test: /Provider response retained|covers \d+% of the|ends \d+s before the end|could not produce a complete, reliable transcript|interaction incomplete|output truncated|incomplete (interval|coverage)|unreliable (interval|timing)|text ends at .* voice continues/i, class: 'incomplete' },
  { test: /Audio too long|AudioLoadError|unsupported language|requires an explicit language|supports explicit English or Chinese|not splittable|could not be split|requires recordings over 30 minutes|empty transcript|Provider timestamps failed local audio grounding|memory limit|memory budget|insufficient memory|out of memory|MemoryError/i, class: 'input' },
  { test: /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed? ?out|\b50[0234]\b|UNAVAILABLE|INTERNAL|Remote worker (failed|awaiting-upload|timeout)|retained job identity|Interrupted:/i, class: 'transient' },
]

const NEXT_ENGINE_MAY_HELP: Record<TranscriptionErrorClass, boolean> = {
  transient: true, quota: true, incomplete: true, unavailable: true, credentials: true, input: true,
  recording: false, cancelled: false, unknown: true,
}

/** Classify an error or message from any engine. Unknown errors may still try the next engine. */
export function classifyTranscriptionError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const rule = RULES.find((r) => r.test.test(message))
  const errorClass = rule?.class ?? 'unknown'
  // "retry in 52s", "1m30s" or a daily quota's "18h17m50s"; a bare Retry-After is seconds.
  const header = /retry[- ]after[: ]+(\d+)/i.exec(message)
  const wait = retryAfterSeconds(message) ?? (header ? Number(header[1]) : null)
  return {
    class: errorClass,
    ...(wait !== null ? { retryAfterSeconds: Math.ceil(wait) } : {}),
    nextEngineMayHelp: NEXT_ENGINE_MAY_HELP[errorClass],
  }
}

export interface RetryPolicy {
  /** Extra attempts on the same engine, per class. Classes not listed get none. */
  retries: Partial<Record<TranscriptionErrorClass, number>>
  /** Wait between attempts when the provider gave no time, in seconds, one entry per attempt (the last repeats). */
  backoffSeconds: number[]
  /** Longest wait honoured when the provider asks for one. */
  maxWaitSeconds: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: { ...DEFAULT_ENGINE_RETRIES, incomplete: 0, unavailable: 0, credentials: 0, input: 0 },
  backoffSeconds: [30, 60, 120],
  maxWaitSeconds: 180,
}

/**
 * Whether to repeat on the same engine after `attempt` failed attempts (1 =
 * the first try failed), and how long to wait first. `incomplete` is handled
 * by the engine itself (it splits the interval once), so the policy here only
 * says whether to repeat the whole request.
 */
export function nextRetry(
  classified: ClassifiedError,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): { retry: boolean; waitSeconds: number } {
  const allowed = policy.retries[classified.class] ?? 0
  if (attempt > allowed) return { retry: false, waitSeconds: 0 }
  const fallback = policy.backoffSeconds[Math.min(attempt - 1, policy.backoffSeconds.length - 1)] ?? 30
  // Asked to wait longer than the policy allows (an hourly or daily quota): the
  // same engine cannot help now, so the next one runs instead (27-oct-2026).
  if (classified.retryAfterSeconds != null && classified.retryAfterSeconds > policy.maxWaitSeconds) {
    return { retry: false, waitSeconds: 0 }
  }
  const waitSeconds = Math.min(policy.maxWaitSeconds, classified.retryAfterSeconds != null ? classified.retryAfterSeconds + 2 : fallback)
  return { retry: true, waitSeconds }
}
