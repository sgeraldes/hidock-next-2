/**
 * Run a transcription through an ordered chain of engines and do not give up
 * easily: repeat on the same engine when the error class allows it, then move
 * to the next engine that is available right now, and record every attempt.
 *
 * Asked by the owner on 15-oct-2026 after Gemini ended four meetings in error
 * in two days (a short answer judged incomplete, and free-tier 429s) while the
 * gamestation sat idle. The chain, the retry counts and whether to fall back
 * at all are settings (Settings > Transcription).
 *
 * Pure orchestration: running an engine, probing availability, sleeping and
 * recording are injected, so the policy is tested without a network.
 * Plan: docs/superpowers/plans/2026-10-16-transcription-retry-and-fallback.md
 */

import {
  classifyTranscriptionError,
  DEFAULT_RETRY_POLICY,
  nextRetry,
  type RetryPolicy,
  type TranscriptionErrorClass,
} from './transcription-errors'
import { DEFAULT_ENGINE_CHAIN_ENTRIES } from '../../../src/shared/transcription-engines'

/**
 * One engine in the chain. `remote` runs on the paired Model Host, `local` on this computer.
 * `configured` is the provider, location and model chosen in Settings, run exactly as
 * before the chain existed. `requested` is a queue row that named its provider; `model`
 * holds that provider id.
 */
export interface EngineStep {
  provider: 'gemini' | 'remote' | 'local' | 'configured' | 'requested'
  /** Model id for remote/local engines, provider id for requested; Gemini uses the configured model. */
  model?: string
}

/**
 * Measured 16-oct-2026 on the gamestation (plan, phase C): FLEURS es-419 WER, AMI meeting WER,
 * and a real Spanish meeting (Rec08, 10 min per channel) compared with Gemini.
 * Parakeet Ultra 3.2% / 17.8% / closest word count to Gemini, 6 s per 10 min.
 * Qwen 1.7B 3.5% / 20.2% / closest text to Gemini. Parakeet v3 led FLEURS and AMI but dropped
 * about a fifth of the words of the Spanish meeting. Cohere is out: the owner rates it the worst
 * and it invented text over silence on 15-oct (Rec09).
 */
export const DEFAULT_ENGINE_CHAIN: EngineStep[] = DEFAULT_ENGINE_CHAIN_ENTRIES.map((entry) => parseEngineStep(entry)!)

/** The measured fallbacks, after the engine chosen in Settings. */
export const DEFAULT_FALLBACK_ENGINES: EngineStep[] = DEFAULT_ENGINE_CHAIN.filter((step) => step.provider !== 'configured')

export interface ChainSettings {
  chain: EngineStep[]
  retryPolicy: RetryPolicy
  /** Off: only the first engine is used, with its retries. */
  fallbackEnabled: boolean
}

export const DEFAULT_CHAIN_SETTINGS: ChainSettings = {
  chain: DEFAULT_ENGINE_CHAIN,
  retryPolicy: DEFAULT_RETRY_POLICY,
  fallbackEnabled: true,
}

export type AttemptOutcome = 'succeeded' | 'failed' | 'skipped-unavailable'

export interface EngineAttempt {
  engine: string
  attempt: number
  outcome: AttemptOutcome
  errorClass?: TranscriptionErrorClass
  message?: string
  startedAt: string
  durationMs: number
  /** Seconds waited before this attempt. */
  waitedSeconds: number
}

export interface ChainDeps<T> {
  /** Run the engine once. Throws on failure. */
  run(step: EngineStep, attempt: number): Promise<T>
  /** Null when usable now, otherwise why not (host paused, model not prepared, runner missing). */
  unavailableReason(step: EngineStep): Promise<string | null>
  sleep(seconds: number): Promise<void>
  /** Called for every attempt as it ends, so the log survives a crash in the middle of a chain. */
  record(attempt: EngineAttempt): void
  /** Stops the chain between attempts (owner cancelled, recording excluded). */
  shouldContinue(): boolean
  now?(): Date
}

export class EngineChainExhaustedError extends Error {
  constructor(readonly attempts: EngineAttempt[], readonly lastError: unknown) {
    super(
      'No transcription engine succeeded: ' +
        attempts.map((a) => `${a.engine} #${a.attempt} ${a.outcome}${a.errorClass ? ` (${a.errorClass})` : ''}`).join('; ') +
        (lastError instanceof Error ? `. Last error: ${lastError.message}` : ''),
      { cause: lastError }
    )
    this.name = 'EngineChainExhaustedError'
  }
}

export function engineLabel(step: EngineStep): string {
  if (step.provider === 'gemini' || step.provider === 'configured') return step.model ? `${step.provider}:${step.model}` : step.provider
  return `${step.provider}:${step.model ?? 'default'}`
}

/**
 * Run the chain. Returns the first success with the engine that produced it and
 * every attempt made. A `recording` or `cancelled` failure stops the chain at
 * once; anything else repeats per the policy and then moves on.
 */
export async function runEngineChain<T>(
  settings: ChainSettings,
  deps: ChainDeps<T>
): Promise<{ result: T; engine: EngineStep; attempts: EngineAttempt[] }> {
  const now = deps.now ?? (() => new Date())
  const attempts: EngineAttempt[] = []
  const steps = settings.fallbackEnabled ? settings.chain : settings.chain.slice(0, 1)
  if (!steps.length) throw new Error('No transcription engine is configured')
  let lastError: unknown = null

  // Checked between attempts only: the first run applies its own eligibility gates and
  // reports a cancelled outcome itself. A stop after a failure surfaces that failure.
  const stopped = () => attempts.length > 0 && !deps.shouldContinue()
  for (const step of steps) {
    if (stopped()) throw lastError
    const label = engineLabel(step)
    const reason = await deps.unavailableReason(step)
    if (reason) {
      const skipped: EngineAttempt = { engine: label, attempt: 0, outcome: 'skipped-unavailable', errorClass: 'unavailable',
        message: reason, startedAt: now().toISOString(), durationMs: 0, waitedSeconds: 0 }
      attempts.push(skipped)
      deps.record(skipped)
      lastError = new Error(reason)
      continue
    }
    let waitedSeconds = 0
    for (let attempt = 1; ; attempt++) {
      if (stopped()) throw lastError
      const startedAt = now()
      try {
        const result = await deps.run(step, attempt)
        const ok: EngineAttempt = { engine: label, attempt, outcome: 'succeeded', startedAt: startedAt.toISOString(),
          durationMs: now().getTime() - startedAt.getTime(), waitedSeconds }
        attempts.push(ok)
        deps.record(ok)
        return { result, engine: step, attempts }
      } catch (error) {
        lastError = error
        const classified = classifyTranscriptionError(error)
        const failed: EngineAttempt = { engine: label, attempt, outcome: 'failed', errorClass: classified.class,
          message: error instanceof Error ? error.message : String(error), startedAt: startedAt.toISOString(),
          durationMs: now().getTime() - startedAt.getTime(), waitedSeconds }
        attempts.push(failed)
        deps.record(failed)
        if (!classified.nextEngineMayHelp) throw error
        const next = nextRetry(classified, attempt, settings.retryPolicy)
        if (!next.retry) break
        waitedSeconds = next.waitSeconds
        await deps.sleep(next.waitSeconds)
      }
    }
  }
  throw new EngineChainExhaustedError(attempts, lastError)
}

/** 'gemini', 'remote:<model>' or 'local:<model>' as stored in config.transcription.engineChain. */
export function parseEngineStep(value: string): EngineStep | null {
  const text = value.trim()
  if (text === 'gemini') return { provider: 'gemini' }
  if (text === 'configured') return { provider: 'configured' }
  const match = /^(remote|local):(.+)$/.exec(text)
  if (!match || !match[2].trim()) return null
  return { provider: match[1] as 'remote' | 'local', model: match[2].trim() }
}

export function formatEngineStep(step: EngineStep): string {
  return step.provider === 'gemini' || step.provider === 'configured' ? step.provider : `${step.provider}:${step.model ?? ''}`
}

/** The chain settings from config.transcription; anything absent or unreadable takes the default. */
export function chainSettingsFromConfig(transcription: {
  /** Settings > Transcription provider and remote model: they name the configured step. */
  provider?: string
  remoteAsrModel?: string
  engineChain?: string[]
  engineRetries?: Partial<Record<TranscriptionErrorClass, number>>
  engineFallbackEnabled?: boolean
}): ChainSettings {
  const configuredProvider = transcription.provider || 'gemini'
  const saved = (Array.isArray(transcription.engineChain) ? transcription.engineChain : [])
    .map((value) => (typeof value === 'string' ? parseEngineStep(value) : null))
    .filter((step): step is EngineStep => step !== null)
  const steps = saved.length ? saved : DEFAULT_ENGINE_CHAIN
  // A fallback that is the configured engine again would only repeat its failure.
  const repeatsConfigured = (step: EngineStep) =>
    steps.some((s) => s.provider === 'configured') &&
    ((step.provider === 'gemini' && configuredProvider === 'gemini') ||
      (step.provider === 'remote' && configuredProvider === 'remote-worker' && step.model === transcription.remoteAsrModel))
  const seen = new Set<string>()
  const chain = steps
    .filter((step) => !repeatsConfigured(step))
    .map((step) => (step.provider === 'configured' ? { provider: 'configured' as const, model: configuredProvider } : step))
    .filter((step) => {
      const key = formatEngineStep(step)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const retries = { ...DEFAULT_RETRY_POLICY.retries }
  for (const [name, value] of Object.entries(transcription.engineRetries ?? {})) {
    if (name in retries && typeof value === 'number' && Number.isFinite(value)) {
      retries[name as TranscriptionErrorClass] = Math.max(0, Math.min(5, Math.floor(value)))
    }
  }
  return {
    chain,
    retryPolicy: { ...DEFAULT_RETRY_POLICY, retries },
    fallbackEnabled: transcription.engineFallbackEnabled !== false,
  }
}

/**
 * The chain for one queue row. A row that names its provider (a Retry with a
 * chosen engine, an agent's POST /transcriptions with a provider) runs only
 * that engine, with its retries: the person picked it.
 */
export function chainForRequest(settings: ChainSettings, explicitProvider: string | null | undefined): ChainSettings {
  if (!explicitProvider) return settings
  return { ...settings, chain: [{ provider: 'requested', model: explicitProvider }], fallbackEnabled: false }
}
