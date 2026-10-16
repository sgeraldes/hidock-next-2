/** Preparation choices are not readiness: the worker must advertise a real test. */
export const REMOTE_ASR_MODELS = [
  'CohereLabs/cohere-transcribe-03-2026', 'microsoft/VibeVoice-ASR',
  'nvidia/parakeet-tdt-0.6b-v3', 'Qwen/Qwen3-ASR-0.6B', 'moondream/parakeet-ultra', 'Qwen/Qwen3-ASR-1.7B',
  'nvidia/nemotron-3.5-asr-streaming-0.6b', 'OpenMOSS-Team/MOSS-Transcribe-Diarize', 'Edge0/Audio8-ASR-Infinite'
] as const
export const REMOTE_ASR_LABELS: Record<(typeof REMOTE_ASR_MODELS)[number], string> = {
  'CohereLabs/cohere-transcribe-03-2026': 'Cohere Transcribe',
  'microsoft/VibeVoice-ASR': 'VibeVoice ASR',
  'nvidia/parakeet-tdt-0.6b-v3': 'Parakeet TDT v3 · ONNX INT8 / CPU',
  'Qwen/Qwen3-ASR-0.6B': 'Qwen3-ASR 0.6B · ONNX INT8 / CPU',
  'moondream/parakeet-ultra': 'Parakeet Ultra · Photon / CUDA',
  'Qwen/Qwen3-ASR-1.7B': 'Qwen3-ASR 1.7B · Photon / CUDA',
  'nvidia/nemotron-3.5-asr-streaming-0.6b': 'Nemotron 3.5 ASR · NeMo-Speech.cpp / CUDA',
  'OpenMOSS-Team/MOSS-Transcribe-Diarize': 'MOSS Transcribe Diarize · SDPA / CUDA',
  'Edge0/Audio8-ASR-Infinite': 'Audio8 ASR Infinite · English / Chinese · CUDA'
}
