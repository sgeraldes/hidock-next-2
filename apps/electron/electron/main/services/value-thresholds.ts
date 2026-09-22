/**
 * Duration gate — the free half of value classification (2026-09-22).
 *
 * A leaf module on purpose: database.ts and value-classification.ts both need
 * these numbers, and value-classification.ts imports database.ts, so anything
 * shared between them has to live below both. Nothing here touches the
 * database, the network, or config; it is arithmetic over a duration and a
 * word count.
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
 * Duration alone decides the bottom end. No transcript is read, no model is
 * called: below these lengths the recording cannot hold lasting knowledge
 * whatever words a transcriber put in it.
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

/** Words per second above which a transcript is not physically speakable and
 *  therefore is not evidence of anything.
 *
 *  Measured over the 1,931 transcribed recordings in the owner's DB: median
 *  2.47 wps, p95 5.44, p99 9.31, max 87.5. Fast sustained human speech tops
 *  out near 5 wps (300 wpm); 8 wps (480 wpm) is roughly double that and sits
 *  above the 95th percentile of real recordings. One 13-second clip carries a
 *  508-word transcript — 39 wps — a hallucinated transcript nothing rejected.
 *
 *  Used ONLY to strip a transcript of its evidentiary weight, never on its
 *  own to downgrade: recordings.duration_seconds is sometimes a LOWER BOUND
 *  recovered from the last transcript segment end (see
 *  backfillRecordingDurations), so a high density on a long recording can
 *  mean an understated duration rather than a hallucination. Marking those
 *  low-value on density alone would punish a bookkeeping gap. */
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
 * Decide a capture's value from its recording's duration alone — no
 * transcript, no provider call, no cost. Returns null when the duration is
 * unknown, non-positive, or long enough that only the content can decide;
 * the caller then falls through to the model as before.
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
export function classifyByDuration(durationSeconds: number | null | undefined): ValueClassification | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
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
