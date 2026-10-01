/**
 * The owner's pipeline choices: what is valid, and how a step draft becomes configuration.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  AUTO_PROFILE,
  applyStepDraft,
  emptyPipelineConfig,
  profileIdFor,
  validatePipelineConfig,
  type HarnessInfo,
  type PipelineConfig
} from '../pipeline-config'

const harness = (over: Partial<HarnessInfo> & { id: string }): HarnessInfo => ({
  label: over.id,
  vendor: 'v',
  kind: 'api',
  textCapable: true,
  modelSelectable: true,
  effortLevels: null,
  dataLeavesMachine: true,
  latency: 'fast',
  ...over
})

const HARNESSES: HarnessInfo[] = [
  harness({ id: 'gemini-api', vendor: 'Google' }),
  harness({ id: 'claude-code', vendor: 'Anthropic', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  harness({ id: 'ollama', vendor: 'local', kind: 'local', dataLeavesMachine: false, latency: 'medium' }),
  harness({ id: 'kiro', vendor: 'AWS', kind: 'cli', latency: 'slow', modelSelectable: false, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  harness({ id: 'jev', kind: 'special', textCapable: false }),
  harness({ id: 'local-onnx-embed', kind: 'local', textCapable: false })
]

const withStep = (profiles: PipelineConfig['profiles'], step: string, primary: string, onFail?: string): PipelineConfig =>
  ({
    version: 1,
    profiles,
    steps: { [step]: { passes: [{ calls: [{ profile: primary, tasks: '*', role: 'produce', ...(onFail ? { onFail: { profile: onFail } } : {}) }] }] } }
  }) as PipelineConfig

const errors = (c: PipelineConfig) => validatePipelineConfig(c, HARNESSES).filter((i) => i.severity === 'error')
const warnings = (c: PipelineConfig) => validatePipelineConfig(c, HARNESSES).filter((i) => i.severity === 'warning')

describe('validatePipelineConfig', () => {
  it('accepts the empty configuration and a plain single plan', () => {
    expect(validatePipelineConfig(emptyPipelineConfig(), HARNESSES)).toEqual([])
    expect(validatePipelineConfig(withStep({ g: { harness: 'gemini-api', model: 'gemini-3.8-flash' } }, 'notes', 'g'), HARNESSES)).toEqual([])
  })

  it('accepts Automatic as a profile, alone or as the primary of a fallback', () => {
    expect(errors(withStep({}, 'chat', AUTO_PROFILE))).toEqual([])
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'chat', AUTO_PROFILE, 'g'))).toEqual([])
  })

  it('refuses a profile that does not exist, and names the step', () => {
    const [issue] = errors(withStep({}, 'notes', 'ghost'))
    expect(issue.message).toMatch(/ghost/)
    expect(issue.step).toBe('notes')
  })

  it('refuses a harness that does not exist or cannot write text', () => {
    expect(errors(withStep({ x: { harness: 'nope' } }, 'notes', 'x'))[0].message).toMatch(/nope/)
    expect(errors(withStep({ j: { harness: 'jev' } }, 'notes', 'j'))[0].message).toMatch(/cannot write text/)
    expect(errors(withStep({ e: { harness: 'local-onnx-embed' } }, 'notes', 'e'))[0].message).toMatch(/cannot write text/)
  })

  it('warns, without refusing, when the harness ignores the model or the effort', () => {
    const c = withStep({ k: { harness: 'kiro', model: 'x' }, g: { harness: 'gemini-api', effort: 'low' } }, 'notes', 'k', 'g')
    expect(errors(c)).toEqual([])
    expect(warnings(c).map((w) => w.message).join(' ')).toMatch(/ignores the model/)
    expect(warnings(c).map((w) => w.message).join(' ')).toMatch(/does not take an effort/)
  })

  it('refuses an effort the harness does not offer, and bad numbers', () => {
    expect(errors(withStep({ c: { harness: 'claude-code', effort: 'ultra' as never } }, 'notes', 'c'))[0].message).toMatch(/effort/)
    expect(errors(withStep({ c: { harness: 'ollama', temperature: 3 } }, 'notes', 'c'))[0].message).toMatch(/temperature/)
    expect(errors(withStep({ c: { harness: 'ollama', maxTokens: 0 } }, 'notes', 'c'))[0].message).toMatch(/limit/)
  })

  it('refuses a fallback that is the primary, and a fallback to a missing profile', () => {
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g', 'g'))[0].message).toMatch(/same/)
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g', 'ghost'))[0].message).toMatch(/ghost/)
  })

  it('refuses a step it does not know, more than one pass or call, and another version', () => {
    expect(errors({ version: 1, profiles: {}, steps: { nope: { passes: [] } } } as unknown as PipelineConfig)[0].message).toMatch(/nope/)
    const two = withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g')
    two.steps.notes!.passes.push({ calls: [{ profile: 'g', tasks: '*', role: 'produce' }] })
    expect(errors(two)[0].message).toMatch(/one pass/)
    expect(errors({ version: 2, profiles: {}, steps: {} } as unknown as PipelineConfig)[0].message).toMatch(/version/)
  })

  it('warns that a CLI on a step that runs in bulk takes seconds per call, and not on an interactive one', () => {
    const profiles = { c: { harness: 'claude-code' } }
    expect(warnings(withStep(profiles, 'self-id', 'c')).map((w) => w.message).join(' ')).toMatch(/seconds/)
    expect(warnings(withStep(profiles, 'chat', 'c'))).toEqual([])
  })
})

describe('profileIdFor', () => {
  it('names a profile from its harness, model and effort, in a form that is safe as a key', () => {
    expect(profileIdFor({ harness: 'claude-code', model: 'haiku', effort: 'low' })).toBe('claude-code-haiku-low')
    expect(profileIdFor({ harness: 'ollama', model: 'qwen3:8b' })).toBe('ollama-qwen3-8b')
    expect(profileIdFor({ harness: 'gemini-api' })).toBe('gemini-api')
    expect(profileIdFor({ harness: 'ollama', model: 'Qwen 3 / 8B!!', temperature: 0.2 })).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('gives two profiles that differ only in temperature or limit different names', () => {
    const a = profileIdFor({ harness: 'ollama', model: 'm', temperature: 0.2 })
    const b = profileIdFor({ harness: 'ollama', model: 'm', temperature: 0.7 })
    expect(a).not.toBe(b)
  })
})

describe('applyStepDraft', () => {
  it('creates the profile of a draft and points the step at it', () => {
    const next = applyStepDraft(emptyPipelineConfig(), 'notes', { harness: 'claude-code', model: 'haiku', effort: 'low' }, null)
    expect(next.profiles['claude-code-haiku-low']).toEqual({ harness: 'claude-code', model: 'haiku', effort: 'low' })
    expect(next.steps.notes!.passes[0].calls[0]).toEqual({ profile: 'claude-code-haiku-low', tasks: '*', role: 'produce' })
  })

  it('adds a fallback, and keeps Automatic as the primary when asked', () => {
    const next = applyStepDraft(emptyPipelineConfig(), 'chat', AUTO_PROFILE, { harness: 'ollama', model: 'qwen3:8b' })
    expect(next.steps.chat!.passes[0].calls[0]).toEqual({ profile: AUTO_PROFILE, tasks: '*', role: 'produce', onFail: { profile: 'ollama-qwen3-8b' } })
  })

  it('removes the step entry when it is Automatic with no fallback, and the profiles nobody uses', () => {
    const set = applyStepDraft(emptyPipelineConfig(), 'notes', { harness: 'ollama', model: 'm' }, null)
    const reset = applyStepDraft(set, 'notes', AUTO_PROFILE, null)
    expect(reset.steps.notes).toBeUndefined()
    expect(reset.profiles).toEqual({})
  })

  it('reuses one profile for two steps and keeps it while either uses it', () => {
    const draft = { harness: 'ollama', model: 'm' }
    let c = applyStepDraft(emptyPipelineConfig(), 'notes', draft, null)
    c = applyStepDraft(c, 'reformat', draft, null)
    expect(Object.keys(c.profiles)).toEqual(['ollama-m'])
    c = applyStepDraft(c, 'notes', AUTO_PROFILE, null)
    expect(c.profiles['ollama-m']).toBeDefined()
    c = applyStepDraft(c, 'reformat', AUTO_PROFILE, null)
    expect(c.profiles).toEqual({})
  })

  it('does not change its input', () => {
    const base = emptyPipelineConfig()
    applyStepDraft(base, 'notes', { harness: 'ollama' }, null)
    expect(base).toEqual(emptyPipelineConfig())
  })
})
