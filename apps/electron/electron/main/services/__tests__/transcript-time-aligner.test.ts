import { describe, expect, it } from 'vitest'
import { alignToSpeech, speechSpansFromFrames, ALIGN_MIN_CONFIDENCE } from '../transcript-time-aligner'
import { fromFrame, levels, openingVadActivity, vadActivity } from './fixtures/rec28-section-audio'
import { audioFrameTest } from '../transcript-validity'
import { FRAME_SECONDS } from '../audio-profile'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('alignToSpeech: the existing text placed on the sound between two trusted lines', () => {
  it('puts each line at the start of the speech its words take', () => {
    const spans = [{ start: 10, end: 12 }, { start: 13, end: 16 }, { start: 17, end: 18 }]
    const result = alignToSpeech([{ text: words(5) }, { text: words(8) }, { text: words(3) }], { start: 9, end: 19 }, spans)
    expect(result.ok).toBe(true)
    expect(result.starts.map((s) => Math.round(s * 10) / 10)).toEqual([10, 13, 17])
    expect(result.ends[2]).toBeLessThanOrEqual(19)
    expect(result.confidence).toBeGreaterThanOrEqual(ALIGN_MIN_CONFIDENCE)
  })

  it('never returns starts out of order or outside the window', () => {
    const spans = [{ start: 0, end: 40 }]
    const result = alignToSpeech(Array.from({ length: 12 }, () => ({ text: words(9) })), { start: 0, end: 40 }, spans)
    for (let i = 1; i < result.starts.length; i++) expect(result.starts[i]).toBeGreaterThanOrEqual(result.starts[i - 1])
    expect(Math.min(...result.starts)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...result.ends)).toBeLessThanOrEqual(40)
  })

  it('never gives two lines the same start, which would be a repeated start (Kiro review of #195)', () => {
    const result = alignToSpeech([{ text: words(2) }, { text: words(6) }, { text: words(4) }], { start: 0, end: 10 }, [{ start: 0, end: 4 }])
    expect(new Set(result.starts.map((s) => Math.round(s * 100))).size).toBe(3)
    for (let i = 1; i < result.starts.length; i++) expect(result.starts[i]).toBeGreaterThan(result.starts[i - 1])
    for (let i = 0; i < result.ends.length; i++) expect(result.ends[i]).toBeGreaterThan(result.starts[i])
  })

  it('refuses when the window holds no sound', () => {
    const result = alignToSpeech([{ text: words(4) }], { start: 0, end: 10 }, [])
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no speech/i)
  })

  it('refuses when the words cannot fit in the sound', () => {
    const result = alignToSpeech([{ text: words(60) }], { start: 0, end: 10 }, [{ start: 2, end: 4 }])
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/more words/i)
  })

  it('is not confident when the sound is far more than these words, so other speech is in the window', () => {
    const result = alignToSpeech([{ text: words(3) }], { start: 0, end: 120 }, [{ start: 5, end: 110 }])
    expect(result.ok).toBe(false)
    expect(result.confidence).toBeLessThan(ALIGN_MIN_CONFIDENCE)
  })

  it('ignores clicks shorter than a syllable', () => {
    const result = alignToSpeech([{ text: words(4) }], { start: 0, end: 13 }, openingVadActivity)
    expect(result.ok).toBe(true)
    expect(result.starts[0]).toBeCloseTo(4.857, 1)
  })

  it('Rec28: the opening greeting goes to 0:04.9, from VAD stretches or from the envelope', () => {
    const fromVad = alignToSpeech([{ text: 'Hola, Manuel, ¿cómo estás?' }], { start: 0, end: 13 }, openingVadActivity)
    expect(fromVad.starts[0]).toBeCloseTo(4.86, 1)
  })

  it('Rec28 3300-3420 s: the envelope gives speech stretches close to the VAD ones', () => {
    const test = audioFrameTest(Uint8Array.from(levels), 'gain')
    const spans = speechSpansFromFrames((f) => test(f - fromFrame), fromFrame, fromFrame + levels.length, FRAME_SECONDS)
    const seconds = (xs: Array<{ start: number; end: number }>) => xs.reduce((sum, s) => sum + s.end - s.start, 0)
    const vadInside = vadActivity.map((s) => ({ start: Math.max(s.start, 3300), end: Math.min(s.end, 3420) })).filter((s) => s.end > s.start)
    expect(spans[0].start).toBeGreaterThanOrEqual(3299.9)
    expect(Math.abs(seconds(spans) - seconds(vadInside)) / seconds(vadInside)).toBeLessThan(0.35)
  })
})
