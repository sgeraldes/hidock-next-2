/**
 * The engine chain as Settings and the recording panel see it (16-oct-2026).
 * Entries are stored as text in config.transcription.engineChain:
 * 'configured', 'gemini', 'remote:<model>' or 'local:<model>'.
 */

import { REMOTE_ASR_LABELS, REMOTE_ASR_MODELS } from './asr-models'

/** The measured default (plan 2026-10-16, phase C): the service chosen in Settings, then Parakeet Ultra, then Qwen 1.7B. */
export const DEFAULT_ENGINE_CHAIN_ENTRIES = ['configured', 'remote:moondream/parakeet-ultra', 'remote:Qwen/Qwen3-ASR-1.7B']

export interface EngineOption {
  value: string
  label: string
}

/** Every engine Settings offers. Cohere stays available but last: the owner rates it the worst (15-oct-2026). */
export const ENGINE_OPTIONS: EngineOption[] = [
  { value: 'configured', label: 'Default service (Pipeline)' },
  { value: 'gemini', label: 'Gemini · cloud' },
  ...REMOTE_ASR_MODELS.filter((model) => model !== 'CohereLabs/cohere-transcribe-03-2026')
    .map((model) => ({ value: `remote:${model}`, label: `${REMOTE_ASR_LABELS[model]} · Model Host` })),
  { value: 'local:microsoft/VibeVoice-ASR', label: 'VibeVoice ASR · this computer' },
  { value: 'remote:CohereLabs/cohere-transcribe-03-2026', label: `${REMOTE_ASR_LABELS['CohereLabs/cohere-transcribe-03-2026']} · Model Host` },
  { value: 'local:CohereLabs/cohere-transcribe-03-2026', label: 'Cohere Transcribe · this computer' },
]

export function engineOptionLabel(value: string): string {
  return ENGINE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

export interface EngineAvailability {
  entry: string
  label: string
  /** Null when it can be tried now. */
  unavailableReason: string | null
}

/** Error classes the retry policy counts, in the order Settings lists them. */
export const RETRYABLE_ERROR_CLASSES = [
  { id: 'transient', label: 'Network, timeout or server error' },
  { id: 'quota', label: 'Rate limit or quota (waits as long as the provider asks)' },
  { id: 'unknown', label: 'Unrecognised error' },
] as const

export const DEFAULT_ENGINE_RETRIES: Record<(typeof RETRYABLE_ERROR_CLASSES)[number]['id'], number> = {
  transient: 2,
  quota: 3,
  // An unclassified error is likelier a bug than a blip: the next engine is the better bet.
  unknown: 0,
}

export interface TranscriptionAttemptView {
  engine: string
  attempt: number
  outcome: 'succeeded' | 'failed' | 'skipped-unavailable'
  errorClass?: string
  message?: string
  startedAt: string
  durationMs: number
  waitedSeconds: number
}
