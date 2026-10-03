/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { CRAMPED_WORDS_PER_SECOND, assessTranscriptIntegrity, formatClock } from '../transcript-integrity'
import { IMPOSSIBLE_WORDS_PER_SECOND } from '../value-thresholds'

const seg = (start: number | null, text: string, end?: number) => ({ speaker: 'SPEAKER_00', start, end, text })
const json = (segments: unknown[]) => JSON.stringify(segments)
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('assessTranscriptIntegrity', () => {
  it('passes a transcript whose times move forward at a human pace', () => {
    const r = assessTranscriptIntegrity(
      json([seg(0, 'Hola, ¿cómo estás?'), seg(3, 'Bien, gracias, ¿y vos?'), seg(6, 'Todo tranquilo por acá.')]),
      10
    )
    expect(r.status).toBe('ok')
    expect(r.issues).toEqual([])
    expect(r.words).toBe(11)
  })

  it('flags two lines that start at the same instant, whatever the time', () => {
    const r = assessTranscriptIntegrity(json([seg(0, 'a'), seg(12.5, 'b'), seg(12.5, 'c'), seg(20, 'd')]), 60)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'repeated_start', count: 1 }))
    expect(r.status).toBe('suspect')
  })

  it('flags repeated 0:00 starts too', () => {
    const r = assessTranscriptIntegrity(json([seg(0, 'a'), seg(0, 'b'), seg(0, 'c')]), 60)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'repeated_start', count: 2 }))
  })

  it('flags a start that goes back in time, as at a chunk seam', () => {
    const r = assessTranscriptIntegrity(json([seg(6665, 'a'), seg(6669, 'b'), seg(5400, 'c'), seg(5423, 'd')]), 7000)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'backwards_start', count: 1 }))
  })

  it('flags a line with more words than its time allows', () => {
    // 20 words between 10 s and 11 s: 20 words per second, past the library's
    // 8 words-per-second limit.
    const r = assessTranscriptIntegrity(json([seg(10, words(20)), seg(11, 'ok'), seg(30, 'fin')]), 60)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'cramped_lines', count: 1 }))
  })

  it('leaves a fast but speakable line alone', () => {
    // 12 words in 2 s is 6 words per second: quick, not impossible.
    const r = assessTranscriptIntegrity(json([seg(10, words(12)), seg(12, 'ok'), seg(30, 'fin')]), 60)
    expect(r.issues.find((i) => i.code === 'cramped_lines')).toBeUndefined()
  })

  it('does not judge the pace of short lines', () => {
    const r = assessTranscriptIntegrity(json([seg(10, 'sí, claro, dale'), seg(10.2, 'ok')]), 60)
    expect(r.issues.find((i) => i.code === 'cramped_lines')).toBeUndefined()
  })

  it('flags text that runs past the end of the audio without calling it invented', () => {
    const r = assessTranscriptIntegrity(json([seg(0, 'a'), seg(100, 'b'), seg(130, 'c')]), 120)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'past_audio_end' }))
    expect(r.status).toBe('suspect')
  })

  it('calls a transcript broken when its words cannot fit in its audio', () => {
    // 1,677 words in 18 s: the real case from 14-jul-2026.
    const r = assessTranscriptIntegrity(json([seg(0, words(1677))]), 18)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'too_many_words' }))
    expect(r.status).toBe('broken')
  })

  it('skips the audio checks when the audio length is unknown', () => {
    const r = assessTranscriptIntegrity(json([seg(0, words(1677)), seg(500, 'x')]), null)
    expect(r.audioSeconds).toBeNull()
    expect(r.issues.map((i) => i.code)).not.toContain('too_many_words')
    expect(r.issues.map((i) => i.code)).not.toContain('past_audio_end')
  })

  it('flags lines with no time', () => {
    const r = assessTranscriptIntegrity(json([seg(0, 'a'), seg(null, 'b')]), 60)
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'untimed_lines', count: 1 }))
  })

  it('treats a missing or unreadable transcript as having nothing to judge', () => {
    expect(assessTranscriptIntegrity(null, 60).status).toBe('ok')
    expect(assessTranscriptIntegrity('{not json', 60).lines).toBe(0)
  })
})

describe('formatClock', () => {
  it('formats minutes and hours', () => {
    expect(formatClock(18)).toBe('0:18')
    expect(formatClock(6669)).toBe('1:51:09')
  })
})

describe('shared line rules', () => {
  it('flags one line at the library-wide impossible pace', () => {
    expect(CRAMPED_WORDS_PER_SECOND).toBe(IMPOSSIBLE_WORDS_PER_SECOND)
  })
})

// Owner, 3-oct-2026: the transcript of Rec02 (21-apr, 789 s of crackle with
// 3.74 s of sound) was 2,554 words of an invented murder confession, and its
// integrity said only "one cramped line". The audio profile knew better.
describe('assessTranscriptIntegrity against the audio profile', () => {
  const noise = { category: 'noise', soundSeconds: 3.74 } as const
  const speech = (soundSeconds: number) => ({ category: 'speech', soundSeconds }) as const

  it('breaks a transcript laid over audio that is only noise', () => {
    const lines = Array.from({ length: 30 }, (_, i) => seg(i * 25, `${words(11)} n${i}`))
    const r = assessTranscriptIntegrity(json(lines), 789, noise)
    expect(r.status).toBe('broken')
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'text_over_noise', count: 1 }))
  })

  it('breaks a transcript laid over silent audio', () => {
    const r = assessTranscriptIntegrity(json([seg(0, words(25))]), 60, { category: 'silent', soundSeconds: 0 })
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'text_over_noise' }))
    expect(r.status).toBe('broken')
  })

  it('leaves a word or two over noise alone: a cough read as "sí" is not a story', () => {
    const r = assessTranscriptIntegrity(json([seg(5, 'Sí.')]), 60, noise)
    expect(r.issues.map((i) => i.code)).not.toContain('text_over_noise')
  })

  it('breaks a transcript with far more words than the seconds of sound could hold', () => {
    // Rec41 of 14-jan: 11,419 words over 9 s of sound in 96 minutes.
    const lines = Array.from({ length: 100 }, (_, i) => seg(i * 57, `${words(113)} n${i}`))
    const r = assessTranscriptIntegrity(json(lines), 5750, speech(9.2))
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'words_beyond_sound', count: 1 }))
    expect(r.status).toBe('broken')
  })

  it('keeps soft speech that the loudness line undercounts', () => {
    // Rec45 of 21-jul: 115 words in 59 s, 5.1 s above the loudness line (22.5 words per second of it).
    const r = assessTranscriptIntegrity(json([seg(0, words(60)), seg(30, words(55))]), 59, speech(5.1))
    expect(r.issues.map((i) => i.code)).not.toContain('words_beyond_sound')
  })

  it('breaks a transcript where half the words are the same lines repeated', () => {
    const loop = 'y entonces le dije que no podía seguir así'
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => seg(i * 10, loop)),
      ...Array.from({ length: 5 }, (_, i) => seg(100 + i * 10, `${words(8)} n${i}`))
    ]
    const r = assessTranscriptIntegrity(json(lines), 600, speech(400))
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'repeated_text' }))
    expect(r.status).toBe('broken')
  })

  it('does not count short replies that people really repeat', () => {
    const lines = Array.from({ length: 40 }, (_, i) => seg(i * 5, i % 2 ? 'Sí, claro.' : `${words(8)} n${i}`))
    const r = assessTranscriptIntegrity(json(lines), 600, speech(400))
    expect(r.issues.map((i) => i.code)).not.toContain('repeated_text')
  })

  it('judges nothing against the audio when there is no profile', () => {
    const r = assessTranscriptIntegrity(json([seg(0, words(25))]), 60)
    expect(r.issues.map((i) => i.code)).not.toContain('text_over_noise')
    expect(r.status).toBe('ok')
  })
})
