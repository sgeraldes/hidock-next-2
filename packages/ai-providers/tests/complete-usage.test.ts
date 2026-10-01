import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('../src/provider-factory.js', () => ({ createProvider: vi.fn(() => ({ model: {}, provider: 'google' })) }))

import { generateText } from 'ai'
import { complete, setCompletionUsageReporter } from '../src/complete.js'

const config = { provider: 'google' as const, model: 'gemini-3.8-flash', apiKey: 'k' }

beforeEach(() => {
  vi.mocked(generateText).mockReset()
})

afterEach(() => {
  setCompletionUsageReporter(null)
})

describe('complete() usage reporting', () => {
  it('returns the text, as before, with no reporter registered', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'hello', usage: { inputTokens: 10, outputTokens: 2 } } as never)
    await expect(complete('prompt', config)).resolves.toBe('hello')
  })

  it('reports the provider, the model, the tokens and the time to the registered reporter', async () => {
    const reports: unknown[] = []
    setCompletionUsageReporter((r) => reports.push(r))
    vi.mocked(generateText).mockResolvedValue({ text: 'hello', usage: { inputTokens: 1200, outputTokens: 80 } } as never)
    await complete('prompt', config)
    expect(reports).toEqual([
      { provider: 'google', model: 'gemini-3.8-flash', inputTokens: 1200, outputTokens: 80, durationMs: expect.any(Number) }
    ])
  })

  it('reports no tokens when the result carries no usage', async () => {
    const reports: Array<{ inputTokens?: number; outputTokens?: number }> = []
    setCompletionUsageReporter((r) => reports.push(r))
    vi.mocked(generateText).mockResolvedValue({ text: 'hello' } as never)
    await expect(complete('prompt', config)).resolves.toBe('hello')
    expect(reports[0].inputTokens).toBeUndefined()
    expect(reports[0].outputTokens).toBeUndefined()
  })

  it('returns the text even when the reporter throws', async () => {
    setCompletionUsageReporter(() => {
      throw new Error('reporter broke')
    })
    vi.mocked(generateText).mockResolvedValue({ text: 'hello', usage: {} } as never)
    await expect(complete('prompt', config)).resolves.toBe('hello')
  })

  it('reports nothing when the completion fails, and lets the error through', async () => {
    const reports: unknown[] = []
    setCompletionUsageReporter((r) => reports.push(r))
    vi.mocked(generateText).mockRejectedValue(new Error('rate limit'))
    await expect(complete('prompt', config)).rejects.toThrow('rate limit')
    expect(reports).toEqual([])
  })

  it('stops reporting when the reporter is removed', async () => {
    const reports: unknown[] = []
    setCompletionUsageReporter((r) => reports.push(r))
    setCompletionUsageReporter(null)
    vi.mocked(generateText).mockResolvedValue({ text: 'hello', usage: {} } as never)
    await complete('prompt', config)
    expect(reports).toEqual([])
  })
})
