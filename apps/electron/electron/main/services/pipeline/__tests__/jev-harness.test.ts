/**
 * Jev behind the same face as the other harnesses: a descriptor, a configured check, usage reported.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { createJevHarness } from '../jev-harness'
import { JevError, type JevResponse } from '../../jev-client'
import { createHarnessUsageCollector } from '../../brains/harness-usage'
import { JEV_DESCRIPTOR } from '../../brains/engine-descriptors'

const RESPONSE: JevResponse = {
  model: 'jev-latest',
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 420, output_tokens: 6 }
}

describe('createJevHarness', () => {
  it('carries the Jev descriptor', () => {
    expect(createJevHarness({ getKey: () => 'k' }).descriptor).toBe(JEV_DESCRIPTOR)
  })

  it('is configured only with a key', () => {
    expect(createJevHarness({ getKey: () => 'k' }).isConfigured()).toBe(true)
    expect(createJevHarness({ getKey: () => null }).isConfigured()).toBe(false)
    expect(createJevHarness({ getKey: () => '  ' }).isConfigured()).toBe(false)
  })

  it('asks Jev with the key and reports the tokens and the time', async () => {
    const askImpl = vi.fn(async () => RESPONSE)
    const harness = createJevHarness({ getKey: () => 'key-1', askImpl })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => harness.ask('state', { q: { type: 'noul', instructions: 'yes or no?' } }))
    expect(out).toBe(RESPONSE)
    expect(askImpl).toHaveBeenCalledWith('key-1', 'state', { q: { type: 'noul', instructions: 'yes or no?' } }, {})
    const bucket = collector.total()!.byModel['jev:jev-latest']
    expect(bucket).toMatchObject({ calls: 1, inputTokens: 420, outputTokens: 6 })
  })

  it('refuses to call without a key, with an error that names no key', async () => {
    const askImpl = vi.fn()
    const harness = createJevHarness({ getKey: () => null, askImpl })
    await expect(harness.ask('s', {})).rejects.toBeInstanceOf(JevError)
    expect(askImpl).not.toHaveBeenCalled()
  })

  it('lets the error of a failed call through and reports nothing for it', async () => {
    const askImpl = vi.fn(async () => {
      throw new JevError('Jev returned HTTP 429', 429)
    })
    const collector = createHarnessUsageCollector()
    const harness = createJevHarness({ getKey: () => 'k', askImpl })
    await expect(collector.run(() => harness.ask('s', {}))).rejects.toMatchObject({ status: 429 })
    expect(collector.total()).toBeNull()
  })
})
