/**
 * Duration gate — the free half of value classification (2026-09-22).
 *
 * A leaf module on purpose: database.ts and value-classification.ts both need
 * these numbers, and value-classification.ts imports database.ts, so anything
 * shared between them has to live below both. Nothing here touches the
 * database, the network, or config; it is arithmetic over a duration, a file
 * size and a word count.
 *
 * Why it exists. The LLM rubric in value-classification.ts judges CONTENT,
 * which is the right call for anything long enough to hold content. It is the
 * wrong tool for a ten-second clip: judging one costs a provider call, and a
 * short clip that never got that call simply stayed `unrated` forever.
 * Measured against the owner's real database on 2026-09-22: of 122 live
 * recordings under 60 seconds, 111 were `unrated` with no quality_source at
 * all and exactly ONE had been rated by the model. He hand-deleted 30+ of the
 * shortest ones himself.
 *
 * Duration decides the bottom end. No transcript is read, no model is called:
 * below these lengths the recording cannot hold lasting knowledge whatever
 * words a transcriber put in it.
 *
 * With one cross-check, because the column it reads is not always a
 * measurement: when the file is too big to hold that many seconds of audio,
 * the duration is understated and the gate refuses to judge at all. See
 * MAX_PLAUSIBLE_BYTES_PER_SECOND.
 */

import type { ValueClassification } from './value-classification'

/** Under 10 seconds => `none` => 'garbage'.
 *  Ten seconds does not fit one complete exchange — a question and its answer
 *  — so there is nothing to retrieve later. This is also where the device's
 *  own accidents land: a mis-pressed record button, a clip cut off at the
 *  start of a session. In the measured DB only 2 recordings sit below 10s
 *  today, because the owner already deleted the rest by hand. */
export const DURATION_GARBAGE_MAX_SECONDS = 10

/** 10 to 30 seconds => `low` => 'low-value'.
 *  A sub-30s clip is a single utterance: a greeting, a "can you hear me?", a
 *  one-line aside. 71 of the measured 122 short recordings fall in the 5-30s
 *  band and the owner calls them worthless. 'low-value' is the reversible
 *  rating (the Library can re-rate, and a user rating always wins), which is
 *  why this band gets it rather than 'garbage'.
 *
 *  30 seconds is where the gate STOPS. The 30-60s band (50 recordings) can
 *  hold a real short voice memo — "the client agreed to the July date" — so
 *  that stays a content judgement for the model, not a stopwatch decision. */
export const DURATION_LOW_VALUE_MAX_SECONDS = 30

/** Bytes per second above which a file holds more audio than its stored
 *  duration admits, which makes the duration wrong rather than the recording
 *  short.
 *
 *  `recordings.duration_seconds` is not always a measurement.
 *  backfillRecordingDurations falls back to the transcript's last segment end
 *  when the device cache has no duration, and its own comment calls that "a
 *  lower bound". In the owner's DB that fallback is not the exception, it is
 *  the rule: the device cache holds ZERO durations, and 67 of the 70 short
 *  recordings with segment timings have duration_seconds equal to their last
 *  segment end to within a second. A transcription that stopped early
 *  therefore writes a short duration onto a long recording.
 *
 *  File size is the independent witness. Measured over every recording of two
 *  minutes or more, bytes per second maxes out at 60,655 (.wav), 33,968
 *  (.flac), 13,694 (.hda) and 6,172 (.mp3); the dominant device rate is a flat
 *  8,000. 64,000 sits just above the highest of those and eight times the
 *  device rate, so `file_size / 64000 > duration_seconds` means no format this
 *  app has ever produced could fit that file into that many seconds.
 *
 *  The blind spot, stated plainly: at eight times the usual rate this catches
 *  a duration understated by roughly 8x or more. A 60-second recording
 *  truncated to 20 slips through. It catches the shape that actually occurs —
 *  a multi-minute recording truncated to seconds — and it never blocks a
 *  genuinely short clip, because a short clip's file is small. */
export const MAX_PLAUSIBLE_BYTES_PER_SECOND = 64000

/** True when the file is too big to hold only `durationSeconds` of audio, so
 *  the duration is understated and cannot be used to judge the recording.
 *  False when either number is missing: an unknown file size is not evidence
 *  of anything, and refusing to judge on its absence would silently disable
 *  the gate. (Every short candidate in the owner's DB has a file size, so
 *  that branch is defensive, not routine.) */
export function isDurationContradictedByFileSize(
  fileSizeBytes: number | null | undefined,
  durationSeconds: number | null | undefined
): boolean {
  if (!fileSizeBytes || fileSizeBytes <= 0) return false
  if (!durationSeconds || durationSeconds <= 0) return false
  // Multiplication, not division: SQLite does integer division, and the
  // sweep runs the same comparison in SQL. Keeping both sides in the same
  // form keeps the two answers identical on a borderline row.
  return fileSizeBytes > durationSeconds * MAX_PLAUSIBLE_BYTES_PER_SECOND
}

/** Words per second above which a transcript is not physically speakable and
 *  therefore is not evidence of anything.
 *
 *  Measured over the 1,931 transcribed recordings in the owner's DB: median
 *  2.47 wps, p95 5.44, p99 9.31, max 87.5. Fast sustained human speech tops
 *  out near 5 wps (300 wpm); 8 wps (480 wpm) is roughly double that and sits
 *  above the 95th percentile of real recordings.
 *
 *  An impossible density means ONE of two things, and the number alone cannot
 *  say which: the transcript was invented, or the duration is understated.
 *  Checking the 33 impossible rows against file size settles 4 of them
 *  outright — the clip storing 508 words in a "13-second" recording holds
 *  2.24 MB, which is 280 seconds of device audio, so that transcript is
 *  ordinary speech (1.8 wps) wearing a broken duration.
 *
 *  So this is used ONLY to strip a transcript of its evidentiary weight,
 *  never on its own to downgrade. Marking a row low-value on density alone
 *  would punish a bookkeeping gap. */
export const IMPOSSIBLE_WORDS_PER_SECOND = 8

/** True when `wordCount` words cannot have been spoken in `durationSeconds`
 *  seconds. False when either input is missing or non-positive — an unknown
 *  duration is not an accusation. */
export function isImpossibleTranscriptDensity(
  wordCount: number | null | undefined,
  durationSeconds: number | null | undefined
): boolean {
  if (!wordCount || wordCount <= 0) return false
  if (!durationSeconds || durationSeconds <= 0) return false
  return wordCount / durationSeconds > IMPOSSIBLE_WORDS_PER_SECOND
}

/**
 * Decide a capture's value from its recording's duration — no transcript, no
 * provider call, no cost. Returns null when the duration is unknown,
 * non-positive, contradicted by the file size, or long enough that only the
 * content can decide; the caller then falls through to the model as before.
 *
 * `fileSizeBytes` is required rather than optional on purpose. The duration
 * column is a lower bound on several paths, so every caller has to hand over
 * the witness that can contradict it; an optional parameter would let a new
 * call site silently opt out of the check.
 *
 * Confidence is deliberately 1.0 / 0.95: a stopwatch is not guessing, and
 * these must clear transcription.valueClassificationMinConfidence (0.6) in
 * applyCaptureValueClassification, which is a floor on MODEL confidence.
 *
 * A calendar meeting link does NOT exempt a recording here. The link says a
 * meeting existed at that hour, not that this 12-second fragment recorded it;
 * 12 of the measured 39 recordings in the 10-20s band are meeting-linked and
 * are exactly as empty as the rest.
 */
export function classifyByDuration(
  durationSeconds: number | null | undefined,
  fileSizeBytes: number | null | undefined
): ValueClassification | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null
  }
  // The file is bigger than this many seconds of audio can be: the duration
  // is understated, not the recording short. Judging it here would rate a
  // multi-minute meeting garbage because its transcription stopped early.
  if (isDurationContradictedByFileSize(fileSizeBytes, durationSeconds)) {
    return null
  }
  if (durationSeconds < DURATION_GARBAGE_MAX_SECONDS) {
    return { value: 'none', reasons: ['no_substance'], confidence: 1 }
  }
  if (durationSeconds < DURATION_LOW_VALUE_MAX_SECONDS) {
    return { value: 'low', reasons: ['no_substance'], confidence: 0.95 }
  }
  return null
}
