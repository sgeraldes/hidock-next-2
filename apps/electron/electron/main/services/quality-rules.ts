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

export const DEFAULT_MIN_RECORDING_SECONDS = 10

let minSeconds = DEFAULT_MIN_RECORDING_SECONDS

export interface QualityConfig {
  /** Audio-versus-transcript warning (jev-evaluation.ts WARNING_RULES). */
  quietSoundShare: number
  quietMinDurationSeconds: number
  meaningfulWords: number
  meaningfulStars: number
  maxWordsPerMinuteOfRecording: number
  busySoundSeconds: number
  minWordsPerMinuteOfSound: number
  /** Jev's "invented" probability at or above this is a warning (Library). */
  inventedProbability: number
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
  meaningfulStars: 3,
  maxWordsPerMinuteOfRecording: 250,
  busySoundSeconds: 300,
  minWordsPerMinuteOfSound: 20,
  inventedProbability: 0.8,
  reasonProbability: 0.5,
  lowValueMaxSeconds: 30,
  maxRetries: 3,
  retranscribeScore: 60,
  meetingAutoLinkProbability: 0.7,
  meetingAutoLinkMargin: 0.25,
  liveSilenceRms: 58
})

/** Allowed range per key; `integer` rounds the value. Out of range is clamped; a non-number falls back to the default. */
export const QUALITY_BOUNDS: Readonly<Record<QualityKey, { min: number; max: number; integer?: boolean }>> = Object.freeze({
  quietSoundShare: { min: 0, max: 1 },
  quietMinDurationSeconds: { min: 0, max: 3600, integer: true },
  meaningfulWords: { min: 1, max: 10000, integer: true },
  meaningfulStars: { min: 1, max: 5, integer: true },
  maxWordsPerMinuteOfRecording: { min: 50, max: 2000, integer: true },
  busySoundSeconds: { min: 10, max: 7200, integer: true },
  minWordsPerMinuteOfSound: { min: 0, max: 300, integer: true },
  inventedProbability: { min: 0, max: 1 },
  reasonProbability: { min: 0, max: 1 },
  lowValueMaxSeconds: { min: 0, max: 600, integer: true },
  maxRetries: { min: 0, max: 10, integer: true },
  retranscribeScore: { min: 0, max: 100, integer: true },
  meetingAutoLinkProbability: { min: 0, max: 1 },
  meetingAutoLinkMargin: { min: 0, max: 1 },
  liveSilenceRms: { min: 0, max: 2000, integer: true }
})

/** The keys whose change alters the stored audio-versus-transcript warnings. */
export const WARNING_RULE_KEYS: readonly QualityKey[] = [
  'quietSoundShare',
  'quietMinDurationSeconds',
  'meaningfulWords',
  'meaningfulStars',
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

let rules: QualityConfig = { ...DEFAULT_QUALITY_RULES }

export function applyQualityRules(config: {
  transcription?: { minRecordingSeconds?: unknown }
  quality?: unknown
}): void {
  const v = config.transcription?.minRecordingSeconds
  minSeconds = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600 ? v : DEFAULT_MIN_RECORDING_SECONDS
  rules = resolveQualityRules(config.quality)
}

/** Clips shorter than this are not transcribed and are rated no-value. */
export function minRecordingSeconds(): number {
  return minSeconds
}

/** The quality thresholds in force now (a copy; validated and clamped). */
export function qualityRules(): QualityConfig {
  return { ...rules }
}

/** Keys whose value differs between two resolved rule sets. */
export function changedQualityKeys(prev: QualityConfig, next: QualityConfig): QualityKey[] {
  return (Object.keys(DEFAULT_QUALITY_RULES) as QualityKey[]).filter((k) => prev[k] !== next[k])
}
