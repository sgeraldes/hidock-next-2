/**
 * The allowed range of each Settings > Quality checks value (28-sep-2026).
 * One table for both sides: the main process clamps every saved value to it
 * (electron/main/services/quality-rules.ts) and the page offers the same limits
 * (src/features/settings/quality-settings.ts). `integer` rounds the value.
 */
interface Bound {
  min: number
  max: number
  integer?: boolean
}

export const QUALITY_BOUNDS = Object.freeze({
  quietSoundShare: { min: 0, max: 1 } as Bound,
  quietMinDurationSeconds: { min: 0, max: 3600, integer: true } as Bound,
  meaningfulWords: { min: 1, max: 10000, integer: true } as Bound,
  // 1 star is every rated recording: at least 2 keeps "meaningful" meaningful.
  meaningfulStars: { min: 2, max: 5, integer: true } as Bound,
  maxWordsPerMinuteOfRecording: { min: 50, max: 2000, integer: true } as Bound,
  busySoundSeconds: { min: 10, max: 7200, integer: true } as Bound,
  minWordsPerMinuteOfSound: { min: 0, max: 300, integer: true } as Bound,
  // At 0 every recording, rated or not, would match.
  inventedProbability: { min: 0.05, max: 1 } as Bound,
  reasonProbability: { min: 0.05, max: 1 } as Bound,
  lowValueMaxSeconds: { min: 0, max: 600, integer: true } as Bound,
  maxRetries: { min: 0, max: 10, integer: true } as Bound,
  retranscribeScore: { min: 0, max: 100, integer: true } as Bound,
  // At 0/0 any answer, however unsure, would link a meeting.
  meetingAutoLinkProbability: { min: 0.3, max: 1 } as Bound,
  meetingAutoLinkMargin: { min: 0.01, max: 1 } as Bound,
  liveSilenceRms: { min: 0, max: 2000, integer: true } as Bound
})

export type QualityBoundKey = keyof typeof QUALITY_BOUNDS
