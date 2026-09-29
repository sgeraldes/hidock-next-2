/**
 * What every Gemini call costs, recorded on the pipeline stage that made it
 * (29-sep-2026, pipeline cost plan #20).
 *
 * Until now the processing runs held no usage at all: 1,121 Gemini runs in 30
 * days, every `estimated_cost_amount` empty, so nothing could be judged on
 * money. Each response carries `usageMetadata`; this reads it, prices it, and
 * hands it to the stage that made the call.
 *
 * How a call reaches its stage without changing any signature: the pipeline
 * opens a collector around a stage (`collector.run(() => detect(...))`), and the
 * code that makes the Gemini call reports each response with `recordGeminiUsage`.
 * The report goes to whichever collector is active in that async context, and
 * is dropped when there is none (a manual timeline run, a chat message), so no
 * caller has to know about it. Every response counts, including the ones a
 * retry throws away: they were billed.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface GeminiTokens {
  /** Responses received. */
  calls: number
  /** Input tokens (text, audio and images together; cached tokens included). */
  promptTokens: number
  /** Output tokens, not counting thinking. */
  outputTokens: number
  /** Thinking tokens, billed as output. */
  thoughtsTokens: number
  /** Part of promptTokens served from a cache. Recorded, not discounted. */
  cachedTokens: number
  totalTokens: number
}

export interface GeminiUsageTotal {
  tokens: GeminiTokens
  byModel: Record<string, GeminiTokens>
}

const emptyTokens = (): GeminiTokens => ({
  calls: 0,
  promptTokens: 0,
  outputTokens: 0,
  thoughtsTokens: 0,
  cachedTokens: 0,
  totalTokens: 0
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Token counts from a response's usage block. Accepts the camelCase
 * `usageMetadata` of generateContent and the snake_case `usage` of the
 * Interactions API. Returns null when the response carried no usage.
 */
export function tokensFromUsage(usage: unknown): Omit<GeminiTokens, 'calls'> | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const promptTokens = num(u.promptTokenCount ?? u.total_input_tokens)
  const outputTokens = num(u.candidatesTokenCount ?? u.total_output_tokens)
  const cachedTokens = num(u.cachedContentTokenCount ?? u.total_cached_tokens)
  const reportedTotal = num(u.totalTokenCount ?? u.total_tokens)
  // The API bills thinking as output. The older SDK's usage type does not list
  // the field, but the total still includes it: what the total holds beyond the
  // prompt and the visible output is thinking.
  const thoughtsTokens =
    num(u.thoughtsTokenCount ?? u.total_thought_tokens) || Math.max(0, reportedTotal - promptTokens - outputTokens)
  const totalTokens = reportedTotal || promptTokens + outputTokens + thoughtsTokens
  if (promptTokens + outputTokens + thoughtsTokens + totalTokens === 0) return null
  return { promptTokens, outputTokens, thoughtsTokens, cachedTokens, totalTokens }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export interface GeminiPrice {
  model: string
  /** First day (UTC, inclusive) this price applies. */
  from?: string
  /** Day (UTC, exclusive) this price stops applying. */
  until?: string
  /** US dollars per one million input tokens. */
  inputPerMillion: number
  /** US dollars per one million output tokens, thinking included. */
  outputPerMillion: number
}

/**
 * Paid-tier list prices of ai.google.dev/gemini-api/docs/pricing, read on
 * 29-sep-2026. The transcribe model is listed per minute of audio there; at the
 * page's own 25 audio tokens per second that is $2.00 per million input tokens
 * (about $0.003 a minute) and $12.00 per million output tokens. The 3.8 flash
 * prices double on 1-jan-2027.
 */
export const GEMINI_PRICES: GeminiPrice[] = [
  { model: 'gemini-3.5-transcribe', inputPerMillion: 2.0, outputPerMillion: 12.0 },
  { model: 'gemini-3.8-flash', until: '2027-01-01', inputPerMillion: 0.75, outputPerMillion: 3.75 },
  { model: 'gemini-3.8-flash', from: '2027-01-01', inputPerMillion: 1.5, outputPerMillion: 7.5 },
  { model: 'gemini-3.7-flash', inputPerMillion: 0.75, outputPerMillion: 3.75 },
  { model: 'gemini-3.6-flash', inputPerMillion: 0.75, outputPerMillion: 3.75 },
  { model: 'gemini-3.5-flash', inputPerMillion: 1.5, outputPerMillion: 9.0 },
  { model: 'gemini-3.5-flash-lite', inputPerMillion: 0.3, outputPerMillion: 2.5 }
]

export const COST_METHOD = 'list-price-2026-09-29'

const normalizeModel = (model: string): string => model.replace(/^models\//, '').trim()

export function priceFor(model: string, at: Date = new Date()): GeminiPrice | null {
  const id = normalizeModel(model)
  const day = at.toISOString().slice(0, 10)
  return (
    GEMINI_PRICES.find((p) => p.model === id && (!p.from || day >= p.from) && (!p.until || day < p.until)) ?? null
  )
}

/** US dollars for these tokens on this model, or null when the model has no listed price. */
export function costOf(model: string, tokens: Pick<GeminiTokens, 'promptTokens' | 'outputTokens' | 'thoughtsTokens'>, at: Date = new Date()): number | null {
  const price = priceFor(model, at)
  if (!price) return null
  return (
    (tokens.promptTokens * price.inputPerMillion + (tokens.outputTokens + tokens.thoughtsTokens) * price.outputPerMillion) /
    1_000_000
  )
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

interface Scope {
  total: GeminiTokens
  byModel: Map<string, GeminiTokens>
}

const scopes = new AsyncLocalStorage<Scope>()

function add(into: GeminiTokens, t: Omit<GeminiTokens, 'calls'>): void {
  into.calls += 1
  into.promptTokens += t.promptTokens
  into.outputTokens += t.outputTokens
  into.thoughtsTokens += t.thoughtsTokens
  into.cachedTokens += t.cachedTokens
  into.totalTokens += t.totalTokens
}

/**
 * Report one Gemini response. Goes to the collector active in this async
 * context; dropped when there is none or the response carried no usage.
 */
export function recordGeminiUsage(model: string | undefined, usage: unknown): void {
  const scope = scopes.getStore()
  if (!scope) return
  const tokens = tokensFromUsage(usage)
  if (!tokens) return
  const id = normalizeModel(model || 'unknown')
  add(scope.total, tokens)
  const bucket = scope.byModel.get(id) ?? emptyTokens()
  add(bucket, tokens)
  scope.byModel.set(id, bucket)
}

export interface GeminiUsageCollector {
  /** Runs `fn`; every response reported inside it (however deep, however async) is counted here. */
  run: <T>(fn: () => T) => T
  /** What was counted, or null when nothing was. Readable after `fn` threw. */
  total: () => GeminiUsageTotal | null
}

export function createGeminiUsageCollector(): GeminiUsageCollector {
  const scope: Scope = { total: emptyTokens(), byModel: new Map() }
  return {
    run: (fn) => scopes.run(scope, fn),
    total: () =>
      scope.total.calls === 0
        ? null
        : { tokens: { ...scope.total }, byModel: Object.fromEntries([...scope.byModel].map(([m, t]) => [m, { ...t }])) }
  }
}

/** The fields a processing run stores for this usage: tokens, and the cost estimate. */
export interface RunUsageFields {
  usage?: Record<string, unknown>
  estimatedCostAmount?: number | null
  estimatedCostCurrency?: string | null
  costMethod?: string | null
}

/**
 * Turns collected usage into the fields of `completeProcessingRun`. `extra` is
 * merged into the run's `usage` (the transcription run keeps its provider
 * timeline there). Models without a listed price are named in `unpricedModels`
 * and add nothing to the estimate.
 */
export function runUsageFields(total: GeminiUsageTotal | null, extra: Record<string, unknown> = {}, at: Date = new Date()): RunUsageFields {
  if (!total) return Object.keys(extra).length > 0 ? { usage: extra } : {}
  let cost = 0
  let priced = false
  const unpriced: string[] = []
  for (const [model, tokens] of Object.entries(total.byModel)) {
    const c = costOf(model, tokens, at)
    if (c === null) unpriced.push(model)
    else {
      cost += c
      priced = true
    }
  }
  return {
    usage: { ...extra, tokens: total.tokens, byModel: total.byModel, ...(unpriced.length > 0 ? { unpricedModels: unpriced } : {}) },
    estimatedCostAmount: priced ? Math.round(cost * 1e6) / 1e6 : null,
    estimatedCostCurrency: priced ? 'USD' : null,
    costMethod: priced ? COST_METHOD : null
  }
}
