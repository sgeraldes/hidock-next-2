/**
 * The completions of @hidock/ai-providers reach the ledger: inside a tracked call their tokens and model
 * land on the row; outside one they add nothing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const box = vi.hoisted(() => ({ reporter: null as null | ((report: Record<string, unknown>) => void) }))
vi.mock('@hidock/ai-providers', () => ({
  setCompletionUsageReporter: (fn: typeof box.reporter) => {
    box.reporter = fn
  }
}))

import { setCallSink, type CallRecord } from '../call-store'
import { registerCompletionUsage } from '../direct-calls'
import { trackCall } from '../track-call'
import { OBSERVED_STEPS } from '../steps'

let rows: CallRecord[]

beforeEach(() => {
  rows = []
  box.reporter = null
  setCallSink((_id, record) => {
    rows.push(record)
  })
  registerCompletionUsage()
})

afterEach(() => {
  setCallSink(null)
})

describe('registerCompletionUsage', () => {
  it('registers one reporter with the package', () => {
    expect(box.reporter).toBeTypeOf('function')
  })

  it('puts the tokens and the model of a completion inside a tracked call on its row, named for the Gemini harness', async () => {
    await trackCall({ step: 'graph-extract', recordingId: null, route: 'direct:ai-sdk' }, async () => {
      box.reporter!({ provider: 'google', model: 'gemini-3.8-flash', inputTokens: 4000, outputTokens: 600, durationMs: 1800 })
      return 'text'
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step: 'graph-extract', provider: 'gemini-api', model: 'gemini-3.8-flash', status: 'completed' })
    expect(rows[0].usage).toMatchObject({ calls: 1, tokens: { input: 4000, output: 600 } })
    expect(rows[0].estimatedCostAmount).toBeGreaterThan(0)
  })

  it('keeps the name of any other provider', async () => {
    await trackCall({ step: 'value-llm', route: 'direct:ai-sdk' }, async () => {
      box.reporter!({ provider: 'openai', model: 'gpt-x', inputTokens: 10, outputTokens: 5, durationMs: 400 })
    })
    expect(rows[0]).toMatchObject({ provider: 'openai', model: 'gpt-x' })
  })

  it('records a completion that carried no tokens as a call with no usage figures', async () => {
    await trackCall({ step: 'value-llm', route: 'direct:ai-sdk' }, async () => {
      box.reporter!({ provider: 'ollama', model: 'qwen3:8b', durationMs: 900 })
    })
    expect(rows[0]).toMatchObject({ provider: 'ollama', model: 'qwen3:8b' })
  })

  it('adds nothing, and does not throw, for a completion outside a tracked call', () => {
    expect(() => box.reporter!({ provider: 'google', model: 'gemini-3.8-flash', inputTokens: 1, durationMs: 1 })).not.toThrow()
    expect(rows).toEqual([])
  })
})

describe('the real package', () => {
  it('exports the reporter the app registers, so a stale build of the package is noticed here', async () => {
    const actual = await vi.importActual<{ setCompletionUsageReporter?: unknown }>('@hidock/ai-providers')
    expect(actual.setCompletionUsageReporter).toBeTypeOf('function')
  })
})

describe('the observed steps', () => {
  it('include the six sites that call a model without the router', () => {
    for (const step of ['analysis', 'actionable-detection', 'timeline', 'value-llm', 'graph-extract', 'image-describe']) {
      expect(OBSERVED_STEPS as readonly string[], step).toContain(step)
    }
  })
})
