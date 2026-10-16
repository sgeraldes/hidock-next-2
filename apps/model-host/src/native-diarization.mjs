import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiarization, parseWorkerOutput } from './diarize.mjs'

export const NATIVE_DIARIZATION_MODEL = 'nvidia/Nemotron-3-Diarization'
const here = dirname(fileURLToPath(import.meta.url))
export function nativeDiarizationFingerprint(pythonPath, root) {
  const hash = createHash('sha256')
  for (const path of [pythonPath, join(here, 'nemotron_diarization_worker.py'),
    join(here, 'nemotron_asr_worker.py'), join(here, 'parakeet_worker.py'),
    join(root, 'models', 'nemotron-3-diarization-gguf', 'hidock-manifest.json'),
    join(root, 'runtime', 'asr-nemotron', 'nemo-speech-0.2.0-windows-x86_64-cuda', 'bin', 'nemo-speech.exe')]) {
    hash.update(readFileSync(path))
  }
  const weights = statSync(join(root, 'models', 'nemotron-3-diarization-gguf', 'Nemotron-3-Diarization.q8_0.gguf'))
  return hash.update(String(weights.size)).update(String(weights.mtimeMs)).digest('hex')
}
export function readyNativeDiarization(config, pythonPath, root) {
  const proof = config.diarizationValidation?.[NATIVE_DIARIZATION_MODEL]
  try {
    return Boolean(proof?.testedAt && proof?.modelVersion && proof?.device === 'cuda' &&
      proof.fingerprint === nativeDiarizationFingerprint(pythonPath, root))
  } catch { return false }
}
export function runNativeDiarization(audio, options) {
  if (options.model !== NATIVE_DIARIZATION_MODEL) throw new Error('Unsupported native diarization model')
  return runDiarization(audio, { ...options, parseOutput: parseWorkerOutput,
    workerArgs: path => [join(here, 'nemotron_diarization_worker.py'), '--audio', path,
      '--model', options.model, '--model-dir', join(options.hostRoot, 'models', 'nemotron-3-diarization-gguf'),
      '--runtime-dir', join(options.hostRoot, 'runtime', 'asr-nemotron'),
      '--worker-dir', dirname(options.workerPath)] })
}
