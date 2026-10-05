import gains from './fixtures/rec28-audio-gains'
import { audioFrameTest } from '../transcript-validity'
import { describe, expect, it } from 'vitest'
import { assessTimingEvidence, applyTimingReview } from '../transcript-timing-evidence'
const segments = [494.8, 13, 14.9, 17].map(start => ({ start, end: start + 0.7, text: 'hello there' }))
describe('audio evidence for sequence outliers', () => {
  it('suggests placement when the sequence gap contains speech, without claiming lexical matching', () => {
    const [finding] = assessTimingEvidence(segments, () => true)
    expect(finding.classification).toBe('out_of_place')
    expect(finding.detail).toContain('not a word-aligned time')
    expect(finding.index).toBe(0)
  })
  it('offers a move when implied audio exists and claimed audio does not', () => {
    const [finding] = assessTimingEvidence(segments, (a) => a < 20)
    expect(finding.classification).toBe('out_of_place')
    expect(finding.suggestedStart).toBeLessThan(13)
  })
  it('calls absent audio at both locations probable hallucination, and missing evidence unsure', () => {
    expect(assessTimingEvidence(segments, () => false)[0].classification).toBe('probable_hallucination')
    expect(assessTimingEvidence(segments, () => null)[0].classification).toBe('unsure')
  })
  it('hides reversibly, retaining text and rejecting a stale fingerprint at the IPC boundary', () => {
    const hidden = applyTimingReview(segments, 0, 'hide')
    expect(hidden[0].timingHidden).toBe(true)
    expect(hidden[0].text).toBe(segments[0].text)
    expect(applyTimingReview(hidden, 0, 'show')[0].timingHidden).toBe(false)
    expect(segments[0]).not.toHaveProperty('timingHidden')
  })
})


it('places Rec28 in its quiet opening audio gap, instead of at the 8:14 speech about another topic', () => {
  const env = Uint8Array.from(gains.flatMap(part => part.levels))
  const test = audioFrameTest(env)
  const offsets = [0, gains[0].levels.length]
  const hasAudio = (start: number, end: number) => {
    let sound = 0
    for (let p = 0; p < gains.length; p++) {
      const part = gains[p]
      const from = Math.max(part.fromFrame, Math.floor(start / 0.036))
      const to = Math.min(part.fromFrame + part.levels.length, Math.ceil(end / 0.036))
      for (let f = from; f < to; f++) if (test(offsets[p] + f - part.fromFrame)) sound++
    }
    return sound * 0.036 >= 0.15
  }
  const [finding] = assessTimingEvidence([
    { start: 494.8, end: 505.7, text: 'word word word word' },
    { start: 13, end: 13.7, text: 'word word' },
    { start: 14.9, end: 15.8, text: 'word word word word word' }
  ], hasAudio)
  expect(finding).toMatchObject({ index: 0, classification: 'out_of_place', claimedAudio: true, impliedAudio: true, suggestedStart: 4.5 })
})
