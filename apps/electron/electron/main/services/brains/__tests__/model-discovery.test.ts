/**
 * Model discovery: ask a harness for its models without ever hanging, throwing or asking twice at once.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { discoverModels, resetModelDiscoveryCache, STATIC_MODELS } from '../model-discovery'
import type { ModelInfo } from '../descriptor'
import type { AIBrain, BrainId } from '../types'

function brainWith(id: BrainId, listModels?: () => Promise<ModelInfo[]>): AIBrain {
  return {
    id,
    label: id,
    capabilities: () => new Set(['generate']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: async () => null,
    chat: async () => null,
    ...(listModels ? { listModels } : {})
  } as AIBrain
}

describe('discoverModels', () => {
  beforeEach(() => resetModelDiscoveryCache())

  it('returns what the harness lists', async () => {
    const list = vi.fn(async () => [{ id: 'a' }, { id: 'b' }])
    expect(await discoverModels(brainWith('ollama', list))).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('asks once for callers that arrive together, and once per ttl', async () => {
    let now = 1_000
    const list = vi.fn(async () => [{ id: 'a' }])
    const brain = brainWith('ollama', list)
    const opts = { now: () => now, ttlMs: 60_000 }
    await Promise.all([discoverModels(brain, opts), discoverModels(brain, opts), discoverModels(brain, opts)])
    expect(list).toHaveBeenCalledTimes(1)
    now += 30_000
    await discoverModels(brain, opts)
    expect(list).toHaveBeenCalledTimes(1)
    now += 31_000
    await discoverModels(brain, opts)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('never throws: a failing source gives the last good list', async () => {
    let now = 1_000
    let fail = false
    const brain = brainWith('ollama', async () => {
      if (fail) throw new Error('down')
      return [{ id: 'a' }]
    })
    const opts = { now: () => now, ttlMs: 10, failureTtlMs: 10 }
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'a' }])
    fail = true
    now += 1_000
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'a' }])
  })

  it('gives up on a source that never answers, and says nothing rather than waiting', async () => {
    const brain = brainWith('ollama', () => new Promise<ModelInfo[]>(() => {}))
    const started = Date.now()
    expect(await discoverModels(brain, { timeoutMs: 50 })).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('uses the built-in list for a harness that cannot list, and nothing for an unknown one', async () => {
    const claude = await discoverModels(brainWith('claude-code'))
    expect(claude.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(STATIC_MODELS['claude-code']).toBeDefined()
    expect(await discoverModels(brainWith('codex'))).toEqual([])
  })

  it('does not remember a failure for long: a server started a moment later shows up', async () => {
    let now = 1_000
    let up = false
    const brain = brainWith('openai-compatible', async () => (up ? [{ id: 'qwen' }] : []))
    const opts = { now: () => now, ttlMs: 60_000, failureTtlMs: 5_000 }
    expect(await discoverModels(brain, opts)).toEqual([])
    up = true
    now += 6_000
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'qwen' }])
  })
})
