/**
 * When no engine of the chain can take a recording right now, the recording
 * waits instead of failing.
 *
 * On 27-nov-2026 five queued recordings failed at launch: Gemini refused the
 * key (402, prepaid credits depleted) and the Model Host had not prepared the
 * two fallback models. Nothing was wrong with the recordings; no engine could
 * take them. A failure there needs the owner to press Retry on each one after
 * the cause is gone. Waiting needs nothing: the queue tries again once an
 * engine can run, and Operations says why it waits.
 *
 * Pure: the queue in transcription.ts asks these questions and keeps the state.
 */

import { createHash } from 'crypto'
import type { EngineAttempt } from './transcription-engine-chain'
import type { TranscriptionErrorClass } from './transcription-errors'

/** Classes that mean "this engine cannot be used now", not "this recording went wrong". */
const NO_ENGINE_CLASSES: ReadonlySet<TranscriptionErrorClass> = new Set(['credentials', 'unavailable'])

/** How long the queue waits before it looks at the engines again. A changed key or host setting clears it sooner. */
export const ENGINE_WAIT_RECHECK_MS = 5 * 60_000

/**
 * A refused key is not tried again for this long while it stays the same key.
 * Topping up credit does not change the key, so after this one more call finds out.
 */
export const CREDENTIAL_REFUSAL_TTL_MS = 60 * 60_000

const EXHAUSTED_PREFIX = 'No transcription engine succeeded: '

/** True when every attempt ended because its engine could not run: a missing or refused key, a model not prepared. */
export function noEngineCouldTakeJob(attempts: ReadonlyArray<Pick<EngineAttempt, 'outcome' | 'errorClass'>>): boolean {
  return attempts.length > 0 && attempts.every((attempt) =>
    attempt.outcome !== 'succeeded' && attempt.errorClass !== undefined && NO_ENGINE_CLASSES.has(attempt.errorClass))
}

/**
 * The same question for a row already stored as failed, read from its message
 * ("No transcription engine succeeded: configured:gemini #1 failed (credentials); ...").
 * Lets the queue put rows that failed this way before the rule existed back to waiting.
 */
export function failedOnlyForLackOfEngine(message: string | null | undefined): boolean {
  if (!message?.startsWith(EXHAUSTED_PREFIX)) return false
  const summary = message.slice(EXHAUSTED_PREFIX.length).split('. Last error:')[0]
  const attempts = summary.split('; ').map((part) => /\s#\d+ (succeeded|failed|skipped-unavailable)(?: \(([a-z]+)\))?$/.exec(part.trim()))
  if (attempts.some((match) => !match)) return false
  return noEngineCouldTakeJob(attempts.map((match) => ({
    outcome: match![1] as EngineAttempt['outcome'],
    errorClass: match![2] as TranscriptionErrorClass | undefined,
  })))
}

/** One line for Operations: each engine and why it cannot run, from the chain's attempts. */
export function engineWaitReason(attempts: ReadonlyArray<Pick<EngineAttempt, 'engine' | 'message'>>): string {
  const seen = new Set<string>()
  const parts = attempts.flatMap((attempt) => {
    if (seen.has(attempt.engine)) return []
    seen.add(attempt.engine)
    const why = (attempt.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    return [`${attempt.engine}: ${why || 'cannot run now'}`]
  })
  return `Waiting for a transcription engine. ${parts.join('; ')}`
}

/** A key's identity without keeping the key: a changed key ends its refusal. */
export function credentialFingerprint(secret: string | null | undefined): string | null {
  return secret ? createHash('sha256').update(secret).digest('hex').slice(0, 16) : null
}

/**
 * Engines whose key was refused, so the chain skips them instead of calling the
 * provider again with the same key. Kept in memory: a restart tries once more.
 */
export class CredentialRefusals {
  private readonly refused = new Map<string, { fingerprint: string | null; at: number; message: string }>()

  constructor(private readonly ttlMs: number = CREDENTIAL_REFUSAL_TTL_MS) {}

  record(engine: string, fingerprint: string | null, message: string, now: number = Date.now()): void {
    this.refused.set(engine, { fingerprint, at: now, message })
  }

  /** Why the engine is skipped, or null when it may be tried. */
  reason(engine: string, fingerprint: string | null, now: number = Date.now()): string | null {
    const entry = this.refused.get(engine)
    if (!entry) return null
    if (entry.fingerprint !== fingerprint || now - entry.at >= this.ttlMs) {
      this.refused.delete(engine)
      return null
    }
    return `The provider refused this key (${entry.message.replace(/\s+/g, ' ').trim().slice(0, 120)}); waiting for a new key or for credit`
  }

  clear(): void {
    this.refused.clear()
  }
}
