/**
 * Quality rules a person can change in Settings > Transcription > Pipeline.
 * Pure module (like rag-settings.ts): config.ts refreshes it on every load and
 * save, and the transcription gate, the audio profile and value classification
 * read it here, so none of them imports the config.
 *
 * minRecordingSeconds merges two constants that said the same thing
 * (value-thresholds DURATION_GARBAGE_MAX_SECONDS and audio-profile
 * TOO_SHORT_SECONDS, both 10; settings map B-1). The owner kept 10 as the
 * default (28-sep-2026).
 */

export const DEFAULT_MIN_RECORDING_SECONDS = 10

let minSeconds = DEFAULT_MIN_RECORDING_SECONDS

export function applyQualityRules(config: { transcription?: { minRecordingSeconds?: unknown } }): void {
  const v = config.transcription?.minRecordingSeconds
  minSeconds = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600 ? v : DEFAULT_MIN_RECORDING_SECONDS
}

/** Clips shorter than this are not transcribed and are rated no-value. */
export function minRecordingSeconds(): number {
  return minSeconds
}
