/**
 * Whether a transcript can be used at all, decided before anything reads its
 * content to categorize, summarize or name people.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md
 *
 * Owner, 4-oct-2026: "an LLM cannot tell invented text". Invention is shown by
 * peak-level detection: transcription where there is no audio is invented. The
 * checks here are deterministic and read only the audio envelope and the
 * transcript's own lines:
 *  - text over frames with no audio, measured against this recording's own
 *    floor (5th percentile of the per-frame MP3 gain), never only against the
 *    fixed loudness line, so soft speech counts as audio;
 *  - text that cannot be placed in time (a line faster than anyone speaks, or
 *    one with no duration): a timing doubt, never counted as "no audio";
 *  - timestamps that are consistently wrong (repeated or backwards starts);
 *  - more speakers than the calendar invited;
 *  - a transcript that ends long before the audio, judged by what follows: no
 *    audio after it is fine, speech after it with sparse text means content is
 *    missing, dense text suggests the clock was compressed and needs sampling.
 *
 * Outcomes: 'audio' (silent, noise only or too short: the audio decides, no
 * transcript needed), 'invalid', 'incomplete', 'doubtful' and 'valid'. Only a
 * valid transcript is categorized; a doubtful one is resolved by transcribing a
 * sample of its audio and comparing meaning.
 */

import { FRAME_SECONDS, LOUD_DB, LOUD_GAIN } from './audio-profile'

/** Bumped when a rule changes, so stored verdicts are recomputed. */
export const VALIDITY_VERSION = 5

export type ValidityStatus = 'audio' | 'invalid' | 'incomplete' | 'doubtful' | 'valid'

export type ValidityReasonCode =
  | 'integrity'
  | 'text_without_audio'
  | 'much_text_without_audio'
  | 'text_not_placeable_in_time'
  | 'timestamps_consistently_wrong'
  | 'more_speakers_than_invited'
  | 'more_words_than_audio'
  | 'speech_after_the_end'
  | 'clock_compressed'
  | 'audio_after_the_end'
  | 'no_times'
  | 'audio_not_checked'
  | 'sample_contradicts'
  | 'sparse_speech'
  | 'uncovered_speech'
  | 'sparse_long_segment'

export interface ValidityReason {
  code: ValidityReasonCode
  /** One sentence the owner can read. */
  detail: string
}

export interface TranscriptValidity {
  version: number
  status: ValidityStatus
  reasons: ValidityReason[]
  /** The numbers behind the verdict, kept for the Library and for sampling. */
  measures: {
    words: number
    /** Words per minute of sound detected in the envelope. */
    wordsPerSoundMinute: number | null
    silentShare: number | null
    unplaceableShare: number | null
    timingErrorShare: number | null
    speakers: number
    attendees: number
    /** Seconds of audio after the transcript's end, on the real timeline. */
    audioAfterEndSeconds: number | null
    /** Where the transcript ends, on the real timeline. */
    endSeconds: number | null
    fileSeconds: number | null
    /** Factor applied to the line times (4 for an old WAV whose header lied). */
    timeFactor: number
    detectedSpeechSeconds?: number | null
    wordsPerSpeechMinute?: number | null
    uncoveredDiarizedSpeechShare?: number | null
    providerSeconds?: number | null
    providerTimeSuspicious?: boolean
  }
}

export interface ValiditySegment {
  speaker?: string | null
  start?: number | null
  end?: number | null
  text?: string | null
}

export interface ValidityInput {
  fileName: string
  segments: ValiditySegment[]
  fullText?: string | null
  storedWordCount?: number | null
  /** One level byte per frame (audio-profile-store envelope), or null when there is none. */
  envelope: Uint8Array | null
  /**
   * What the envelope bytes are: MP3 global gain ('gain', the device's files,
   * the default) or dBFS + 100 ('db', a decoded import such as an MP3 or FLAC).
   */
  envelopeUnit?: 'gain' | 'db'
  audioCategory: string | null
  /** Invitees of the linked meeting; 0 when unknown. */
  attendees: number
  integrityStatus: string | null
  /** The owner accepted this transcript as it is. */
  accepted: boolean
  /** A sample of this transcript's audio, transcribed again and compared (transcript-sampler.ts). */
  sample?: 'confirmed' | 'contradicted' | 'inconclusive' | 'incomplete' | null
  /** Independent acoustic turns, never the provider's transcript timestamps. */
  diarizedSegments?: Array<{ start: number; end: number }>
  vadSpeechSeconds?: number | null
  providerSeconds?: number | null
  durationSeconds?: number | null
}

/** Far below normal speech (120-160 wpm), with enough audio to avoid short-clip noise. */
export const MIN_COMPLETENESS_SPEECH_SECONDS = 120
export const MIN_WORDS_PER_SPEECH_MINUTE = 30
/** Missing most independent speech is a failure even when word count looks plausible. */
export const MAX_UNCOVERED_SPEECH_SHARE = 0.5
/** A three-minute line with less than one word per ten seconds cannot represent a speech turn. */
export const LONG_SEGMENT_SECONDS = 180
export const MIN_LONG_SEGMENT_WORDS_PER_SECOND = 0.1
/** Diagnostic only: fast cloud inference is possible; timing alone never rejects text. */
export const SUSPICIOUS_PROVIDER_AUDIO_RATIO = 0.01

export function mergeSpeechIntervals(intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = intervals.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)
    .map(s => ({ ...s })).sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push(s)
  }
  return merged
}

function clock(seconds: number): string {
  const n = Math.floor(seconds)
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

// Thresholds, measured on the owner's library on 4-oct-2026 (plan, "The deterministic checks").
/** Above floor plus this many gain steps (1.5 dB each) a frame has audio. */
export const FLOOR_MARGIN = 2
/** The same margin for a decoded envelope, whose bytes are dB: two gain steps. */
export const FLOOR_MARGIN_DB = 3
/** Words in a transcript before the text-versus-audio checks judge it. */
export const MIN_WORDS = 100
/** Placeable words needed for the "without audio" share to mean anything. */
export const MIN_PLACEABLE_WORDS = 50
export const INVALID_SILENT_SHARE = 0.9
export const DOUBT_SILENT_SHARE = 0.5
export const DOUBT_UNPLACEABLE_SHARE = 0.3
export const DOUBT_TIMING_SHARE = 0.2
export const MIN_LINES_FOR_TIMING = 10
/** Faster than this a line cannot hold its words (the library's limit, value-thresholds). */
export const MAX_WORDS_PER_SECOND = 8
/** A transcript ending before this share of a file this long is judged by what follows. */
export const EARLY_END_SHARE = 0.6
export const EARLY_END_MIN_FILE_SECONDS = 300
/** Audio after the end below this is not content. */
export const AFTER_END_MIN_AUDIO_SECONDS = 120
/** Above this many words per second of the stated span, the clock was compressed. */
export const COMPRESSED_SPAN_RATE = 4
/** Below this density, speech after an early end indicates missing text. */
export const MIN_WORDS_PER_SOUND_MINUTE = 90

/**
 * Whether a frame of the envelope holds audio: at least the recording's own
 * floor (5th percentile) plus a margin, or above the loudness line. Shared
 * with the sampler, which places its windows where there is audio.
 */
export function audioFrameTest(env: Uint8Array, unit: 'gain' | 'db' = 'gain'): (frame: number) => boolean {
  // Bytes have only 256 values: an exact histogram avoids sorting a copy of
  // every long envelope on the main thread during library backfill.
  const histogram = new Uint32Array(256)
  for (const value of env) histogram[value]++
  const rank = Math.floor(env.length * 0.05)
  let floor = 0
  let count = 0
  for (; floor < 255; floor++) {
    count += histogram[floor]
    if (count > rank) break
  }
  const decoded = unit === 'db'
  const margin = decoded ? FLOOR_MARGIN_DB : FLOOR_MARGIN
  const loud = decoded ? LOUD_DB + 100 : LOUD_GAIN
  return (f) => env[f] >= floor + margin || env[f] > loud
}

function countWords(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

function percent(n: number): string {
  return `${Math.round(n * 100)}%`
}

export function assessTranscriptValidity(input: ValidityInput): TranscriptValidity {
  const totalWords = input.segments.length ? input.segments.reduce((sum, s) => sum + countWords(s.text), 0)
    : countWords(input.fullText) || Math.max(0, input.storedWordCount ?? 0)
  const speakers = new Set(input.segments.map((s) => s.speaker).filter((s): s is string => !!s)).size
  const measures: TranscriptValidity['measures'] = {
    words: totalWords,
    wordsPerSoundMinute: null,
    silentShare: null,
    unplaceableShare: null,
    timingErrorShare: null,
    speakers,
    attendees: input.attendees,
    audioAfterEndSeconds: null,
    endSeconds: null,
    fileSeconds: null,
    timeFactor: 1
  }
  const result = (status: ValidityStatus, reasons: ValidityReason[]): TranscriptValidity => ({
    version: VALIDITY_VERSION,
    status,
    reasons,
    measures
  })

  if (input.audioCategory === 'silent' || input.audioCategory === 'noise' || input.audioCategory === 'too_short') {
    return result('audio', [])
  }
  if (input.accepted) return result('valid', [])
  const speech = mergeSpeechIntervals(input.diarizedSegments ?? [])
  const speechSeconds = speech.length ? speech.reduce((sum, s) => sum + s.end - s.start, 0)
    : typeof input.vadSpeechSeconds === 'number' && Number.isFinite(input.vadSpeechSeconds) ? Math.max(0, input.vadSpeechSeconds) : null
  measures.detectedSpeechSeconds = speechSeconds
  measures.wordsPerSpeechMinute = speechSeconds ? totalWords * 60 / speechSeconds : null
  measures.providerSeconds = input.providerSeconds ?? null
  measures.providerTimeSuspicious = typeof input.providerSeconds === 'number' && input.providerSeconds >= 0 &&
    !!input.durationSeconds && input.providerSeconds / input.durationSeconds < SUSPICIOUS_PROVIDER_AUDIO_RATIO
  const completenessReasons: ValidityReason[] = []
  if (speechSeconds !== null && speechSeconds >= MIN_COMPLETENESS_SPEECH_SECONDS &&
      totalWords * 60 / speechSeconds < MIN_WORDS_PER_SPEECH_MINUTE) {
    completenessReasons.push({ code: 'sparse_speech', detail: `${totalWords} words for ${(speechSeconds / 60).toFixed(1)} minutes of detected speech.` })
  }
  if (speech.length && speechSeconds && input.segments.some(s => typeof s.start === 'number' && typeof s.end === 'number')) {
    const coverage = mergeSpeechIntervals(input.segments.filter(s => countWords(s.text) > 0)
      .map(s => ({ start: s.start ?? NaN, end: s.end ?? NaN })))
    let covered = 0
    for (const s of speech) for (const t of coverage) covered += Math.max(0, Math.min(s.end, t.end) - Math.max(s.start, t.start))
    measures.uncoveredDiarizedSpeechShare = Math.max(0, 1 - covered / speechSeconds)
    if (measures.uncoveredDiarizedSpeechShare > MAX_UNCOVERED_SPEECH_SHARE) {
      const missing: Array<{ start: number; end: number }> = []
      for (const turn of speech) {
        let cursor = turn.start
        for (const text of coverage) {
          if (text.end <= cursor || text.start >= turn.end) continue
          if (text.start > cursor) missing.push({ start: cursor, end: Math.min(text.start, turn.end) })
          cursor = Math.max(cursor, Math.min(text.end, turn.end))
        }
        if (cursor < turn.end) missing.push({ start: cursor, end: turn.end })
      }
      const ranges = missing.map(s => `${clock(s.start)} to ${clock(s.end)}`).join(', ')
      completenessReasons.push({ code: 'uncovered_speech', detail: `${percent(measures.uncoveredDiarizedSpeechShare)} of detected speech has no transcript segment: ${ranges}.` })
    }
  }
  for (const s of input.segments) {
    if (typeof s.start !== 'number' || typeof s.end !== 'number') continue
    const duration = s.end - s.start
    const words = countWords(s.text)
    if (duration > LONG_SEGMENT_SECONDS && words / duration < MIN_LONG_SEGMENT_WORDS_PER_SECOND) {
      completenessReasons.push({ code: 'sparse_long_segment', detail: `${clock(s.start)} to ${clock(s.end)} has ${words} ${words === 1 ? 'word' : 'words'}.` })
    }
  }
  const invalidReasons: ValidityReason[] = []
  if (input.integrityStatus === 'broken') invalidReasons.push({ code: 'integrity', detail: 'The text does not fit this audio (integrity check).' })
  if (input.sample === 'contradicted') invalidReasons.push({ code: 'sample_contradicts', detail: 'A few minutes of the audio, transcribed again, tell a different conversation.' })
  if (input.sample === 'incomplete') completenessReasons.push({ code: 'speech_after_the_end', detail: 'Speech goes on after the transcript ends: a sample of the audio after it holds talk.' })
  // Independent checks accumulate. Invalid wins over incomplete, then doubt.
  const settle = (reasons: ValidityReason[]): TranscriptValidity => {
    const all = [...invalidReasons, ...completenessReasons, ...reasons]
    return result(invalidReasons.length ? 'invalid' : completenessReasons.length ? 'incomplete'
      : reasons.length && input.sample !== 'confirmed' ? 'doubtful' : 'valid', all)
  }
  const reasons: ValidityReason[] = []
  const timed = input.segments.filter((s) => typeof s.start === 'number' && Number.isFinite(s.start))

  if (input.attendees > 0 && speakers > input.attendees + 1) {
    reasons.push({ code: 'more_speakers_than_invited', detail: `${speakers} speakers in the transcript, ${input.attendees} people invited.` })
  }

  if (timed.length === 0) {
    if (totalWords >= MIN_WORDS) {
      reasons.push({ code: 'no_times', detail: 'The transcript has no times, so nothing can be checked against the audio.' })
    }
    return settle(reasons)
  }

  // Timing errors: starts repeated to the hundredth, or more than half a second before the previous one.
  let timingErrors = 0
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1].start as number
    const cur = timed[i].start as number
    if (Math.round(prev * 100) === Math.round(cur * 100) || cur < prev - 0.5) timingErrors++
  }
  measures.timingErrorShare = timed.length > 1 ? timingErrors / (timed.length - 1) : 0
  if (timed.length >= MIN_LINES_FOR_TIMING && measures.timingErrorShare >= DOUBT_TIMING_SHARE) {
    reasons.push({
      code: 'timestamps_consistently_wrong',
      detail: `${percent(measures.timingErrorShare)} of the lines start at a repeated or earlier time.`
    })
  }

  const env = input.envelope
  if (!env || env.length === 0) {
    // No envelope to check against: a long transcript is in doubt until
    // sampling confirms it, never passed as valid unchecked.
    if (totalWords >= MIN_WORDS) {
      reasons.push({ code: 'audio_not_checked', detail: 'The audio levels could not be read, so the text was not checked against them.' })
    }
  } else {
    const hasAudio = audioFrameTest(env, input.envelopeUnit)
    const fileSeconds = env.length * FRAME_SECONDS
    measures.fileSeconds = fileSeconds

    const span = Math.max(...timed.map((s) => Math.max(s.start as number, typeof s.end === 'number' ? s.end : (s.start as number))))
    // Old WAV files declare PCM over MP3 data: the transcriber saw a quarter of the length.
    const ratio = span / fileSeconds
    const factor =
      /\.wav$/i.test(input.fileName) && ratio > 0.18 && ratio < 0.34 ? fileSeconds / Math.max(span, fileSeconds / 4) : 1
    measures.timeFactor = Math.round(factor * 100) / 100

    let placeable = 0
    let silent = 0
    let unplaceable = 0
    let audioFrames = 0
    for (let f = 0; f < env.length; f++) if (hasAudio(f)) audioFrames++
    for (let i = 0; i < timed.length; i++) {
      const w = countWords(timed[i].text)
      if (!w) continue
      const a = (timed[i].start as number) * factor
      const ownEnd = typeof timed[i].end === 'number' ? (timed[i].end as number) * factor : a
      const next = i + 1 < timed.length ? (timed[i + 1].start as number) * factor : Math.min(fileSeconds, ownEnd)
      const length = next - a
      if (length <= 0 || w / length > MAX_WORDS_PER_SECOND) {
        unplaceable += w
        continue
      }
      placeable += w
      const f0 = Math.max(0, Math.floor(a / FRAME_SECONDS))
      const f1 = Math.min(env.length, Math.ceil(next / FRAME_SECONDS))
      if (f1 <= f0) {
        silent += w
        continue
      }
      let quiet = 0
      for (let f = f0; f < f1; f++) if (!hasAudio(f)) quiet++
      silent += w * (quiet / (f1 - f0))
    }
    const timedWords = placeable + unplaceable
    measures.unplaceableShare = timedWords ? unplaceable / timedWords : 0
    measures.silentShare = placeable ? silent / placeable : 0

    if (totalWords >= MIN_WORDS && placeable >= MIN_PLACEABLE_WORDS && measures.silentShare >= INVALID_SILENT_SHARE) {
      invalidReasons.push({
        code: 'text_without_audio',
        detail: `${percent(measures.silentShare)} of the text sits where the recording has no audio at all.`
      })
    }
    if (totalWords >= MIN_WORDS && placeable >= MIN_PLACEABLE_WORDS && measures.silentShare >= DOUBT_SILENT_SHARE) {
      reasons.push({
        code: 'much_text_without_audio',
        detail: `${percent(measures.silentShare)} of the text sits where the recording has no audio.`
      })
    }
    if (totalWords >= MIN_WORDS && measures.unplaceableShare >= DOUBT_UNPLACEABLE_SHARE) {
      reasons.push({
        code: 'text_not_placeable_in_time',
        detail: `${percent(measures.unplaceableShare)} of the words sit in lines faster than anyone speaks or with no duration.`
      })
    }
    const audioSeconds = audioFrames * FRAME_SECONDS
    const wordsPerSoundMinute = audioSeconds > 0 ? totalWords / audioSeconds * 60 : null
    measures.wordsPerSoundMinute = wordsPerSoundMinute
    if (totalWords >= MIN_WORDS && totalWords / Math.max(audioSeconds, 1) > MAX_WORDS_PER_SECOND) {
      reasons.push({
        code: 'more_words_than_audio',
        detail: `${totalWords} words, but only ${Math.round(audioSeconds)} s of the file has any audio.`
      })
    }

    const end = span * factor
    measures.endSeconds = Math.round(end)
    const fromFrame = Math.max(0, Math.floor(end / FRAME_SECONDS))
    let after = 0
    for (let f = fromFrame; f < env.length; f++) if (hasAudio(f)) after++
    measures.audioAfterEndSeconds = Math.round(after * FRAME_SECONDS)
    if (fileSeconds >= EARLY_END_MIN_FILE_SECONDS && end < EARLY_END_SHARE * fileSeconds) {
      const afterSeconds = after * FRAME_SECONDS
      if (afterSeconds >= AFTER_END_MIN_AUDIO_SECONDS) {
        if (wordsPerSoundMinute !== null && wordsPerSoundMinute >= MIN_WORDS_PER_SOUND_MINUTE) {
          reasons.push({
            code: 'clock_compressed',
            detail:
              `The times end at ${Math.round(end)} s of ${Math.round(fileSeconds)} s, with ${Math.round(wordsPerSoundMinute)} words per sound-minute; ` +
              'the dense text suggests a compressed clock and needs sampling.'
          })
        } else {
          completenessReasons.push({
            code: 'speech_after_the_end',
            detail: `The transcript stops at ${Math.round(end)} s, and ${Math.round(afterSeconds)} s of audio follow it.`
          })
        }
      }
    }
  }

  return settle(reasons)
}

/** A transcript nothing may be built on (summary, categorization, search, people). */
export function isUnusableValidity(status: string | null | undefined): boolean {
  return status === 'invalid' || status === 'incomplete' || status === 'doubtful'
}

/** Gap-only text remains useful; density failures cannot support derived content. */
export function isGapOnlyValidity(validity: TranscriptValidity): boolean {
  return validity.status === 'incomplete' && !validity.reasons.some(r => r.code === 'sparse_speech')
}

/** Coordinator: timing doubts and missing spans retain their useful derived content. */
export function shouldWithholdDerivedContent(validity: Pick<TranscriptValidity, 'status' | 'reasons'>): boolean {
  return validity.status === 'invalid' || validity.reasons.some(r => r.code === 'sparse_speech')
}
