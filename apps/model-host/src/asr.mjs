import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { AUDIO8_MEMORY_PROFILE, runDiarization } from './diarize.mjs'
import { hostRoot } from './config.mjs'
import { ASR_MODELS, ONNX_ASR, PHOTON_ASR, NATIVE_ASR, MOSS_ASR, AUDIO8_ASR } from './asr-catalog.mjs'
import { channelRequest, runSeparateChannels } from './asr-channels.mjs'

export { ASR_MODELS }

export function parseAsrOutput(stdout) {
  const result = JSON.parse(stdout)
  if (!ASR_MODELS.has(result.model) || typeof result.modelVersion !== 'string' ||
      typeof result.text !== 'string' || !Array.isArray(result.segments) ||
      !result.segments.every(s => Number.isFinite(s.start) && Number.isFinite(s.end) &&
        s.start >= 0 && s.end > s.start && typeof s.text === 'string' && typeof s.speaker === 'string')) {
    throw new Error('ASR worker returned an incomplete result')
  }
  return result
}

/** Same process budget, timeout, cancellation and output cap as diarization. */
export function runAsr(audio, options) {
  const channels = channelRequest(options)
  if (channels.channelMode === 'separate') return runSeparateChannels(audio, { ...options, ...channels }, runAsr)
  if (!ASR_MODELS.has(options.model)) throw new Error('Unsupported ASR model')
  const onnx = ONNX_ASR[options.model]
  const photon = PHOTON_ASR[options.model]
  const native = NATIVE_ASR[options.model]
  const moss = MOSS_ASR[options.model]
  const audio8 = AUDIO8_ASR[options.model]
  if (audio8 && !['en', 'zh'].includes(String(options.language || '').toLowerCase().replace('_', '-').split('-')[0])) {
    throw new Error('Audio8 Infinite requires explicit English (en) or Chinese (zh); Spanish/auto unsupported')
  }
  const root = options.hostRoot || hostRoot()
  const worker = join(dirname(fileURLToPath(import.meta.url)), audio8 ? 'audio8_asr_worker.py' : moss ? 'moss_asr_worker.py' : native ? 'nemotron_asr_worker.py' : photon ? 'photon_asr_worker.py' : onnx ? 'parakeet_worker.py' : 'asr_worker.py')
  return runDiarization(audio, { ...options,
    memoryProfile: audio8 ? AUDIO8_MEMORY_PROFILE : undefined,
    workerArgs: path => [worker, '--audio', path, '--model', options.model,
      '--language', options.language || 'es', '--worker-dir', dirname(options.workerPath),
      ...(audio8 ? ['--model-dir', join(root, 'models', audio8.directory), '--site-dir', join(root, 'runtime', 'asr-audio8', 'site')] : []),
      ...(moss ? ['--model-dir', join(root, 'models', moss.directory), '--site-dir', join(root, 'runtime', 'asr-moss', 'site')] : []),
      ...(native ? ['--model-dir', join(root, 'models', native.directory),
        '--runtime-dir', join(root, 'runtime', 'asr-nemotron')] : []),
      ...(onnx ? ['--model-dir', join(root, 'models', onnx.directory), '--provider', 'cpu',
        '--site-dir', join(root, 'runtime', 'asr-onnx', 'site')] : []),
      ...(photon ? ['--model-dir', join(root, 'models', photon.directory),
        '--site-dir', join(root, 'runtime', 'asr-photon', 'site')] : [])],
    parseOutput: parseAsrOutput })
}
