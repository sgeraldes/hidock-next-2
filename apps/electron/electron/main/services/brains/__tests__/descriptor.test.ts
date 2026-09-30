/**
 * Harness descriptor vocabulary: the shared words the pipeline uses to say what a harness can do.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { BRAIN_CAPABILITY_TO_HARNESS, caps, describeBrain, missingCapabilities } from '../descriptor'
import type { HarnessDescriptor } from '../descriptor'
import type { AIBrain, BrainCapability } from '../types'

function bareBrain(over: Partial<AIBrain> = {}): AIBrain {
  return {
    id: 'ollama',
    label: 'Bare brain',
    capabilities: () => new Set<BrainCapability>(['generate', 'chat', 'embed']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: async () => null,
    chat: async () => null,
    ...over
  }
}

const own: HarnessDescriptor = {
  id: 'ollama',
  label: 'Own',
  kind: 'local',
  vendor: 'local',
  dataLeavesMachine: false,
  latency: 'medium',
  capabilities: caps('text'),
  effort: { kind: 'none' },
  needs: 'running-server',
  modelSelectable: true
}

describe('describeBrain', () => {
  it('uses the descriptor the brain provides', () => {
    expect(describeBrain(bareBrain({ descriptor: () => own }))).toBe(own)
  })

  it('derives one from the capabilities of a brain that has none (a fake, an old adapter)', () => {
    const derived = describeBrain(bareBrain())
    expect(derived.id).toBe('ollama')
    expect(derived.label).toBe('Bare brain')
    expect([...derived.capabilities].sort()).toEqual(['embedding', 'text'])
    // Unknown means cautious: the data is assumed to leave the machine and the harness to be slow.
    expect(derived.dataLeavesMachine).toBe(true)
    expect(derived.effort).toEqual({ kind: 'none' })
  })
})

describe('missingCapabilities', () => {
  it('names what a harness lacks, in the order asked', () => {
    const d = { ...own, capabilities: caps('text', 'json-schema') }
    expect(missingCapabilities(d, ['audio', 'text', 'timestamps'])).toEqual(['audio', 'timestamps'])
    expect(missingCapabilities(d, ['text'])).toEqual([])
  })
})

describe('vocabulary', () => {
  it('maps every brain capability to a descriptor capability', () => {
    const all: BrainCapability[] = ['generate', 'chat', 'analyzeAudio', 'embed', 'agentic']
    for (const c of all) expect(BRAIN_CAPABILITY_TO_HARNESS[c], c).toBeTruthy()
    expect(Object.keys(BRAIN_CAPABILITY_TO_HARNESS).sort()).toEqual([...all].sort())
  })
})
