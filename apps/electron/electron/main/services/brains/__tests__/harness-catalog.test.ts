/**
 * One list of every harness the pipeline can name: the brains, the audio engines and Jev.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { resetBrainRegistry } from '../brain-registry'
import { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from '../engine-descriptors'
import { findHarness, harnessesWith, listHarnessDescriptors } from '../harness-catalog'

describe('harness catalog', () => {
  afterEach(() => resetBrainRegistry())

  it('lists the brains, the engines and Jev, each id once', () => {
    const ids = listHarnessDescriptors().map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['gemini-api', 'ollama', 'openai-compatible', 'claude-code', 'kiro']) expect(ids).toContain(id)
    for (const d of ENGINE_DESCRIPTORS) expect(ids).toContain(d.id)
    expect(ids).toContain('jev')
  })

  it('finds a harness by id, and null for an id it does not know', () => {
    expect(findHarness('vibevoice')?.kind).toBe('engine')
    expect(findHarness('jev')).toBe(JEV_DESCRIPTOR)
    expect(findHarness('nope')).toBeNull()
  })

  it('says which audio engines give timestamps and speakers', () => {
    const asr = (id: string) => findHarness(id)!
    for (const id of ['gemini-transcribe', 'vibevoice']) {
      expect(asr(id).capabilities.has('timestamps'), id).toBe(true)
      expect(asr(id).capabilities.has('diarization'), id).toBe(true)
    }
    expect(asr('gemini-live').capabilities.has('streaming')).toBe(true)
    expect(asr('pyannote-onnx').capabilities.has('audio')).toBe(true)
    expect(asr('pyannote-onnx').capabilities.has('timestamps')).toBe(false)
  })

  it('offers only harnesses that satisfy every capability asked for', () => {
    const transcribers = harnessesWith(['audio', 'timestamps', 'diarization']).map((d) => d.id).sort()
    expect(transcribers).toEqual(['gemini-transcribe', 'local-asr', 'vibevoice'])
    const embedders = harnessesWith(['embedding']).map((d) => d.id).sort()
    expect(embedders).toEqual(['gemini-api', 'local-onnx-embed', 'ollama', 'openai-compatible'])
    expect(harnessesWith(['classification']).map((d) => d.id)).toEqual(['jev'])
  })

  it('keeps audio engines that run on this machine local, and marks the network ones', () => {
    expect(findHarness('local-asr')!.dataLeavesMachine).toBe(false)
    expect(findHarness('vibevoice')!.dataLeavesMachine).toBe(false)
    expect(findHarness('pyannote-onnx')!.dataLeavesMachine).toBe(false)
    expect(findHarness('gemini-transcribe')!.dataLeavesMachine).toBe(true)
    // The Model Host is another machine: the audio leaves this one.
    expect(findHarness('model-host')!.dataLeavesMachine).toBe(true)
    expect(JEV_DESCRIPTOR.dataLeavesMachine).toBe(true)
  })
})
