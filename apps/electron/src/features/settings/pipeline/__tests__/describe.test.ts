import { describe, it, expect } from 'vitest'
import { AUTO_PROFILE, emptyPipelineConfig, type HarnessInfo, type PipelineConfig } from '@/shared/pipeline-config'
import { choiceFromProfile, describePlan, draftFromConfig, formatStats, privacyLabel, toStepChoice } from '../describe'

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
  harness({ id: 'gemini-api', label: 'Gemini (API key)', vendor: 'Google' }),
  harness({ id: 'ollama', label: 'Ollama', vendor: 'local', kind: 'local', dataLeavesMachine: false }),
  harness({ id: 'claude-code', label: 'Claude Code SDK', vendor: 'Anthropic', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  harness({ id: 'kiro', label: 'Kiro', vendor: 'AWS', kind: 'cli', latency: 'slow', modelSelectable: false })
]

const withNotes = (profiles: PipelineConfig['profiles'], profile: string, onFail?: string): PipelineConfig => ({
  version: 1,
  profiles,
  steps: { notes: { passes: [{ calls: [{ profile, tasks: '*', role: 'produce', ...(onFail ? { onFail: { profile: onFail } } : {}) }] }] } }
})

describe('describePlan', () => {
  it('says Automatic for a step with no entry', () => {
    expect(describePlan(emptyPipelineConfig(), 'notes', HARNESSES)).toBe('Automatic')
  })

  it('names the harness, model and effort of a profile, and a fallback after it', () => {
    const config = withNotes({ 'claude-code-haiku-low': { harness: 'claude-code', model: 'haiku', effort: 'low' }, g: { harness: 'gemini-api' } }, 'claude-code-haiku-low', 'g')
    expect(describePlan(config, 'notes', HARNESSES)).toBe('Claude Code SDK · haiku · low, then Gemini (API key)')
  })

  it('says Automatic as the main choice of a step that only has a fallback', () => {
    expect(describePlan(withNotes({ g: { harness: 'gemini-api' } }, AUTO_PROFILE, 'g'), 'notes', HARNESSES)).toBe('Automatic, then Gemini (API key)')
  })

  it('falls back to the harness id when the harness is not in the list, and to Automatic for a missing profile', () => {
    expect(describePlan(withNotes({ x: { harness: 'gone' } }, 'x'), 'notes', HARNESSES)).toBe('gone')
    expect(describePlan(withNotes({}, 'ghost'), 'notes', HARNESSES)).toBe('Automatic')
  })
})

describe('privacyLabel', () => {
  it('follows the AI providers page for Automatic', () => {
    expect(privacyLabel(emptyPipelineConfig(), 'notes', HARNESSES)).toBe('Follows AI providers')
    expect(privacyLabel(withNotes({ g: { harness: 'gemini-api' } }, AUTO_PROFILE, 'g'), 'notes', HARNESSES)).toBe('Follows AI providers')
  })

  it('follows the AI providers page for a plan that names a profile or a harness the app cannot run, because the step runs as Automatic', () => {
    expect(privacyLabel(withNotes({}, 'ghost'), 'notes', HARNESSES)).toBe('Follows AI providers')
    expect(privacyLabel(withNotes({ x: { harness: 'gone' } }, 'x'), 'notes', HARNESSES)).toBe('Follows AI providers')
    expect(privacyLabel(withNotes({ o: { harness: 'ollama' } }, 'o', 'ghost'), 'notes', HARNESSES)).toBe('Follows AI providers')
  })

  it('stays on this computer when every harness of the plan is local', () => {
    expect(privacyLabel(withNotes({ o: { harness: 'ollama' } }, 'o'), 'notes', HARNESSES)).toBe('Stays on this computer')
  })

  it('names the vendors the text is sent to, once each', () => {
    expect(privacyLabel(withNotes({ g: { harness: 'gemini-api' } }, 'g'), 'notes', HARNESSES)).toBe('Sent to Google')
    expect(privacyLabel(withNotes({ g: { harness: 'gemini-api' }, c: { harness: 'claude-code' } }, 'g', 'c'), 'notes', HARNESSES)).toBe('Sent to Google and Anthropic')
    expect(privacyLabel(withNotes({ g: { harness: 'gemini-api', model: 'a' }, h: { harness: 'gemini-api', model: 'b' } }, 'g', 'h'), 'notes', HARNESSES)).toBe('Sent to Google')
  })

  it('lists three vendors with commas, and ignores a local fallback beside a cloud main choice', () => {
    const three = withNotes({ g: { harness: 'gemini-api' }, c: { harness: 'claude-code' }, k: { harness: 'kiro' } }, 'g', 'c')
    three.steps.notes!.passes[0].calls.push({ profile: 'k', tasks: '*', role: 'produce' })
    expect(privacyLabel(three, 'notes', HARNESSES)).toBe('Sent to Google, Anthropic and AWS')
    expect(privacyLabel(withNotes({ g: { harness: 'gemini-api' }, o: { harness: 'ollama' } }, 'g', 'o'), 'notes', HARNESSES)).toBe('Sent to Google')
  })
})

describe('formatStats', () => {
  it('says No calls yet without numbers', () => {
    expect(formatStats(undefined)).toBe('No calls yet')
    expect(formatStats({ calls: 0, failed: 0, medianMs: null, medianCostUsd: null })).toBe('No calls yet')
  })

  it('gives the median time and cost and the number of calls', () => {
    expect(formatStats({ calls: 12, failed: 0, medianMs: 2100, medianCostUsd: 0.0003 })).toBe('Median 2.1 s · $0.0003 · 12 calls')
  })

  it('says so when no cost was recorded, and uses milliseconds under a second', () => {
    expect(formatStats({ calls: 3, failed: 0, medianMs: 850, medianCostUsd: null })).toBe('Median 850 ms · no cost recorded · 3 calls')
  })

  it('writes one call in the singular and shows two decimals for a cost over a cent', () => {
    expect(formatStats({ calls: 1, failed: 0, medianMs: 1000, medianCostUsd: 0.1234 })).toBe('Median 1.0 s · $0.12 · 1 call')
  })

  it('adds how many failed, and says when none completed', () => {
    expect(formatStats({ calls: 12, failed: 1, medianMs: 2100, medianCostUsd: 0.0003 })).toBe('Median 2.1 s · $0.0003 · 12 calls · 1 failed')
    expect(formatStats({ calls: 2, failed: 2, medianMs: null, medianCostUsd: null })).toBe('None completed · 2 calls · 2 failed')
  })
})

describe('draftFromConfig and toStepChoice', () => {
  it('opens a step with no entry on Automatic with no fallback', () => {
    expect(draftFromConfig(emptyPipelineConfig(), 'notes')).toEqual({
      primary: { harness: AUTO_PROFILE, model: '', effort: '' },
      fallback: { harness: '', model: '', effort: '' }
    })
  })

  it('reads the profiles of a saved plan into the fields', () => {
    const config = withNotes({ 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' }, c: { harness: 'claude-code', effort: 'low' } }, 'ollama-qwen3-8b', 'c')
    expect(draftFromConfig(config, 'notes')).toEqual({
      primary: { harness: 'ollama', model: 'qwen3:8b', effort: '' },
      fallback: { harness: 'claude-code', model: '', effort: 'low' }
    })
  })

  it('treats a profile that does not exist as Automatic', () => {
    expect(draftFromConfig(withNotes({}, 'ghost'), 'notes').primary.harness).toBe(AUTO_PROFILE)
  })

  it('turns the fields into a choice, leaving out a model the harness ignores and an effort it does not take', () => {
    expect(toStepChoice({ harness: AUTO_PROFILE, model: 'x', effort: 'low' }, HARNESSES)).toBe(AUTO_PROFILE)
    expect(toStepChoice({ harness: '', model: '', effort: '' }, HARNESSES)).toBeNull()
    expect(toStepChoice({ harness: 'gemini-api', model: ' gemini-3.8-flash ', effort: 'low' }, HARNESSES)).toEqual({ harness: 'gemini-api', model: 'gemini-3.8-flash' })
    expect(toStepChoice({ harness: 'kiro', model: 'x', effort: '' }, HARNESSES)).toEqual({ harness: 'kiro' })
    expect(toStepChoice({ harness: 'claude-code', model: 'haiku', effort: 'low' }, HARNESSES)).toEqual({ harness: 'claude-code', model: 'haiku', effort: 'low' })
  })

  it('reads a single profile into fields', () => {
    expect(choiceFromProfile({ harness: 'ollama', model: 'm' })).toEqual({ harness: 'ollama', model: 'm', effort: '' })
  })
})
