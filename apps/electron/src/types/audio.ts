/**
 * Renderer view of the audio check (electron/main/ipc/audio-check-handlers.ts).
 * Spec: docs/superpowers/specs/2026-09-24-recording-checks-design.md
 */

export interface AudioCheckResult {
  category: 'too_short' | 'silent' | 'noise' | 'speech'
  durationSeconds: number
  soundSeconds: number
  soundShare: number
  longestSoundSeconds: number
  spikeCount: number
  ranges: { start: number; end: number }[]
  /** Captures rated "no value" by this check. */
  capturesRated: number
}
