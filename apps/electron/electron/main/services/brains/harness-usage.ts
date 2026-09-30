/**
 * What every harness text call costs: tokens where the harness says them, time always, money where a
 * price is known. Embedding calls report nothing here: the runner of phase 2 times every call itself.
 *
 * Same pattern as gemini-usage.ts (which stays: the transcription stages still use it): the code that
 * makes a call reports it with `recordHarnessUsage`, and the report goes to whichever collector is
 * active in that async context, or nowhere when there is none. A runner opens one collector per call
 * (`createHarnessUsageCollector().run(...)`), so a report goes to the innermost collector and is
 * never counted twice.
 *
 * Money: a price the harness itself reports (Claude Code's `total_cost_usd`) wins; Gemini is priced
 * by the list in gemini-usage.ts; a local harness costs nothing; anything else is named in
 * `unpricedModels` and adds nothing to the estimate, as gemini-usage does.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { costOf, type RunUsageFields } from '../gemini-usage'

export interface HarnessUsageReport {
  harness: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  cachedTokens?: number
  durationMs: number
  /** US dollars, when the harness reports its own cost. */
  reportedCostUsd?: number | null
}

export interface HarnessUsageBucket {
  harness: string
  model: string
  calls: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cachedTokens: number
  reportedCostUsd: number | null
}

export interface HarnessUsageTotal {
  calls: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cachedTokens: number
  reportedCostUsd: number | null
  byModel: Record<string, HarnessUsageBucket>
}

/** Harnesses that run on this machine: no money. */
const FREE_HARNESSES = new Set(['ollama', 'openai-compatible', 'local-onnx-embed'])

export const HARNESS_COST_METHOD = 'reported-or-list-price-2026-09-30'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

const scopes = new AsyncLocalStorage<Map<string, HarnessUsageBucket>>()

export function recordHarnessUsage(report: HarnessUsageReport): void {
  const scope = scopes.getStore()
  if (!scope) return
  const model = report.model?.trim() || 'unknown'
  const key = `${report.harness}:${model}`
  const bucket = scope.get(key) ?? {
    harness: report.harness,
    model,
    calls: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    reportedCostUsd: null
  }
  bucket.calls += 1
  bucket.durationMs += num(report.durationMs)
  bucket.inputTokens += num(report.inputTokens)
  bucket.outputTokens += num(report.outputTokens)
  bucket.thinkingTokens += num(report.thinkingTokens)
  bucket.cachedTokens += num(report.cachedTokens)
  if (typeof report.reportedCostUsd === 'number' && Number.isFinite(report.reportedCostUsd) && report.reportedCostUsd >= 0) {
    bucket.reportedCostUsd = (bucket.reportedCostUsd ?? 0) + report.reportedCostUsd
  }
  scope.set(key, bucket)
}

export interface HarnessUsageCollector {
  /** Runs `fn`; every report made inside it (however deep, however async) is counted here. */
  run: <T>(fn: () => T) => T
  /** What was counted, or null when nothing was. Readable after `fn` threw. */
  total: () => HarnessUsageTotal | null
}

export function createHarnessUsageCollector(): HarnessUsageCollector {
  const scope = new Map<string, HarnessUsageBucket>()
  return {
    run: (fn) => scopes.run(scope, fn),
    total: () => {
      if (scope.size === 0) return null
      const total: HarnessUsageTotal = {
        calls: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        reportedCostUsd: null,
        byModel: {}
      }
      for (const [key, bucket] of scope) {
        total.calls += bucket.calls
        total.durationMs += bucket.durationMs
        total.inputTokens += bucket.inputTokens
        total.outputTokens += bucket.outputTokens
        total.thinkingTokens += bucket.thinkingTokens
        total.cachedTokens += bucket.cachedTokens
        if (bucket.reportedCostUsd !== null) total.reportedCostUsd = (total.reportedCostUsd ?? 0) + bucket.reportedCostUsd
        total.byModel[key] = { ...bucket }
      }
      return total
    }
  }
}

/** The fields a processing run stores for this usage: the numbers, and the cost estimate. */
export function harnessRunFields(
  total: HarnessUsageTotal | null,
  extra: Record<string, unknown> = {},
  at: Date = new Date()
): RunUsageFields {
  if (!total) return Object.keys(extra).length > 0 ? { usage: extra } : {}
  let cost = 0
  let priced = false
  const unpriced: string[] = []
  for (const [key, bucket] of Object.entries(total.byModel)) {
    if (bucket.reportedCostUsd !== null) {
      cost += bucket.reportedCostUsd
      priced = true
    } else if (FREE_HARNESSES.has(bucket.harness)) {
      priced = true
    } else if (bucket.harness === 'gemini-api' || bucket.harness === 'gemini-cli') {
      const c = costOf(
        bucket.model,
        { promptTokens: bucket.inputTokens, outputTokens: bucket.outputTokens, thoughtsTokens: bucket.thinkingTokens },
        at
      )
      if (c === null) unpriced.push(key)
      else {
        cost += c
        priced = true
      }
    } else {
      unpriced.push(key)
    }
  }
  return {
    usage: {
      ...extra,
      calls: total.calls,
      durationMs: total.durationMs,
      tokens: {
        input: total.inputTokens,
        output: total.outputTokens,
        thinking: total.thinkingTokens,
        cached: total.cachedTokens
      },
      byModel: total.byModel,
      ...(unpriced.length > 0 ? { unpricedModels: unpriced } : {})
    },
    estimatedCostAmount: priced ? Math.round(cost * 1e6) / 1e6 : null,
    estimatedCostCurrency: priced ? 'USD' : null,
    costMethod: priced ? HARNESS_COST_METHOD : null
  }
}
