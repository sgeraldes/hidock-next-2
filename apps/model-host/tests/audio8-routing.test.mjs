import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
vi.mock('../src/diarize.mjs', async importOriginal => ({ ...(await importOriginal()), runDiarization: vi.fn((audio, options) => options) }))
import { AUDIO8_MEMORY_PROFILE } from '../src/diarize.mjs'
import { runAsr, ASR_MODELS } from '../src/asr.mjs'
import { asrRuntimeFingerprint } from '../src/asr-readiness.mjs'
import { AUDIO8_ASR } from '../src/asr-catalog.mjs'
const model = 'Edge0/Audio8-ASR-Infinite'
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Audio8 native host integration', () => {
  it('routes English through the bounded supervisor with its isolated Transformers runtime', () => {
    expect(ASR_MODELS.has(model)).toBe(true)
    expect(AUDIO8_ASR[model].exitCode).toBe(85)
    const result = runAsr('sample.wav', { model, language: 'en-US', hostRoot: 'fixture', workerPath: 'worker.py' })
    const args = result.workerArgs('normalized.wav')
    expect(args[0]).toMatch(/audio8_asr_worker\.py$/)
    expect(args).toContain(join('fixture', 'runtime', 'asr-audio8', 'site'))
    expect(args).toContain(join('fixture', 'models', 'audio8-asr-infinite'))
    expect(args).not.toContain('--torch-site-dir')
    expect(result.memoryProfile).toBe(AUDIO8_MEMORY_PROFILE)
  })
  it('does not carry an Audio8 budget into an ordinary model', () => {
    const result = runAsr('sample.wav', { model: 'nvidia/parakeet-tdt-0.6b-v3', workerPath: 'worker.py',
      memoryProfile: AUDIO8_MEMORY_PROFILE })
    expect(result.memoryProfile).toBeUndefined()
  })
  it.each(['es', 'auto', undefined])('rejects unsupported language before subprocess launch: %s', language => {
    expect(() => runAsr('sample.wav', { model, language })).toThrow(/English/)
  })
  it('fingerprints installed source, model and compatible base torch without hashing GB weights', () => {
    const root = mkdtempSync(join(tmpdir(), 'hidock-audio8-test-')); roots.push(root)
    const python = join(root, 'runtime/python/python.exe')
    const modelRoot = join(root, 'models/audio8-asr-infinite')
    const source = join(modelRoot, 'source/audio8_asr_infinite')
    const files = [python, join(root, 'runtime/asr-audio8/site/transformers/__init__.py'),
      join(dirname(python), 'Lib/site-packages/torch/version.py'), join(modelRoot, 'hidock-manifest.json'),
      join(modelRoot, 'model.safetensors'), join(modelRoot, 'semantic_vad_heads.safetensors'),
      join(modelRoot, 'model.safetensors.index.json'), ...['__init__.py', 'modeling/__init__.py',
        'modeling/configuration_audio8_asr_infinite.py', 'modeling/modeling_audio8_asr_infinite.py',
        'simulated_streaming_audio.py', 'streaming_inference.py'].map(file => join(source, file))]
    for (const file of files) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture') }
    const fingerprint = asrRuntimeFingerprint(python, model, root)
    writeFileSync(join(source, 'streaming_inference.py'), 'changed-source')
    expect(asrRuntimeFingerprint(python, model, root)).not.toBe(fingerprint)
    const sourceFingerprint = asrRuntimeFingerprint(python, model, root)
    writeFileSync(join(modelRoot, 'model.safetensors.index.json'), '{"weight_map":{"changed":"semantic_vad_heads.safetensors"}}')
    expect(asrRuntimeFingerprint(python, model, root)).not.toBe(sourceFingerprint)
    const indexFingerprint = asrRuntimeFingerprint(python, model, root)
    writeFileSync(join(modelRoot, 'semantic_vad_heads.safetensors'), 'changed-vad-shard-size')
    expect(asrRuntimeFingerprint(python, model, root)).not.toBe(indexFingerprint)
    rmSync(join(modelRoot, 'semantic_vad_heads.safetensors'))
    expect(() => asrRuntimeFingerprint(python, model, root)).toThrow()
    writeFileSync(join(modelRoot, 'semantic_vad_heads.safetensors'), 'fixture')
    rmSync(join(modelRoot, 'model.safetensors'))
    expect(() => asrRuntimeFingerprint(python, model, root)).toThrow()
  })
})
