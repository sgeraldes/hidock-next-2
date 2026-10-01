/**
 * trackCall: run a call inside a usage collector, time it, leave exactly one ledger row, and never change
 * what the call returns or throws.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordHarnessUsage } from '../../brains/harness-usage'
import { setCallSink, type CallRecord } from '../call-store'
import { describeError, trackCall, withCallRecord } from '../track-call'

let rows: Array<{ id: string; record: CallRecord }>

beforeEach(() => {
  rows = []
  setCallSink((id, record) => {
    rows.push({ id, record })
  })
})

afterEach(() => {
  setCallSink(null)
  vi.useRealTimers()
})

describe('trackCall', () => {
  it('returns the value and stores a completed row with the usage the call reported', async () => {
    const result = await trackCall({ step: 'notes', route: 'router:suggestions:chat' }, async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1000, outputTokens: 200, durationMs: 900 })
      return 'answer'
    })
    expect(result).toMatchObject({ ok: true, value: 'answer', provider: 'gemini-api', callId: rows[0].id })
    expect(rows).toHaveLength(1)
    expect(rows[0].record).toMatchObject({
      step: 'notes',
      recordingId: null,
      route: 'router:suggestions:chat',
      provider: 'gemini-api',
      model: 'gemini-3.8-flash',
      status: 'completed',
      parentCallId: null,
      errorMessage: null,
      estimatedCostCurrency: 'USD'
    })
    expect(rows[0].record.usage).toMatchObject({ calls: 1, tokens: { input: 1000, output: 200 } })
    expect(rows[0].record.estimatedCostAmount).toBeGreaterThan(0)
  })

  it('names the harness that answered, not a failed one that reported usage first, when a chain falls back inside one call', async () => {
    const result = await trackCall({ step: 'chat', route: 'router:chat:chat' }, async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 500, outputTokens: 0, durationMs: 300 })
      recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', inputTokens: 500, outputTokens: 120, durationMs: 2500 })
      return 'answer'
    })
    expect(result).toMatchObject({ ok: true, provider: 'ollama' })
    expect(rows[0].record).toMatchObject({ provider: 'ollama', model: 'qwen3:8b' })
    expect(rows[0].record.usage).toMatchObject({ calls: 2, tokens: { input: 1000, output: 120 } })
  })

  it('measures the time of the call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'))
    const pending = trackCall({ step: 'notes', route: 'r' }, () => new Promise<string>((resolve) => setTimeout(() => resolve('x'), 1500)))
    await vi.advanceTimersByTimeAsync(1500)
    await pending
    expect(rows[0].record.durationMs).toBe(1500)
    expect(rows[0].record.startedAt).toBe('2026-09-30T12:00:00.000Z')
    expect(rows[0].record.completedAt).toBe('2026-09-30T12:00:01.500Z')
  })

  it('carries the recording and the parent call through to the row', async () => {
    await trackCall({ step: 'reformat', route: 'direct:haiku', recordingId: 'rec-1', parentCallId: 'call-0' }, async () => 'x')
    expect(rows[0].record).toMatchObject({ recordingId: 'rec-1', parentCallId: 'call-0' })
  })

  it('stores a call with no reported usage, with the route as the only provenance', async () => {
    await trackCall({ step: 'outputs', route: 'router:outputs:generate' }, async () => 'x')
    expect(rows[0].record).toMatchObject({ provider: null, model: null, usage: null, estimatedCostAmount: null, status: 'completed' })
  })

  it('marks the call failed, with the judge message, when the judge refuses the value, and still returns the value', async () => {
    const result = await trackCall({ step: 'notes', route: 'r' }, async () => null as string | null, (v) => (v == null ? 'empty answer' : null))
    expect(result).toMatchObject({ ok: true, value: null })
    expect(rows[0].record).toMatchObject({ status: 'failed', errorMessage: 'empty answer' })
  })

  it('lets the judge call a value cancelled instead of failed', async () => {
    await trackCall({ step: 'chat', route: 'r' }, async () => null as string | null, () => ({ status: 'cancelled', message: 'aborted' }))
    expect(rows[0].record).toMatchObject({ status: 'cancelled', errorMessage: 'aborted' })
  })

  it('records a throw as failed, returns it without throwing, and keeps only the first line of the message', async () => {
    const boom = new Error('Bad request\nprompt: the private transcript text')
    const result = await trackCall({ step: 'outputs', route: 'r' }, async () => {
      throw boom
    })
    expect(result).toMatchObject({ ok: false, error: boom })
    expect(rows[0].record.status).toBe('failed')
    expect(rows[0].record.errorMessage).toBe('Error: Bad request')
    expect(JSON.stringify(rows[0].record)).not.toContain('private transcript')
  })

  it('caps the error message at 200 characters', () => {
    expect(describeError(new Error('x'.repeat(500))).length).toBe(200)
    expect(describeError('plain text')).toBe('plain text')
  })

  it('records an abort as cancelled', async () => {
    await trackCall({ step: 'chat', route: 'r' }, async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    expect(rows[0].record.status).toBe('cancelled')
  })

  it('gives two calls that run at once their own usage', async () => {
    await Promise.all([
      trackCall({ step: 'notes', route: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', inputTokens: 10, durationMs: 5 })
        return 1
      }),
      trackCall({ step: 'outputs', route: 'b' }, async () => {
        recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 99, durationMs: 1 })
        await new Promise((r) => setTimeout(r, 10))
        return 2
      })
    ])
    const byStep = Object.fromEntries(rows.map((r) => [r.record.step, r.record]))
    expect(byStep.notes.provider).toBe('ollama')
    expect((byStep.notes.usage as { tokens: { input: number } }).tokens.input).toBe(10)
    expect(byStep.outputs.provider).toBe('gemini-api')
    expect((byStep.outputs.usage as { tokens: { input: number } }).tokens.input).toBe(99)
  })

  it('does not change the outcome when the ledger cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setCallSink(() => {
      throw new Error('disk full')
    })
    const result = await trackCall({ step: 'notes', route: 'r' }, async () => 'answer')
    expect(result).toMatchObject({ ok: true, value: 'answer', callId: null })
  })
})

describe('withCallRecord', () => {
  it('returns the value and records the call', async () => {
    expect(await withCallRecord({ step: 'handover', route: 'agentic' }, async () => 'done')).toBe('done')
    expect(rows).toHaveLength(1)
  })

  it('records the failure and throws the same error', async () => {
    const boom = new Error('provider down')
    await expect(
      withCallRecord({ step: 'evaluate', route: 'jev' }, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(rows[0].record.status).toBe('failed')
  })
})
