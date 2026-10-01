/**
 * Run one AI call and leave one row in the ledger for it.
 *
 * The call runs inside its own usage collector, so whatever the adapters report while it runs (tokens,
 * model, time, a cost the CLI states) lands on this call and on no other, however many run at once. The
 * row gets the harness and model that reported, the cost estimate from `harnessRunFields`, and on failure
 * the first line of the error capped at 200 characters: an error text can echo a prompt, and the ledger
 * never holds one.
 *
 * `trackCall` never throws and returns the failure as a value, so a runner can decide what a failure
 * means. `withCallRecord` is for a call site that already handles failure by exception and only wants the
 * call recorded.
 */
import { createHarnessUsageCollector, harnessRunFields } from '../brains/harness-usage'
import { writeCall, type CallStatus } from './call-store'
import type { StepId } from './steps'

export interface CallMeta {
  step: StepId
  recordingId?: string | null
  /** How the call was routed, for the ledger: `router:chat:chat`, `direct:<profile>`, `jev`, `agentic`. */
  route: string
  /** The call that failed just before this one when this is a fallback attempt. */
  parentCallId?: string | null
}

/** A failure message when the value should count as a failed call (an empty answer), otherwise null. */
export type Judge<T> = (value: T) => string | null

export type TrackedCall<T> =
  | { ok: true; value: T; callId: string | null; provider: string | null }
  | { ok: false; error: unknown; callId: string | null; provider: string | null }

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.split(/\r?\n/)[0].slice(0, 200)
}

export async function trackCall<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<TrackedCall<T>> {
  const collector = createHarnessUsageCollector()
  const started = new Date()
  let status: CallStatus = 'completed'
  let errorMessage: string | null = null
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }

  try {
    const value = await collector.run(fn)
    const refusal = judge?.(value) ?? null
    if (refusal) {
      status = 'failed'
      errorMessage = refusal
    }
    outcome = { ok: true, value }
  } catch (error) {
    status = isAbort(error) ? 'cancelled' : 'failed'
    errorMessage = describeError(error)
    outcome = { ok: false, error }
  }

  const total = collector.total()
  const reporter = total ? Object.values(total.byModel)[0] : undefined
  const fields = harnessRunFields(total)
  const completed = new Date()
  const callId = writeCall({
    step: meta.step,
    recordingId: meta.recordingId ?? null,
    route: meta.route,
    provider: reporter?.harness ?? null,
    model: reporter && reporter.model !== 'unknown' ? reporter.model : null,
    status,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: completed.getTime() - started.getTime(),
    parentCallId: meta.parentCallId ?? null,
    usage: fields.usage ?? null,
    estimatedCostAmount: fields.estimatedCostAmount ?? null,
    estimatedCostCurrency: fields.estimatedCostCurrency ?? null,
    costMethod: fields.costMethod ?? null,
    errorMessage
  })

  const provider = reporter?.harness ?? null
  return outcome.ok ? { ok: true, value: outcome.value, callId, provider } : { ok: false, error: outcome.error, callId, provider }
}

export async function withCallRecord<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<T> {
  const tracked = await trackCall(meta, fn, judge)
  if (!tracked.ok) throw tracked.error
  return tracked.value
}
