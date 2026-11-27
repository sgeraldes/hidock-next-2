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
 * Pure apart from the refused-key file: the queue in transcription.ts asks these
 * questions and keeps the state.
 */

import { createHash } from 'crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
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

/** Only rows that failed this recently go back to waiting; older ones stay as the owner left them. */
export const REQUEUE_FAILED_WITHIN_MS = 24 * 60 * 60_000

/**
 * The same question for a row already stored as failed, read from its message
 * ("No transcription engine succeeded: configured:gemini #1 failed (credentials); ...").
 * Lets the queue put rows that failed this way in the last day back to waiting.
 * `completedAt` is SQLite's UTC "YYYY-MM-DD HH:MM:SS" (or ISO).
 */
export function failedOnlyForLackOfEngine(message: string | null | undefined, completedAt?: string | null, now: number = Date.now()): boolean {
  if (!message?.startsWith(EXHAUSTED_PREFIX)) return false
  if (completedAt !== undefined) {
    const at = completedAt ? Date.parse(completedAt.includes('T') ? completedAt : `${completedAt.replace(' ', 'T')}Z`) : NaN
    if (!Number.isFinite(at) || now - at > REQUEUE_FAILED_WITHIN_MS) return false
  }
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

type Refusal = { fingerprint: string | null; at: number; message: string }

/** Where the refused keys outlive a restart. Both calls may throw; CredentialRefusals catches them. */
export interface RefusalStore {
  read(): string | null
  write(text: string): void
}

/**
 * A small JSON file, written through a temporary file and a rename, as the
 * directed-request store does. A missing file reads as nothing stored.
 */
export function fileRefusalStore(path: () => string): RefusalStore {
  return {
    read: () => {
      try { return readFileSync(path(), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    write: (text) => {
      const target = path()
      const temporary = `${target}.${process.pid}.tmp`
      try {
        writeFileSync(temporary, text, 'utf8')
        renameSync(temporary, target)
      } catch (error) {
        // A failed write or rename leaves no temporary file behind.
        try { rmSync(temporary, { force: true }) } catch { /* the original error says what went wrong */ }
        throw error
      }
    }
  }
}

/** A provider message may quote the request URL with its key; the stored copy never does. */
function withoutKeys(message: string): string {
  return message
    .replace(/([?&](?:key|api_key|apikey)=)[^&\s"')]+/gi, '$1[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
}

function parseRefusals(text: string | null): Map<string, Refusal> {
  const refused = new Map<string, Refusal>()
  if (!text) return refused
  const data = JSON.parse(text) as { version?: unknown; refusals?: unknown }
  if (data?.version !== 1 || !data.refusals || typeof data.refusals !== 'object') return refused
  for (const [engine, entry] of Object.entries(data.refusals as Record<string, Partial<Refusal>>)) {
    if (!entry || (entry.fingerprint !== null && typeof entry.fingerprint !== 'string') ||
        !Number.isFinite(entry.at) || typeof entry.message !== 'string') continue
    refused.set(engine, { fingerprint: entry.fingerprint, at: entry.at as number, message: entry.message })
  }
  return refused
}

/**
 * Engines whose key was refused, so the chain skips them instead of calling the
 * provider again with the same key. With a store, a restart within the hour
 * skips the key too. Only the key's fingerprint is kept, never the key. A store
 * that cannot be read or written leaves the memory working on its own.
 */
export class CredentialRefusals {
  private refused: Map<string, Refusal> | null = null

  constructor(private readonly ttlMs: number = CREDENTIAL_REFUSAL_TTL_MS, private readonly store?: RefusalStore) {}

  private entries(): Map<string, Refusal> {
    if (this.refused) return this.refused
    try { this.refused = parseRefusals(this.store?.read() ?? null) }
    catch (error) {
      console.warn('[Transcription] Could not read the refused keys; starting without them:', error instanceof Error ? error.message : error)
      this.refused = new Map()
    }
    return this.refused
  }

  private persist(): void {
    if (!this.store) return
    try {
      this.store.write(JSON.stringify({ version: 1, refusals: Object.fromEntries(this.entries()) }))
    } catch (error) {
      console.warn('[Transcription] Could not store the refused keys:', error instanceof Error ? error.message : error)
    }
  }

  record(engine: string, fingerprint: string | null, message: string, now: number = Date.now()): void {
    this.entries().set(engine, { fingerprint, at: now, message: withoutKeys(message) })
    this.persist()
  }

  /** Why the engine is skipped, or null when it may be tried. */
  reason(engine: string, fingerprint: string | null, now: number = Date.now()): string | null {
    const entry = this.entries().get(engine)
    if (!entry) return null
    if (entry.fingerprint !== fingerprint || now - entry.at >= this.ttlMs) {
      this.entries().delete(engine)
      this.persist()
      return null
    }
    return `The provider refused this key (${entry.message.replace(/\s+/g, ' ').trim().slice(0, 120)}); waiting for a new key or for credit`
  }

  clear(): void {
    this.entries().clear()
    this.persist()
  }
}
