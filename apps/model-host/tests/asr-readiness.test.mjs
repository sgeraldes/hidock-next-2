import { describe, expect, it, vi } from 'vitest'
import { readyAsrModels, asrRuntimeFingerprint } from '../src/asr-readiness.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
const model = 'microsoft/VibeVoice-ASR'
const proof = { testedAt: 'fixture', modelVersion: 'revision', device: 'cuda', fingerprint: 'current' }
describe('ASR capability readiness', () => {
  it('invalidates Audio8 proof when its second shard or shard index changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'hidock-audio8-proof-'))
    const put = (path, value = 'fixture') => {
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, value)
    }
    try {
      const folder = 'models/audio8-asr-infinite/'
      for (const file of ['python.exe', 'Lib/site-packages/torch/version.py',
        'runtime/asr-audio8/site/transformers/__init__.py']) put(file)
      for (const file of ['hidock-manifest.json', 'model.safetensors', 'semantic_vad_heads.safetensors',
        'model.safetensors.index.json']) put(folder + file)
      for (const file of ['__init__.py', 'modeling/__init__.py', 'modeling/configuration_audio8_asr_infinite.py',
        'modeling/modeling_audio8_asr_infinite.py', 'simulated_streaming_audio.py', 'streaming_inference.py']) {
        put(folder + 'source/audio8_asr_infinite/' + file)
      }
      const fingerprint = () => asrRuntimeFingerprint(join(root, 'python.exe'), 'Edge0/Audio8-ASR-Infinite', root)
      const original = fingerprint()
      put(folder + 'semantic_vad_heads.safetensors', 'different-sized-shard')
      const changedShard = fingerprint()
      expect(changedShard).not.toBe(original)
      put(folder + 'model.safetensors.index.json', 'different-index')
      expect(fingerprint()).not.toBe(changedShard)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('advertises only configured supported models with a matching runtime proof', () => {
    expect(readyAsrModels({ asrModels: [model, 'unknown'], asrValidation: { [model]: proof } }, 'python', () => 'current'))
      .toEqual([model])
  })
  it.each([undefined, { ...proof, fingerprint: 'old' }, { ...proof, modelVersion: undefined }, { ...proof, device: undefined }])(
    'declines absent, stale or incomplete proof %j', validation => {
      expect(readyAsrModels({ asrModels: [model], asrValidation: { [model]: validation } }, 'python', () => 'current')).toEqual([])
    })
  it('fails closed when runtime fingerprinting cannot read the installed files', () => {
    const fingerprint = vi.fn(() => { throw new Error('missing runtime') })
    expect(readyAsrModels({ asrModels: [model], asrValidation: { [model]: proof } }, 'python', fingerprint)).toEqual([])
  })
})
