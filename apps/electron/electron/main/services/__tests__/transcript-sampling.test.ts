// @vitest-environment node

/**
 * Which minutes of a doubtful transcript are transcribed again, what the
 * stored text says there, and the verdict of the comparison.
 */

import { describe, it, expect } from 'vitest'
import {
  afterEndVerdict,
  planAfterEndWindows,
  planSampleWindows,
  precheckWindow,
  sampleVerdict,
  SAMPLE_WINDOWS,
  SAMPLE_WINDOW_SECONDS,
} from '../transcript-sampling'

const words = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `w${i}${tag}`).join(' ')
const lines = (count: number, every: number, tag = '') =>
  Array.from({ length: count }, (_, i) => ({ speaker: 'A', start: i * every, end: i * every + every - 1, text: words(20, `${tag}-${i}`) }))

describe('planSampleWindows', () => {
  it('spreads three one-minute windows over the covered span, with the stored text of those minutes', () => {
    const w = planSampleWindows({ segments: lines(60, 10), fileSeconds: 600, timeFactor: 1 })
    expect(w).toHaveLength(SAMPLE_WINDOWS)
    for (const window of w) {
      expect(window.end - window.start).toBe(SAMPLE_WINDOW_SECONDS)
      expect(window.storedText.length).toBeGreaterThan(0)
    }
    expect(w[0].start).toBeLessThan(w[1].start)
    expect(w[1].start).toBeLessThan(w[2].start)
    // The middle window holds the text of its minutes, not the opening lines.
    expect(w[1].storedText).toContain('w0-27')
    expect(w[1].storedText).not.toContain('w0-0 ')
  })

  it('stretches a compressed clock onto the real speech before placing the windows', () => {
    // Times end at 300 s, the talk runs to 1,200 s.
    const w = planSampleWindows({ segments: lines(60, 5), fileSeconds: 1200, timeFactor: 1, compressedTo: 1200 })
    expect(w[w.length - 1].start).toBeGreaterThan(800)
    expect(w[w.length - 1].storedText).toContain('w0-55')
  })

  it('maps the quarter timeline of an old WAV file', () => {
    const w = planSampleWindows({ segments: lines(30, 5), fileSeconds: 600, timeFactor: 4 })
    expect(w[w.length - 1].start).toBeGreaterThan(400)
  })

  it('slides a window off silence to where there is audio', () => {
    const silentMiddle = (s: number) => s < 200 || s > 400
    const w = planSampleWindows({ segments: lines(60, 10), fileSeconds: 600, timeFactor: 1, hasAudioAt: silentMiddle })
    for (const window of w) expect(silentMiddle(window.start + SAMPLE_WINDOW_SECONDS / 2)).toBe(true)
  })

  it('adds text that cannot be placed in time to every window', () => {
    const segments = [...lines(20, 10), { speaker: 'B', start: 100, end: 100, text: words(500, 'dump') }]
    const w = planSampleWindows({ segments, fileSeconds: 600, timeFactor: 1 })
    for (const window of w) expect(window.storedText).toContain('w0dump')
  })

  it('plans nothing for a transcript shorter than half a window', () => {
    expect(planSampleWindows({ segments: lines(2, 10), fileSeconds: 20, timeFactor: 1 })).toEqual([])
  })
})

describe('sampleVerdict', () => {
  it('confirms when most windows tell the same conversation', () => {
    expect(sampleVerdict(['same', 'same', 'different'])).toBe('confirmed')
  })
  it('contradicts when most tell another one, or there is no speech under the text', () => {
    expect(sampleVerdict(['different', 'no_speech', 'same'])).toBe('contradicted')
  })
  it('stays inconclusive on a tie or when nothing could be judged', () => {
    expect(sampleVerdict(['same', 'different'])).toBe('inconclusive')
    expect(sampleVerdict(['unclear', 'unclear'])).toBe('inconclusive')
    expect(sampleVerdict([])).toBe('inconclusive')
  })
})

describe('precheckWindow', () => {
  it('calls no speech where the stored transcript has text and the new one has none', () => {
    expect(precheckWindow('', words(40))).toBe('no_speech')
    expect(precheckWindow('mm', '')).toBe('unclear')
    expect(precheckWindow(words(40), words(40))).toBeNull()
  })
})

// Kiro review of PR 2: a transcript that stops early was sampled over the
// part it already covers, and confirmed the part that was never in doubt.
describe('a transcript that stops while the audio goes on', () => {
  it('samples after its end, where there is audio', () => {
    const w = planAfterEndWindows({ endSeconds: 1400, fileSeconds: 3600, hasAudioAt: (s) => s > 2000 })
    expect(w.length).toBeGreaterThan(0)
    for (const window of w) {
      expect(window.start).toBeGreaterThanOrEqual(1400)
      expect(window.storedText).toBe('')
    }
    expect(planAfterEndWindows({ endSeconds: 3590, fileSeconds: 3600 })).toEqual([])
  })

  it('is incomplete when speech follows, confirmed when nothing does', () => {
    expect(afterEndVerdict(['', words(30)])).toBe('incomplete')
    expect(afterEndVerdict(['', 'mm'])).toBe('confirmed')
    expect(afterEndVerdict([null, null])).toBe('inconclusive')
  })
})
