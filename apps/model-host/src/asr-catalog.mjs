/** Explicit engines; availability still requires a successful host-side audio test. */
export const ONNX_ASR = {
  'nvidia/parakeet-tdt-0.6b-v3': {
    directory: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    exitCode: 78,
  },
  'Qwen/Qwen3-ASR-0.6B': {
    directory: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
    exitCode: 79,
  },
}
export const PHOTON_ASR = {
  'moondream/parakeet-ultra': { directory: 'photon-parakeet-ultra', exitCode: 80 },
  'Qwen/Qwen3-ASR-1.7B': { directory: 'photon-qwen3-asr-1.7b', exitCode: 81 },
}
export const NATIVE_ASR = {
  'nvidia/nemotron-3.5-asr-streaming-0.6b': { directory: 'nemotron-3.5-asr-streaming-0.6b-gguf', exitCode: 82 },
}
export const MOSS_ASR = { 'OpenMOSS-Team/MOSS-Transcribe-Diarize': { directory: 'moss-transcribe-diarize', exitCode: 83 } }
export const AUDIO8_ASR = { 'Edge0/Audio8-ASR-Infinite': { directory: 'audio8-asr-infinite', exitCode: 85 } }
export const ASR_MODELS = new Set([
  'CohereLabs/cohere-transcribe-03-2026', 'microsoft/VibeVoice-ASR', ...Object.keys(ONNX_ASR), ...Object.keys(PHOTON_ASR), ...Object.keys(NATIVE_ASR), ...Object.keys(MOSS_ASR), ...Object.keys(AUDIO8_ASR),
])
