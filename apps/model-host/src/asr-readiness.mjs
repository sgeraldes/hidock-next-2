import { createHash } from 'crypto'
import { readFileSync, statSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ASR_MODELS } from './asr.mjs'
import { ONNX_ASR, PHOTON_ASR, NATIVE_ASR, MOSS_ASR, AUDIO8_ASR } from './asr-catalog.mjs'
import { hostRoot } from './config.mjs'

/** Invalidate a successful model test when its runtime or worker changes. */
export function asrRuntimeFingerprint(pythonPath, model, root = hostRoot()) {
  if (AUDIO8_ASR[model]) {
    const hash = createHash('sha256')
    const here = dirname(fileURLToPath(import.meta.url))
    const modelDir = join(root, 'models', AUDIO8_ASR[model].directory)
    for (const file of [pythonPath, join(here, 'audio8_asr_worker.py'), join(here, 'prepare_audio8_asr.py'),
      join(here, 'parakeet_worker.py'), join(root, 'runtime', 'asr-audio8', 'site', 'transformers', '__init__.py'),
      join(dirname(pythonPath), 'Lib', 'site-packages', 'torch', 'version.py'),
      join(modelDir, 'hidock-manifest.json')]) hash.update(readFileSync(file))
    for (const file of ['__init__.py', 'modeling/__init__.py', 'modeling/configuration_audio8_asr_infinite.py',
      'modeling/modeling_audio8_asr_infinite.py', 'simulated_streaming_audio.py', 'streaming_inference.py']) {
      hash.update(readFileSync(join(modelDir, 'source', 'audio8_asr_infinite', file)))
    }
    hash.update(readFileSync(join(modelDir, 'model.safetensors.index.json')))
    for (const file of ['model.safetensors', 'semantic_vad_heads.safetensors']) {
      const weights = statSync(join(modelDir, file))
      hash.update(file).update(String(weights.size)).update(String(weights.mtimeMs))
    }
    return hash.digest('hex')
  }
  if (MOSS_ASR[model]) {
    const hash = createHash('sha256')
    for (const file of [pythonPath, join(dirname(fileURLToPath(import.meta.url)), 'moss_asr_worker.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'prepare_moss_asr.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'asr_worker.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'parakeet_worker.py'),
      join(root, 'runtime', 'asr-moss', 'site', 'transformers', '__init__.py'),
      join(dirname(pythonPath), 'Lib', 'site-packages', 'torch', 'version.py'),
      join(root, 'models', MOSS_ASR[model].directory, 'hidock-manifest.json')]) hash.update(readFileSync(file))
    return hash.digest('hex')
  }
  if (NATIVE_ASR[model]) {
    const hash = createHash('sha256')
    const modelDir = join(root, 'models', NATIVE_ASR[model].directory)
    const bin = join(root, 'runtime', 'asr-nemotron', 'nemo-speech-0.2.0-windows-x86_64-cuda', 'bin')
    for (const file of [pythonPath, join(dirname(fileURLToPath(import.meta.url)), 'nemotron_asr_worker.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'parakeet_worker.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'prepare_nemotron_asr.py'),
      join(modelDir, 'hidock-manifest.json'), join(bin, 'nemo-speech.exe')]) hash.update(readFileSync(file))
    // No multi-GB weight hashing on each health request; preparation checks SHA-256.
    for (const file of [join(modelDir, 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'),
      ...readdirSync(bin).filter(name => name.endsWith('.dll')).sort().map(name => join(bin, name))]) {
      const info = statSync(file)
      hash.update(file).update(String(info.size)).update(String(info.mtimeMs))
    }
    return hash.digest('hex')
  }
  if (ONNX_ASR[model]) {
    const hash = createHash('sha256')
    for (const file of [pythonPath, join(dirname(fileURLToPath(import.meta.url)), 'parakeet_worker.py'),
      join(root, 'runtime', 'asr-onnx', 'site', 'sherpa_onnx', '__init__.py'),
      join(root, 'models', ONNX_ASR[model].directory, 'hidock-manifest.json')]) {
      hash.update(file).update(readFileSync(file))
    }
    return hash.digest('hex')
  }
  if (PHOTON_ASR[model]) {
    const hash = createHash('sha256')
    for (const file of [pythonPath, join(dirname(fileURLToPath(import.meta.url)), 'photon_asr_worker.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'parakeet_worker.py'),
      join(root, 'runtime', 'asr-photon', 'site', 'moondream', '__init__.py'),
      join(root, 'runtime', 'asr-photon', 'site', 'torch', 'version.py'),
      join(root, 'models', PHOTON_ASR[model].directory, 'hidock-manifest.json')]) hash.update(readFileSync(file))
    return hash.digest('hex')
  }
  const home = dirname(pythonPath)
  const files = [pythonPath, join(dirname(fileURLToPath(import.meta.url)), 'asr_worker.py'),
    join(home, 'Lib', 'site-packages', 'transformers', '__init__.py')]
  if (model === 'microsoft/VibeVoice-ASR') files.push(join(home, 'Lib', 'site-packages', 'vibevoice', '__init__.py'))
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(String(statSync(file).size)).update(readFileSync(file))
  return hash.digest('hex')
}
export function readyAsrModels(config, pythonPath, fingerprint = asrRuntimeFingerprint) {
  return (config.asrModels || []).filter(model => {
    if (!ASR_MODELS.has(model)) return false
    const proof = config.asrValidation?.[model]
    if (!proof?.testedAt || !proof?.modelVersion || !proof?.device || !proof?.fingerprint) return false
    try { return fingerprint(pythonPath, model) === proof.fingerprint } catch { return false }
  })
}
