// @vitest-environment node

/**
 * Gemini usage recorded per stage: token counts from both response shapes, the
 * dated price table, and a collector that follows the async context.
 */
import { describe, it, expect } from 'vitest'
import {
  tokensFromUsage,
  priceFor,
  costOf,
  createGeminiUsageCollector,
  recordGeminiUsage,
  runUsageFields,
  COST_METHOD
} from '../gemini-usage'

const usage = (prompt: number, out: number, thoughts = 0, cached = 0) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: out,
  thoughtsTokenCount: thoughts,
  cachedContentTokenCount: cached,
  totalTokenCount: prompt + out + thoughts
})

describe('tokensFromUsage', () => {
  it('reads generateContent usageMetadata', () => {
    expect(tokensFromUsage(usage(1000, 200, 50, 300))).toEqual({
      promptTokens: 1000, outputTokens: 200, thoughtsTokens: 50, cachedTokens: 300, totalTokens: 1250
    })
  })

  it('reads the snake_case usage of the Interactions API', () => {
    expect(tokensFromUsage({ total_input_tokens: 7500, total_output_tokens: 900, total_thought_tokens: 0, total_tokens: 8400 })).toEqual({
      promptTokens: 7500, outputTokens: 900, thoughtsTokens: 0, cachedTokens: 0, totalTokens: 8400
    })
  })

  it('returns null for a response without usage, and ignores junk numbers', () => {
    expect(tokensFromUsage(undefined)).toBeNull()
    expect(tokensFromUsage({})).toBeNull()
    expect(tokensFromUsage({ promptTokenCount: -5, candidatesTokenCount: NaN })).toBeNull()
  })

  it('takes thinking from the total when the response does not list it', () => {
    // The older SDK type has no thoughtsTokenCount; the API total still includes thinking.
    expect(tokensFromUsage({ promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1600 })).toMatchObject({
      outputTokens: 200, thoughtsTokens: 400, totalTokens: 1600
    })
  })

  it('falls back to the sum when the total is missing', () => {
    expect(tokensFromUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })?.totalTokens).toBe(15)
  })
})

describe('prices', () => {
  it('prices the models the app uses', () => {
    expect(priceFor('gemini-3.5-transcribe')).toMatchObject({ inputPerMillion: 2, outputPerMillion: 12 })
    expect(priceFor('models/gemini-3.5-flash')).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 9 })
    expect(priceFor('gemini-9-unknown')).toBeNull()
  })

  it('doubles the 3.8 flash price on 1 January 2027', () => {
    expect(priceFor('gemini-3.8-flash', new Date('2026-12-31T23:59:59Z'))).toMatchObject({ inputPerMillion: 0.75, outputPerMillion: 3.75 })
    expect(priceFor('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z'))).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 7.5 })
  })

  it('bills thinking tokens as output', () => {
    // 1M in at $0.75 + (400k out + 100k thinking) at $3.75
    expect(costOf('gemini-3.8-flash', { promptTokens: 1_000_000, outputTokens: 400_000, thoughtsTokens: 100_000 }, new Date('2026-10-01'))).toBeCloseTo(0.75 + 1.875, 6)
    expect(costOf('gemini-9-unknown', { promptTokens: 1, outputTokens: 1, thoughtsTokens: 0 })).toBeNull()
  })
})

describe('collector', () => {
  it('counts every response reported inside it, across awaits, by model', async () => {
    const c = createGeminiUsageCollector()
    await c.run(async () => {
      recordGeminiUsage('gemini-3.8-flash', usage(1000, 100))
      await new Promise((r) => setTimeout(r, 5))
      recordGeminiUsage('gemini-3.8-flash', usage(2000, 50, 10)) // a retry: billed too
      recordGeminiUsage('gemini-3.5-flash', usage(10, 1))
    })
    const total = c.total()!
    expect(total.tokens).toMatchObject({ calls: 3, promptTokens: 3010, outputTokens: 151, thoughtsTokens: 10 })
    expect(total.byModel['gemini-3.8-flash']).toMatchObject({ calls: 2, promptTokens: 3000 })
    expect(total.byModel['gemini-3.5-flash']).toMatchObject({ calls: 1 })
  })

  it('keeps two stages running at the same time apart', async () => {
    const a = createGeminiUsageCollector()
    const b = createGeminiUsageCollector()
    await Promise.all([
      a.run(async () => { await new Promise((r) => setTimeout(r, 10)); recordGeminiUsage('gemini-3.8-flash', usage(100, 1)) }),
      b.run(async () => { recordGeminiUsage('gemini-3.8-flash', usage(7, 1)); await new Promise((r) => setTimeout(r, 20)); recordGeminiUsage('gemini-3.8-flash', usage(7, 1)) })
    ])
    expect(a.total()!.tokens.promptTokens).toBe(100)
    expect(b.total()!.tokens.promptTokens).toBe(14)
  })

  it('drops a report made outside any collector, and stays readable after the work threw', async () => {
    recordGeminiUsage('gemini-3.8-flash', usage(1, 1)) // no collector: nothing to keep it
    const c = createGeminiUsageCollector()
    await expect(c.run(async () => { recordGeminiUsage('gemini-3.8-flash', usage(5, 5)); throw new Error('parse failed') })).rejects.toThrow('parse failed')
    expect(c.total()!.tokens.calls).toBe(1)
    expect(createGeminiUsageCollector().total()).toBeNull()
  })
})

describe('runUsageFields', () => {
  it('gives tokens, the estimate, its currency and its method', () => {
    const c = createGeminiUsageCollector()
    c.run(() => recordGeminiUsage('gemini-3.5-flash', usage(2_000_000, 100_000)))
    const f = runUsageFields(c.total(), { chunkCount: 4 }, new Date('2026-10-01'))
    expect(f.usage).toMatchObject({ chunkCount: 4, tokens: { calls: 1, promptTokens: 2_000_000 } })
    expect(f.estimatedCostAmount).toBeCloseTo(2 * 1.5 + 0.1 * 9, 6)
    expect(f.estimatedCostCurrency).toBe('USD')
    expect(f.costMethod).toBe(COST_METHOD)
  })

  it('names a model without a price and leaves it out of the estimate', () => {
    const c = createGeminiUsageCollector()
    c.run(() => {
      recordGeminiUsage('gemini-3.5-flash', usage(1_000_000, 0))
      recordGeminiUsage('gemini-9-unknown', usage(1_000_000, 0))
    })
    const f = runUsageFields(c.total(), {}, new Date('2026-10-01'))
    expect(f.estimatedCostAmount).toBeCloseTo(1.5, 6)
    expect((f.usage as { unpricedModels: string[] }).unpricedModels).toEqual(['gemini-9-unknown'])
  })

  it('has no estimate when no model is priced, and keeps the extra usage when nothing was counted', () => {
    const c = createGeminiUsageCollector()
    c.run(() => recordGeminiUsage('gemini-9-unknown', usage(10, 1)))
    expect(runUsageFields(c.total())).toMatchObject({ estimatedCostAmount: null, estimatedCostCurrency: null, costMethod: null })
    expect(runUsageFields(null, { chunkCount: 2 })).toEqual({ usage: { chunkCount: 2 } })
    expect(runUsageFields(null)).toEqual({})
  })
})
