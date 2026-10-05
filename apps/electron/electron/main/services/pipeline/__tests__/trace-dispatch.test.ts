// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../brains', () => ({ getBrainRegistry: () => ({}), getBrainRouter: () => ({}) }))
import { createTextRunner } from '../runner'

describe('trace dispatch at the provider boundary', () => {
  it.each(['eligible', 'excluded', 'unavailable', 'aborted'])('reports dispatch only for %s requests', async mode => {
    const onDispatch = vi.fn()
    const controller = new AbortController()
    if (mode === 'aborted') controller.abort()
    const chat = vi.fn(async () => 'answer')
    const run = createTextRunner({
      router: { canServe: async () => mode !== 'unavailable' },
      registry: { get: () => ({ chat }) },
      planFor: () => ({ calls: [{ profile: { kind: 'direct', id: 'test', harness: 'ollama' } }] }),
      track: async (_meta, call) => ({ ok: true, value: await call(), callId: 'call', provider: 'ollama' })
    } as any)
    await run({ step: 'chat', messages: [{ role: 'user', content: 'context' }],
      options: { signal: controller.signal, shouldGenerate: () => mode !== 'excluded', onDispatch } })
    expect(onDispatch).toHaveBeenCalledTimes(mode === 'eligible' ? 1 : 0)
  })
})
