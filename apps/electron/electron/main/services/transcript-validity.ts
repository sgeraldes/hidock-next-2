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
 *    audio after it is fine, speech after it with a normal speaking rate means
 *    content is missing, a speaking rate no one reaches means the clock was
 *    compressed while the text is complete.
 *
 * Outcomes: 'audio' (silent, noise only or too short: the audio decides, no
 * transcript needed), 'invalid', 'incomplete', 'doubtful' and 'valid'. Only a
 * valid transcript is categorized; a doubtful one is resolved by transcribing a
 * sample of its audio and comparing meaning.
 */

import { FRAME_SECONDS, LOUD_DB, LOUD_GAIN } from './audio-profile'

/** Bumped when a rule changes, so stored verdicts are recomputed. */
export const VALIDITY_VERSION = 1

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

function countWords(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

function percent(n: number): string {
  return `${Math.round(n * 100)}%`
}

export function assessTranscriptValidity(input: ValidityInput): TranscriptValidity {
  const totalWords = input.segments.reduce((sum, s) => sum + countWords(s.text), 0)
  const speakers = new Set(input.segments.map((s) => s.speaker).filter((s): s is string => !!s)).size
  const measures: TranscriptValidity['measures'] = {
    words: totalWords,
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
  if (input.integrityStatus === 'broken') {
    return result('invalid', [{ code: 'integrity', detail: 'The text does not fit this audio (integrity check).' }])
  }

  const reasons: ValidityReason[] = []
  const timed = input.segments.filter((s) => typeof s.start === 'number' && Number.isFinite(s.start))

  if (timed.length === 0) {
    if (totalWords >= MIN_WORDS) {
      reasons.push({ code: 'no_times', detail: 'The transcript has no times, so nothing can be checked against the audio.' })
    }
    return result(reasons.length ? 'doubtful' : 'valid', reasons)
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

  if (input.attendees > 0 && speakers > input.attendees + 1) {
    reasons.push({
      code: 'more_speakers_than_invited',
      detail: `${speakers} speakers in the transcript, ${input.attendees} people invited.`
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
    const sorted = Uint8Array.from(env).sort()
    const floor = sorted[Math.floor(sorted.length * 0.05)]
    const decoded = input.envelopeUnit === 'db'
    const margin = decoded ? FLOOR_MARGIN_DB : FLOOR_MARGIN
    const loud = decoded ? LOUD_DB + 100 : LOUD_GAIN
    const hasAudio = (f: number) => env[f] >= floor + margin || env[f] > loud
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
      return result('invalid', [
        {
          code: 'text_without_audio',
          detail: `${percent(measures.silentShare)} of the text sits where the recording has no audio at all.`
        }
      ])
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
        const spanRate = totalWords / Math.max(end, 1)
        const fileRate = totalWords / fileSeconds
        if (spanRate > COMPRESSED_SPAN_RATE && fileRate >= 1 && fileRate <= 3.5) {
          reasons.push({
            code: 'clock_compressed',
            detail:
              `The times end at ${Math.round(end)} s of ${Math.round(fileSeconds)} s, at a speaking rate no one reaches; ` +
              'the text looks complete and its clock compressed.'
          })
        } else if (spanRate <= COMPRESSED_SPAN_RATE) {
          return result('incomplete', [
            ...reasons,
            {
              code: 'speech_after_the_end',
              detail: `The transcript stops at ${Math.round(end)} s, and ${Math.round(afterSeconds)} s of audio follow it.`
            }
          ])
        } else {
          reasons.push({
            code: 'audio_after_the_end',
            detail: `The transcript stops at ${Math.round(end)} s, and ${Math.round(afterSeconds)} s of audio follow it.`
          })
        }
      }
    }
  }

  return result(reasons.length ? 'doubtful' : 'valid', reasons)
}

/** A transcript nothing may be built on (summary, categorization, search, people). */
export function isUnusableValidity(status: string | null | undefined): boolean {
  return status === 'invalid' || status === 'incomplete' || status === 'doubtful'
}
