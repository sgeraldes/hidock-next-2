// @vitest-environment node

/**
 * Transcript validity, decided from the audio and the transcript alone, before
 * anything categorizes it. Owner, 4-oct-2026: "an LLM cannot tell invented
 * text"; invention is shown by peak-level detection, and consistently wrong
 * times, text without audio and more speakers than invited are flagged.
 */

import { describe, it, expect } from 'vitest'
import { assessTranscriptValidity, type ValidityInput } from '../transcript-validity'
import { FRAME_SECONDS } from '../audio-profile'

/** A gain envelope: `pieces` of [gain, seconds]. 138 is the encoder's silence floor, 160 speech. */
function envelope(pieces: Array<[number, number]>): Uint8Array {
  const out: number[] = []
  for (const [gain, seconds] of pieces) for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) out.push(gain)
  return Uint8Array.from(out)
}

const words = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `w${i}${tag}`).join(' ')

function base(over: Partial<ValidityInput> = {}): ValidityInput {
  return {
    fileName: '2026Oct02-110116-Rec14.hda',
    segments: [],
    envelope: null,
    audioCategory: 'speech',
    attendees: 0,
    integrityStatus: 'ok',
    accepted: false,
    ...over
  }
}

describe('assessTranscriptValidity', () => {
  it('is valid when the text sits where the audio is', () => {
    const env = envelope([[160, 600]])
    const segments = Array.from({ length: 60 }, (_, i) => ({ speaker: i % 2 ? 'A' : 'B', start: i * 10, end: i * 10 + 9, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.status).toBe('valid')
    expect(v.reasons).toEqual([])
  })

  it('is invalid when the text sits where there is no audio at all (Rec41 of 14-jan)', () => {
    const env = envelope([[138, 590], [160, 10]])
    const segments = Array.from({ length: 50 }, (_, i) => ({ speaker: 'A', start: i * 11, end: i * 11 + 10, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.status).toBe('invalid')
    expect(v.reasons.map((r) => r.code)).toContain('text_without_audio')
  })

  it('counts soft speech below the loudness line as audio, against the recording own floor', () => {
    // Rec59 of 1-apr: two hours of real talk, most of it below the fixed line (gain 142).
    const env = envelope([[138, 60], [141, 540]])
    const segments = Array.from({ length: 49 }, (_, i) => ({ speaker: 'A', start: 60 + i * 11, end: 60 + i * 11 + 10, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.reasons.map((r) => r.code)).not.toContain('text_without_audio')
    expect(v.reasons.map((r) => r.code)).not.toContain('much_text_without_audio')
  })

  it('never calls text that cannot be placed in time "without audio"; it is a timing doubt (Rec19 of 7-apr)', () => {
    const env = envelope([[160, 500]])
    const segments = [
      { speaker: 'A', start: 0, end: 3, text: words(6) },
      { speaker: 'B', start: 3, end: 40, text: words(60, 'b') },
      { speaker: 'A', start: 40, end: 40, text: words(1030, 'c') }
    ]
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    const codes = v.reasons.map((r) => r.code)
    expect(codes).toContain('text_not_placeable_in_time')
    expect(codes).not.toContain('text_without_audio')
    expect(v.status).toBe('doubtful')
  })

  it('maps the quarter timeline of an old WAV file onto the real one before comparing', () => {
    // The header declared PCM, so the transcriber saw 150 s of a 600 s file.
    const env = envelope([[160, 600]])
    const segments = Array.from({ length: 30 }, (_, i) => ({ speaker: 'A', start: i * 5, end: i * 5 + 5, text: words(10, `-${i}`) }))
    const v = assessTranscriptValidity(base({ fileName: '2025Aug05-131211-Rec11.wav', envelope: env, segments }))
    expect(v.status).toBe('valid')
  })

  it('flags timestamps that are consistently wrong', () => {
    const env = envelope([[160, 600]])
    const segments = Array.from({ length: 20 }, (_, i) => ({ speaker: 'A', start: Math.floor(i / 2) * 60, end: Math.floor(i / 2) * 60 + 50, text: words(10, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments, integrityStatus: 'suspect' }))
    expect(v.reasons.map((r) => r.code)).toContain('timestamps_consistently_wrong')
    expect(v.status).toBe('doubtful')
  })

  it('flags more speakers than the calendar invited', () => {
    const env = envelope([[160, 600]])
    const segments = Array.from({ length: 60 }, (_, i) => ({ speaker: `S${i % 6}`, start: i * 10, end: i * 10 + 9, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments, attendees: 3 }))
    expect(v.reasons.map((r) => r.code)).toContain('more_speakers_than_invited')
    expect(v.status).toBe('doubtful')
  })

  it('calls a transcript that stops while the speech goes on incomplete (Rec18 of 6-aug)', () => {
    const env = envelope([[160, 1200]])
    const segments = Array.from({ length: 40 }, (_, i) => ({ speaker: 'A', start: i * 10, end: i * 10 + 9, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.status).toBe('incomplete')
    expect(v.reasons.map((r) => r.code)).toContain('speech_after_the_end')
  })

  it('accepts a transcript that ends early when nothing real follows', () => {
    const env = envelope([[160, 400], [138, 800]])
    const segments = Array.from({ length: 40 }, (_, i) => ({ speaker: 'A', start: i * 10, end: i * 10 + 9, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.status).toBe('valid')
  })

  it('doubts a transcript whose clock is compressed: complete text, times on a shorter span', () => {
    // 5,612 words over 2,290 s of talk, stated as ending at 934 s (Rec14 of 5-aug).
    const env = envelope([[160, 2290]])
    const segments = Array.from({ length: 100 }, (_, i) => ({ speaker: 'A', start: i * 9.34, end: i * 9.34 + 9, text: words(56, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments }))
    expect(v.status).toBe('doubtful')
    expect(v.reasons.map((r) => r.code)).toContain('clock_compressed')
  })

  it('keeps the integrity verdict: broken is invalid', () => {
    const v = assessTranscriptValidity(base({ integrityStatus: 'broken', segments: [{ speaker: 'A', start: 0, text: 'hola' }] }))
    expect(v.status).toBe('invalid')
  })

  it('leaves the decision to the audio for silent, noise-only and too-short files', () => {
    expect(assessTranscriptValidity(base({ audioCategory: 'noise' })).status).toBe('audio')
    expect(assessTranscriptValidity(base({ audioCategory: 'silent' })).status).toBe('audio')
    expect(assessTranscriptValidity(base({ audioCategory: 'too_short' })).status).toBe('audio')
  })

  it('takes the owner acceptance as valid', () => {
    const v = assessTranscriptValidity(base({ integrityStatus: 'broken', accepted: true, segments: [{ speaker: 'A', start: 0, text: 'hola' }] }))
    expect(v.status).toBe('valid')
  })

  // Kiro review of #149: errors were divided by every line, timed or not, so
  // untimed lines hid a broken clock.
  it('measures timing errors against the timed lines only', () => {
    const env = envelope([[160, 600]])
    const timedBad = Array.from({ length: 20 }, (_, i) => ({ speaker: 'A', start: Math.floor(i / 2) * 60, end: Math.floor(i / 2) * 60 + 50, text: words(10, `-${i}`) }))
    const untimed = Array.from({ length: 80 }, (_, i) => ({ speaker: 'A', text: words(3, `-u${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: env, segments: [...timedBad, ...untimed] }))
    expect(v.reasons.map((r) => r.code)).toContain('timestamps_consistently_wrong')
  })

  // Kiro review of #149: an imported MP3 or FLAC keeps a decoded envelope in
  // dB, and was passed as valid with no peak check at all.
  it('reads a decoded envelope in dB against its own floor', () => {
    const decoded = (pieces: Array<[number, number]>) => envelope(pieces) // the same shape, the bytes are dBFS + 100
    const segments = Array.from({ length: 50 }, (_, i) => ({ speaker: 'A', start: i * 11, end: i * 11 + 10, text: words(20, `-${i}`) }))
    const quiet = assessTranscriptValidity(base({ fileName: 'import.mp3', envelope: decoded([[20, 590], [60, 10]]), envelopeUnit: 'db', segments }))
    expect(quiet.status).toBe('invalid')
    const talk = assessTranscriptValidity(base({ fileName: 'import.mp3', envelope: decoded([[20, 60], [48, 540]]), envelopeUnit: 'db', segments }))
    expect(talk.status).toBe('valid')
  })

  it('doubts a long timed transcript whose audio could not be read, instead of passing it', () => {
    const segments = Array.from({ length: 50 }, (_, i) => ({ speaker: 'A', start: i * 11, end: i * 11 + 10, text: words(20, `-${i}`) }))
    const v = assessTranscriptValidity(base({ envelope: null, segments }))
    expect(v.status).toBe('doubtful')
    expect(v.reasons.map((r) => r.code)).toContain('audio_not_checked')
    expect(assessTranscriptValidity(base({ envelope: null, segments: segments.slice(0, 2) })).status).toBe('valid')
  })

  it('doubts a long transcript with no times at all, since nothing can be checked against the audio', () => {
    const v = assessTranscriptValidity(base({ envelope: envelope([[160, 600]]), segments: [{ speaker: 'A', text: words(300) }] }))
    expect(v.status).toBe('doubtful')
    expect(v.reasons.map((r) => r.code)).toContain('no_times')
  })
})
