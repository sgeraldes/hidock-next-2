/**
 * Model discovery for the Pipeline page's model combobox.
 *
 * Contract: never throws, never waits longer than the timeout, asks a harness once for callers that
 * arrive together, and remembers a good answer for a minute and a failed one for five seconds (so a
 * server the owner starts a moment later shows up, and a dead one is not asked on every keystroke).
 * A harness that cannot list its models has a built-in list here, or none: the combobox always takes
 * free text.
 */
import { CURRENT_GEMINI_CHAT_MODEL } from '../gemini-model-ids'
import type { ModelInfo } from './descriptor'
import type { AIBrain, BrainId } from './types'

const TTL_MS = 60_000
const FAILURE_TTL_MS = 5_000
const TIMEOUT_MS = 6_000

/** Models known without asking. Claude Code takes aliases; the other CLIs take free text. */
export const STATIC_MODELS: Partial<Record<BrainId, ModelInfo[]>> = {
  'claude-code': [
    { id: 'haiku', label: 'Haiku', note: 'small and fast' },
    { id: 'sonnet', label: 'Sonnet', note: 'balanced' },
    { id: 'opus', label: 'Opus', note: 'strongest, slowest' }
  ],
  'gemini-cli': [{ id: CURRENT_GEMINI_CHAT_MODEL }]
}

interface Entry {
  models: ModelInfo[]
  expiresAt: number
  /** True when the list came from the harness, false when it is the built-in or the empty fallback. */
  fresh: boolean
}

const cache = new Map<BrainId, Entry>()
const inflight = new Map<BrainId, Promise<ModelInfo[]>>()

export function resetModelDiscoveryCache(): void {
  cache.clear()
  inflight.clear()
}

export interface DiscoverOptions {
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
  timeoutMs?: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('model list timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function discoverModels(brain: AIBrain, opts: DiscoverOptions = {}): Promise<ModelInfo[]> {
  const now = opts.now ?? Date.now
  const hit = cache.get(brain.id)
  if (hit && now() < hit.expiresAt) return hit.models
  const pending = inflight.get(brain.id)
  if (pending) return pending

  const run = (async (): Promise<ModelInfo[]> => {
    let listed: ModelInfo[] = []
    try {
      if (brain.listModels) listed = await withTimeout(brain.listModels(), opts.timeoutMs ?? TIMEOUT_MS)
    } catch {
      listed = []
    }
    if (listed.length > 0) {
      cache.set(brain.id, { models: listed, expiresAt: now() + (opts.ttlMs ?? TTL_MS), fresh: true })
      return listed
    }
    // The harness gave nothing: keep the last good list if there is one, else the built-in, else none.
    const fallback = hit?.fresh ? hit.models : (STATIC_MODELS[brain.id] ?? [])
    cache.set(brain.id, {
      models: fallback,
      expiresAt: now() + (opts.failureTtlMs ?? FAILURE_TTL_MS),
      fresh: hit?.fresh === true
    })
    return fallback
  })().finally(() => inflight.delete(brain.id))

  inflight.set(brain.id, run)
  return run
}
