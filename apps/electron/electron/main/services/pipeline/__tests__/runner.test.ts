/**
 * The text runner over fake routers and brains: the router route behaves as the router alone, a named
 * harness gets the profile's settings, a fallback runs once and never sees what the first attempt was not
 * allowed to see, and every attempt leaves one row.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIBrain, BrainMessage } from '../../brains'
import { recordHarnessUsage } from '../../brains/harness-usage'
import { setCallSink, type CallRecord } from '../call-store'
import { createTextRunner, type RunnerDeps } from '../runner'
import type { Plan, TextStepId } from '../steps'
import { trackCall } from '../track-call'

const MESSAGES: BrainMessage[] = [{ role: 'user', content: 'hello' }]

let rows: Array<{ id: string; record: CallRecord }>

function fakeBrain(id: string, reply: () => Promise<string | null>): AIBrain {
  return {
    id,
    label: id,
    capabilities: () => new Set(['generate', 'chat']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: vi.fn(reply),
    chat: vi.fn(reply)
  } as unknown as AIBrain
}

function makeDeps(over: {
  plan?: Plan
  chat?: () => Promise<string | null>
  resolved?: AIBrain | null
  brains?: Record<string, AIBrain>
  canServe?: (id: string) => boolean
} = {}): RunnerDeps & { router: { chat: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; canServe: ReturnType<typeof vi.fn> } } {
  const router = {
    chat: vi.fn(over.chat ?? (async () => 'router answer')),
    resolve: vi.fn(async () => over.resolved ?? null),
    canServe: vi.fn(async (id: string) => (over.canServe ? over.canServe(id) : true))
  }
  const plan: Plan = over.plan ?? { calls: [{ profile: { kind: 'router', task: 'chat', mode: 'chat' } }] }
  return {
    router: router as never,
    registry: { get: (id: string) => over.brains?.[id] ?? null } as never,
    planFor: (_step: TextStepId) => plan,
    track: trackCall
  } as RunnerDeps & { router: typeof router }
}

beforeEach(() => {
  rows = []
  setCallSink((id, record) => {
    rows.push({ id, record })
  })
})

afterEach(() => setCallSink(null))

describe('router route, chat mode (today\'s chat)', () => {
  it('passes the task, the messages and the options object to the router, and returns its answer', async () => {
    const deps = makeDeps({
      plan: { calls: [{ profile: { kind: 'router', task: 'suggestions', mode: 'chat' } }] },
      chat: async () => {
        recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 50, outputTokens: 10, durationMs: 400 })
        return 'the answer'
      }
    })
    const options = { systemPrompt: 'sys', temperature: 0.2, maxTokens: 500 }
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options })
    expect(outcome).toMatchObject({ ok: true, text: 'the answer', provider: 'gemini-api' })
    expect(deps.router.chat).toHaveBeenCalledWith('suggestions', MESSAGES, options)
    expect(rows).toHaveLength(1)
    expect(rows[0].record).toMatchObject({ step: 'notes', route: 'router:suggestions:chat', provider: 'gemini-api', status: 'completed' })
  })

  it('treats null and the empty string as no answer, and leaves a failed row', async () => {
    for (const reply of [null, '']) {
      rows.length = 0
      const outcome = await createTextRunner(makeDeps({ chat: async () => reply }))({ step: 'chat', messages: MESSAGES })
      expect(outcome).toMatchObject({ ok: false, reason: 'empty' })
      expect(rows[0].record).toMatchObject({ status: 'failed', errorMessage: 'empty answer' })
    }
  })

  it('passes a whitespace-only answer through, as the callers see it today', async () => {
    const outcome = await createTextRunner(makeDeps({ chat: async () => '  ' }))({ step: 'chat', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: '  ' })
  })

  it('reports a throw as an error outcome that carries the original error', async () => {
    const boom = new Error('router bug')
    const outcome = await createTextRunner(
      makeDeps({
        chat: async () => {
          throw boom
        }
      })
    )({ step: 'chat', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'error', error: boom })
    expect(rows[0].record.status).toBe('failed')
  })

  it('links the row to the recording', async () => {
    await createTextRunner(makeDeps())({ step: 'reformat', messages: MESSAGES, recordingId: 'rec-9' })
    expect(rows[0].record.recordingId).toBe('rec-9')
  })
})

describe('router route, generate mode (today\'s outputs)', () => {
  const plan: Plan = { calls: [{ profile: { kind: 'router', task: 'outputs', mode: 'generate' } }] }

  it('resolves one brain and calls its generate with the caller\'s options', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const deps = makeDeps({ plan, resolved: brain })
    const options = { systemPrompt: 'write well' }
    const outcome = await createTextRunner(deps)({ step: 'outputs', messages: MESSAGES, options })
    expect(outcome).toMatchObject({ ok: true, text: 'document' })
    expect(deps.router.resolve).toHaveBeenCalledWith('outputs', 'generate')
    expect(brain.generate).toHaveBeenCalledWith(MESSAGES, options)
    expect(rows[0].record.route).toBe('router:outputs:generate')
  })

  it('is unavailable when no brain resolves, and records nothing', async () => {
    const outcome = await createTextRunner(makeDeps({ plan, resolved: null }))({ step: 'outputs', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', callId: null })
    expect(rows).toHaveLength(0)
  })

  it('is ineligible, sends nothing and records nothing, when the gate says the source changed', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({
      step: 'outputs',
      messages: MESSAGES,
      options: { shouldGenerate: () => false }
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(brain.generate).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('treats a gate that throws as ineligible (fail closed)', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({
      step: 'outputs',
      messages: MESSAGES,
      options: {
        shouldGenerate: () => {
          throw new Error('db gone')
        }
      }
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(brain.generate).not.toHaveBeenCalled()
  })

  it('hands a provider error to the caller unchanged', async () => {
    const boom = new Error('API 500')
    const brain = fakeBrain('gemini-api', async () => {
      throw boom
    })
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({ step: 'outputs', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'error', error: boom })
    expect(rows[0].record.status).toBe('failed')
  })
})

describe('named harness', () => {
  const haiku = { kind: 'direct', id: 'claude-haiku', harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } as const
  const local = { kind: 'direct', id: 'local-qwen', harness: 'ollama', model: 'qwen3:8b' } as const

  it('calls the harness with the profile\'s settings over the caller\'s, and records the route', async () => {
    const claude = fakeBrain('claude-code', async () => 'claude answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] }, brains: { 'claude-code': claude } })
    const outcome = await createTextRunner(deps)({
      step: 'notes',
      messages: MESSAGES,
      options: { systemPrompt: 'sys', temperature: 0.7, maxTokens: 1024 }
    })
    expect(outcome).toMatchObject({ ok: true, text: 'claude answer' })
    expect(claude.chat).toHaveBeenCalledWith(MESSAGES, {
      systemPrompt: 'sys',
      temperature: 0,
      maxTokens: 300,
      model: 'haiku',
      effort: 'low'
    })
    expect(deps.router.canServe).toHaveBeenCalledWith('claude-code', 'chat')
    expect(rows[0].record.route).toBe('direct:claude-haiku')
  })

  it('keeps the caller\'s settings where the profile sets none', async () => {
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: local }] }, brains: { ollama } })
    await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { temperature: 0.2, maxTokens: 500 } })
    expect(ollama.chat).toHaveBeenCalledWith(MESSAGES, { temperature: 0.2, maxTokens: 500, model: 'qwen3:8b' })
  })

  it('is unavailable when the router says the harness cannot serve, and the harness is not called', async () => {
    const claude = fakeBrain('claude-code', async () => 'x')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] }, brains: { 'claude-code': claude }, canServe: () => false })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(claude.chat).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('is unavailable when the registry has no such brain', async () => {
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('does not touch the registry for a router route', async () => {
    const deps = makeDeps()
    deps.registry = {
      get: () => {
        throw new Error('the registry must not be read')
      }
    } as never
    expect(await createTextRunner(deps)({ step: 'chat', messages: MESSAGES })).toMatchObject({ ok: true })
  })
})

describe('fallback', () => {
  const haiku = { kind: 'direct', id: 'claude-haiku', harness: 'claude-code', model: 'haiku' } as const
  const local = { kind: 'direct', id: 'local-qwen', harness: 'ollama', model: 'qwen3:8b' } as const

  it('runs the fallback when the first profile answers nothing, and links the two rows', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: 'local answer' })
    expect(rows.map((r) => r.record.route)).toEqual(['direct:claude-haiku', 'direct:local-qwen'])
    expect(rows[1].record.parentCallId).toBe(rows[0].id)
  })

  it('runs the fallback when the first harness is unavailable, with no parent because nothing was called', async () => {
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({
      plan: { calls: [{ profile: haiku, onFail: local }] },
      brains: { ollama },
      canServe: (id) => id === 'ollama'
    })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: 'local answer' })
    expect(rows).toHaveLength(1)
    expect(rows[0].record.parentCallId).toBeNull()
  })

  it('runs the fallback after an error', async () => {
    const claude = fakeBrain('claude-code', async () => {
      throw new Error('crashed')
    })
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: true, text: 'local answer' })
  })

  it('does not run the fallback when the source became ineligible', async () => {
    const claude = fakeBrain('claude-code', async () => 'x')
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { shouldGenerate: () => false } })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(ollama.chat).not.toHaveBeenCalled()
  })

  it('checks the gate again before the fallback, so a source excluded meanwhile is not sent to it', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    let checks = 0
    const outcome = await createTextRunner(deps)({
      step: 'notes',
      messages: MESSAGES,
      options: { shouldGenerate: () => ++checks === 1 }
    })
    expect(claude.chat).toHaveBeenCalledTimes(1)
    expect(ollama.chat).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
  })

  it('does not run the fallback after the caller aborted', async () => {
    const controller = new AbortController()
    const claude = fakeBrain('claude-code', async () => {
      controller.abort()
      return null
    })
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { signal: controller.signal } })
    expect(outcome.ok).toBe(false)
    expect(ollama.chat).not.toHaveBeenCalled()
  })

  it('returns the fallback\'s failure when both fail', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => null)
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: false, reason: 'empty' })
    expect(rows).toHaveLength(2)
  })
})
