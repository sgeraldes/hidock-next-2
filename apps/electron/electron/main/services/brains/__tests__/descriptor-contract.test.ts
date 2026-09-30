/**
 * Every brain the registry builds describes itself, and what it says agrees with what it does.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// Same stubs as brain-registry.test.ts: the registry constructs the real brains, and constructing
// them must not touch Electron or the network.
vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { getBrainRegistry, resetBrainRegistry } from '../brain-registry'
import { BRAIN_CAPABILITY_TO_HARNESS } from '../descriptor'

describe('every registered brain describes itself', () => {
  afterEach(() => resetBrainRegistry())

  it('has its own descriptor (not the derived one), with its id and label', () => {
    for (const brain of getBrainRegistry().list()) {
      expect(brain.descriptor, `${brain.id} has no descriptor()`).toBeTypeOf('function')
      const d = brain.descriptor!()
      expect(d.id).toBe(brain.id)
      expect(d.label).toBe(brain.label)
    }
  })

  it('advertises at least what the brain can do', () => {
    for (const brain of getBrainRegistry().list()) {
      const d = brain.descriptor!()
      for (const c of brain.capabilities()) {
        expect(d.capabilities.has(BRAIN_CAPABILITY_TO_HARNESS[c]), `${brain.id}: ${c}`).toBe(true)
      }
    }
  })

  it('keeps data on the machine for local brains and says it leaves for the rest', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('ollama')!.dataLeavesMachine).toBe(false)
    expect(byId.get('local-onnx-embed')!.dataLeavesMachine).toBe(false)
    expect(byId.get('openai-compatible')!.dataLeavesMachine).toBe(false)
    for (const id of ['gemini-api', 'claude-code', 'codex', 'gemini-cli', 'kiro'] as const) {
      expect(byId.get(id)!.dataLeavesMachine, id).toBe(true)
    }
  })

  it('states how effort is set, only where the harness has the notion', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('gemini-api')!.effort).toEqual({ kind: 'thinking-budget' })
    expect(byId.get('ollama')!.effort).toEqual({ kind: 'none' })
    expect(byId.get('claude-code')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(byId.get('codex')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high'] })
    expect(byId.get('kiro')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
  })

  it('marks the harnesses that ignore a chosen model', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('kiro')!.modelSelectable).toBe(false)
    expect(byId.get('local-onnx-embed')!.modelSelectable).toBe(false)
    expect(byId.get('claude-code')!.modelSelectable).toBe(true)
  })

  it('says what each one needs before it can run', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('gemini-api')!.needs).toBe('api-key')
    expect(byId.get('ollama')!.needs).toBe('running-server')
    expect(byId.get('local-onnx-embed')!.needs).toBe('model-files')
    expect(byId.get('claude-code')!.needs).toBe('cli-login')
  })
})
