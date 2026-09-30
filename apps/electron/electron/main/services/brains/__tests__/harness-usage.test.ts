/**
 * Usage of every harness, collected the way Gemini's already is: an async scope, no signature changes.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { createHarnessUsageCollector, harnessRunFields, recordHarnessUsage } from '../harness-usage'

describe('harness usage collector', () => {
  it('drops a report made outside any collector', () => {
    expect(() => recordHarnessUsage({ harness: 'ollama', durationMs: 5 })).not.toThrow()
  })

  it('counts calls, time and tokens per harness and model, across awaits', async () => {
    const collector = createHarnessUsageCollector()
    await collector.run(async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1000, outputTokens: 200, thinkingTokens: 50, durationMs: 1500 })
      await new Promise((r) => setTimeout(r, 1))
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 500, outputTokens: 100, durationMs: 900 })
      recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', durationMs: 4000 })
    })
    const total = collector.total()!
    expect(total.calls).toBe(3)
    expect(total.durationMs).toBe(6400)
    expect(total.inputTokens).toBe(1500)
    expect(total.outputTokens).toBe(300)
    expect(total.thinkingTokens).toBe(50)
    expect(Object.keys(total.byModel).sort()).toEqual(['gemini-api:gemini-3.8-flash', 'ollama:qwen3:8b'])
    expect(total.byModel['gemini-api:gemini-3.8-flash'].calls).toBe(2)
  })

  it('returns null when nothing was reported', () => {
    expect(createHarnessUsageCollector().total()).toBeNull()
  })

  it('goes to the innermost collector only, so a runner that opens one per call does not double count', () => {
    const outer = createHarnessUsageCollector()
    const inner = createHarnessUsageCollector()
    outer.run(() => {
      recordHarnessUsage({ harness: 'ollama', durationMs: 1 })
      inner.run(() => recordHarnessUsage({ harness: 'ollama', durationMs: 10 }))
    })
    expect(outer.total()!.durationMs).toBe(1)
    expect(inner.total()!.durationMs).toBe(10)
  })

  it('ignores garbage numbers instead of poisoning the total', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() =>
      recordHarnessUsage({ harness: 'x', inputTokens: Number.NaN, outputTokens: -5, durationMs: Number.POSITIVE_INFINITY })
    )
    const total = collector.total()!
    expect(total.inputTokens).toBe(0)
    expect(total.outputTokens).toBe(0)
    expect(total.durationMs).toBe(0)
  })
})

describe('harnessRunFields', () => {
  it('prices Gemini by the list, takes the cost a CLI reports, and counts a local model as free', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1_000_000, outputTokens: 1_000_000, durationMs: 1 })
      recordHarnessUsage({ harness: 'claude-code', model: 'claude-haiku-4-5-20251001', inputTokens: 1860, outputTokens: 45, reportedCostUsd: 0.002085, durationMs: 2094 })
      recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', durationMs: 4000 })
    })
    const fields = harnessRunFields(collector.total(), { step: 'understand' }, new Date('2026-10-01T00:00:00Z'))
    // 0.75 + 3.75 for Gemini, 0.002085 reported by Claude Code, 0 for the local model.
    expect(fields.estimatedCostAmount).toBeCloseTo(4.502085, 6)
    expect(fields.estimatedCostCurrency).toBe('USD')
    expect(fields.usage).toMatchObject({ step: 'understand' })
    expect((fields.usage as { calls: number }).calls).toBe(3)
  })

  it('names the models it cannot price and leaves them out of the estimate', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() => recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-9-unlisted', inputTokens: 10, outputTokens: 10, durationMs: 1 }))
    const fields = harnessRunFields(collector.total())
    expect(fields.estimatedCostAmount).toBeNull()
    expect((fields.usage as { unpricedModels: string[] }).unpricedModels).toEqual(['gemini-api:gemini-9-unlisted'])
  })

  it('returns only the extra fields when nothing was reported', () => {
    expect(harnessRunFields(null)).toEqual({})
    expect(harnessRunFields(null, { a: 1 })).toEqual({ usage: { a: 1 } })
  })
})
