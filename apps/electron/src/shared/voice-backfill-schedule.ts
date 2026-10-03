/**
 * When voice evidence is computed for recordings transcribed before voices were measured
 * (spec 2026-10-03, section 1b). Shared by the config defaults, the main-process service and
 * Settings > Speakers & voices.
 */

export type VoiceBackfillSchedule = 'night' | 'background' | 'off'

export interface VoiceBackfillConfig {
  schedule: VoiceBackfillSchedule
  /** Local time "HH:MM" the night window opens. */
  windowStart: string
  /** Local time "HH:MM" it closes; earlier than windowStart means it crosses midnight. */
  windowEnd: string
}

/** One recording run now and timed ("Measure one recording"). */
export interface VoiceBackfillMeasure {
  recordingId: string
  /** Wall time of the voice step, in seconds. */
  seconds: number
  /** Length of the recording's audio, in seconds. */
  audioSeconds: number
  /** Where it ran, as the worker reported it (cpu, cuda, dml...). */
  device: string | null
}

export interface VoiceBackfillStatus {
  schedule: VoiceBackfillSchedule
  window: { start: string; end: string }
  /** Transcribed recordings in the library (not in Trash, not personal). */
  total: number
  /** Recordings with voice evidence, from transcription or from the backfill. */
  done: number
  /** Recordings where no voice spoke long enough to be measured. */
  skipped: number
  failed: number
  remaining: number
  /** Audio still to measure, for the estimate in Settings. */
  remainingAudioSeconds: number
  lastRunAt: string | null
  lastError: string | null
  running: boolean
  lastMeasure: VoiceBackfillMeasure | null
}

/** At night by default, 01:00 to 07:00 (owner, 3-oct-2026). */
export const DEFAULT_VOICE_BACKFILL: VoiceBackfillConfig = {
  schedule: 'night',
  windowStart: '01:00',
  windowEnd: '07:00'
}
