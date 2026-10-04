/**
 * Quality rules a person can change in Settings. Pure module (like
 * rag-settings.ts): config.ts refreshes it on every load and save, and every
 * service that judges a recording reads it here, so none of them imports the
 * config.
 *
 * minRecordingSeconds (Settings > Transcription > Pipeline) merges two
 * constants that said the same thing (value-thresholds
 * DURATION_GARBAGE_MAX_SECONDS and audio-profile TOO_SHORT_SECONDS, both 10;
 * settings map B-1). The owner kept 10 as the default (28-sep-2026).
 *
 * The `quality` config section (Settings > Quality checks, 28-sep-2026) holds
 * the thresholds that used to be hardcoded constants. DEFAULT_QUALITY_RULES
 * keeps their values; the old constant names now point here, so a doc or a
 * test that names one still reads the default.
 */

import { QUALITY_BOUNDS } from '../../../src/shared/quality-bounds'

export const DEFAULT_MIN_RECORDING_SECONDS = 10

let minSeconds = DEFAULT_MIN_RECORDING_SECONDS

export interface QualityConfig {
  /** Audio-versus-transcript warning (jev-evaluation.ts WARNING_RULES). */
  quietSoundShare: number
  quietMinDurationSeconds: number
  meaningfulWords: number
  maxWordsPerMinuteOfRecording: number
  busySoundSeconds: number
  minWordsPerMinuteOfSound: number
  /** A reason tag is attached when Jev's probability is at or above this. */
  reasonProbability: number
  /** Clips shorter than this are rated low-value by duration alone. */
  lowValueMaxSeconds: number
  /** Transcription attempts before a recording is marked failed. */
  maxRetries: number
  /** Importance score at or above which a transcript is recommended for re-transcription. */
  retranscribeScore: number
  /** A meeting is linked by content only when Jev is this sure... */
  meetingAutoLinkProbability: number
  /** ...and this far ahead of the second-best meeting. */
  meetingAutoLinkMargin: number
  /** Live transcription: a channel whose level stays under this RMS is not sent. */
  liveSilenceRms: number
}

export type QualityKey = keyof QualityConfig

export const DEFAULT_QUALITY_RULES: Readonly<QualityConfig> = Object.freeze({
  quietSoundShare: 0.05,
  quietMinDurationSeconds: 60,
  meaningfulWords: 100,
  maxWordsPerMinuteOfRecording: 250,
  busySoundSeconds: 300,
  minWordsPerMinuteOfSound: 20,
  reasonProbability: 0.5,
  lowValueMaxSeconds: 30,
  maxRetries: 3,
  retranscribeScore: 60,
  meetingAutoLinkProbability: 0.7,
  meetingAutoLinkMargin: 0.25,
  liveSilenceRms: 58
})

/** Allowed range per key (src/shared/quality-bounds.ts, shared with the Settings page). */
export { QUALITY_BOUNDS }

/** The keys whose change alters the stored audio-versus-transcript warnings. */
export const WARNING_RULE_KEYS: readonly QualityKey[] = [
  'quietSoundShare',
  'quietMinDurationSeconds',
  'meaningfulWords',
  'maxWordsPerMinuteOfRecording',
  'busySoundSeconds',
  'minWordsPerMinuteOfSound'
]

/** Validate a saved `quality` section: every key is a finite number clamped to its bounds, or its default. */
export function resolveQualityRules(saved: unknown): QualityConfig {
  const source = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {}
  const out = { ...DEFAULT_QUALITY_RULES } as QualityConfig
  for (const key of Object.keys(DEFAULT_QUALITY_RULES) as QualityKey[]) {
    const v = source[key]
    const { min, max, integer } = QUALITY_BOUNDS[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const value = integer ? Math.round(v) : v
    out[key] = Math.min(max, Math.max(min, value))
  }
  return out
}

let rules: Readonly<QualityConfig> = DEFAULT_QUALITY_RULES

export function applyQualityRules(config: {
  transcription?: { minRecordingSeconds?: unknown }
  quality?: unknown
}): void {
  const v = config.transcription?.minRecordingSeconds
  minSeconds = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600 ? v : DEFAULT_MIN_RECORDING_SECONDS
  rules = Object.freeze(resolveQualityRules(config.quality))
}

/** Clips shorter than this are not transcribed and are rated no-value. */
export function minRecordingSeconds(): number {
  return minSeconds
}

/** The quality thresholds in force now (validated, clamped, frozen: read per audio packet, so no copy). */
export function qualityRules(): Readonly<QualityConfig> {
  return rules
}

/** Keys whose value differs between two resolved rule sets. */
export function changedQualityKeys(prev: QualityConfig, next: QualityConfig): QualityKey[] {
  return (Object.keys(DEFAULT_QUALITY_RULES) as QualityKey[]).filter((k) => prev[k] !== next[k])
}
