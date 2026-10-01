/**
 * The default plan of every text step is today's routing, and a plan source can replace it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_PLANS, OBSERVED_STEPS, TEXT_STEPS, type Plan } from '../steps'
import { resolvePlan, setPlanSource } from '../plans'

describe('default plans', () => {
  afterEach(() => setPlanSource(null))

  it('has a plan for every text step and for nothing else', () => {
    expect(Object.keys(DEFAULT_PLANS).sort()).toEqual([...TEXT_STEPS].sort())
    for (const observed of OBSERVED_STEPS) expect(Object.keys(DEFAULT_PLANS)).not.toContain(observed)
  })

  it('routes the chat family through the router chat, as chat-llm does today', () => {
    for (const step of ['chat', 'rag-summarize', 'rag-action-items', 'self-id', 'speaker-roster', 'meeting-pick', 'reformat'] as const) {
      expect(DEFAULT_PLANS[step].calls[0].profile).toEqual({ kind: 'router', task: 'chat', mode: 'chat' })
    }
  })

  it('routes notes through the suggestions task and outputs through resolve then generate', () => {
    expect(DEFAULT_PLANS.notes.calls[0].profile).toEqual({ kind: 'router', task: 'suggestions', mode: 'chat' })
    expect(DEFAULT_PLANS.outputs.calls[0].profile).toEqual({ kind: 'router', task: 'outputs', mode: 'generate' })
  })

  it('has no fallback in any default plan: the router walks its own chain', () => {
    for (const step of TEXT_STEPS) expect(DEFAULT_PLANS[step].calls[0].onFail).toBeUndefined()
  })
})

describe('resolvePlan', () => {
  afterEach(() => setPlanSource(null))

  it('returns the default plan without a source', () => {
    expect(resolvePlan('notes')).toBe(DEFAULT_PLANS.notes)
  })

  it('returns the plan a source gives, and the default when the source has none for that step', () => {
    const custom: Plan = {
      calls: [{ profile: { kind: 'direct', id: 'haiku', harness: 'claude-code', model: 'haiku', effort: 'low' } }]
    }
    setPlanSource((step) => (step === 'notes' ? custom : null))
    expect(resolvePlan('notes')).toBe(custom)
    expect(resolvePlan('chat')).toBe(DEFAULT_PLANS.chat)
  })
})
