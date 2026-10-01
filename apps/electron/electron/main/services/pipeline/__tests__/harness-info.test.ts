/**
 * The harness descriptors as the plain data the validation and the page use.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach, expectTypeOf } from 'vitest'
import type { BrainEffort } from '../../brains'
import type { EffortLevel } from '../../../../../src/shared/pipeline-config'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { resetBrainRegistry } from '../../brains'
import { listHarnessInfos } from '../harness-info'

afterEach(() => resetBrainRegistry())

describe('listHarnessInfos', () => {
  const byId = () => new Map(listHarnessInfos().map((h) => [h.id, h]))

  it('keeps the effort levels of the shared module the same as the brains', () => {
    expectTypeOf<BrainEffort>().toEqualTypeOf<EffortLevel>()
  })

  it('says which harnesses can write text: the brains that generate, not Jev, the audio engines or the embedding-only brain', () => {
    const h = byId()
    for (const id of ['gemini-api', 'ollama', 'openai-compatible', 'claude-code', 'codex', 'gemini-cli', 'kiro']) {
      expect(h.get(id)!.textCapable, id).toBe(true)
    }
    for (const id of ['jev', 'local-onnx-embed', 'vibevoice', 'local-asr', 'gemini-transcribe']) {
      expect(h.get(id)!.textCapable, id).toBe(false)
    }
  })

  it('carries the effort levels, the model rule, the privacy and the latency of each descriptor', () => {
    const h = byId()
    expect(h.get('claude-code')).toMatchObject({ effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], modelSelectable: true, dataLeavesMachine: true, latency: 'slow', vendor: 'Anthropic' })
    expect(h.get('gemini-api')!.effortLevels).toBeNull()
    expect(h.get('kiro')!.modelSelectable).toBe(false)
    expect(h.get('ollama')).toMatchObject({ dataLeavesMachine: false, kind: 'local' })
  })
})
