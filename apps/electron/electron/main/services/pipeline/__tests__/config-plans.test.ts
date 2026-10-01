/**
 * The configuration as the runner's plan source: a valid plan is expanded, an invalid one is ignored
 * with a reason, and a step with no entry stays on today's routing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AUTO_PROFILE, emptyPipelineConfig, type HarnessInfo, type PipelineConfig } from '../../../../../src/shared/pipeline-config'
import { createConfigPlanSource } from '../config-plans'
import { DEFAULT_PLANS } from '../steps'

const h = (over: Partial<HarnessInfo> & { id: string }): HarnessInfo => ({
  label: over.id, vendor: 'v', kind: 'api', textCapable: true, modelSelectable: true, effortLevels: null,
  dataLeavesMachine: true, latency: 'fast', ...over
})
const HARNESSES = [
  h({ id: 'gemini-api' }),
  h({ id: 'claude-code', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  h({ id: 'kiro', kind: 'cli', latency: 'slow', modelSelectable: false }),
  h({ id: 'jev', kind: 'special', textCapable: false })
]

const step = (profile: string, onFail?: string) => ({
  passes: [{ calls: [{ profile, tasks: '*' as const, role: 'produce' as const, ...(onFail ? { onFail: { profile: onFail } } : {}) }] }]
})

let pipeline: PipelineConfig | undefined
const source = () => createConfigPlanSource({ getPipeline: () => pipeline, getHarnesses: () => HARNESSES })

beforeEach(() => {
  pipeline = undefined
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('createConfigPlanSource', () => {
  it('has no plan when there is no pipeline section, or no entry for the step', () => {
    expect(source()('notes')).toBeNull()
    pipeline = emptyPipelineConfig()
    expect(source()('notes')).toBeNull()
  })

  it('expands a named profile into a direct profile with its model, effort, temperature and limit', () => {
    pipeline = {
      version: 1,
      profiles: { 'claude-code-haiku-low': { harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } },
      steps: { notes: step('claude-code-haiku-low') }
    }
    expect(source()('notes')).toEqual({
      calls: [{ profile: { kind: 'direct', id: 'claude-code-haiku-low', harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } }]
    })
  })

  it('keeps today\'s routing as the primary of an Automatic step with a fallback', () => {
    pipeline = { version: 1, profiles: { g: { harness: 'gemini-api' } }, steps: { chat: step(AUTO_PROFILE, 'g') } }
    expect(source()('chat')).toEqual({
      calls: [{ profile: DEFAULT_PLANS.chat.calls[0].profile, onFail: { kind: 'direct', id: 'g', harness: 'gemini-api' } }]
    })
  })

  it('leaves out the model of a harness that ignores it, because that harness would fail on one', () => {
    pipeline = { version: 1, profiles: { k: { harness: 'kiro', model: 'whatever' } }, steps: { notes: step('k') } }
    const plan = source()('notes')!
    expect(plan.calls[0].profile).toEqual({ kind: 'direct', id: 'k', harness: 'kiro' })
  })

  it('ignores a plan that is invalid, says why once, and does not ignore the valid ones', () => {
    pipeline = {
      version: 1,
      profiles: { j: { harness: 'jev' }, g: { harness: 'gemini-api' } },
      steps: { notes: step('j'), reformat: step('g'), chat: step('ghost') }
    }
    const plans = source()
    expect(plans('notes')).toBeNull() // Jev cannot write text
    expect(plans('chat')).toBeNull() // the profile does not exist
    expect(plans('reformat')).not.toBeNull()
    plans('notes')
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('does not ignore a plan for a warning', () => {
    pipeline = { version: 1, profiles: { c: { harness: 'claude-code' } }, steps: { 'self-id': step('c') } } // slow harness on a bulk step
    expect(source()('self-id')).not.toBeNull()
  })

  it('ignores every plan when the section has a version it does not read', () => {
    pipeline = { version: 2, profiles: {}, steps: { notes: step(AUTO_PROFILE) } } as unknown as PipelineConfig
    expect(source()('notes')).toBeNull()
  })

  it('reads the configuration at call time, so a change applies without a restart', () => {
    const plans = source()
    expect(plans('notes')).toBeNull()
    pipeline = { version: 1, profiles: { g: { harness: 'gemini-api' } }, steps: { notes: step('g') } }
    expect(plans('notes')).not.toBeNull()
  })
})
