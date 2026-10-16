import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  groupWordsIntoLines,
  lastSpeechEndIn,
  normalizeIntervals,
  planSpeechSpans,
  sliceWavSpan,
  speechCoverageShortfall,
  speechSecondsIn,
} from '../src/engines/native-speech.js'

// Voice activity of channel 0 in the first 426 s chunk of three real meetings
// (13/14-oct-2026). Rec07: Gemini's last word ended at 125.2 s (retained
// response). Rec16: 47 s, from the reported "covers 11% of the 426s recording".
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'first-chunk-voice-2026-10.json'), 'utf8'))

describe('speechCoverageShortfall: judged against the voice, not the chunk', () => {
  it('a chunk with no voice is never incomplete (Rec12 channel 0 failed with "covers 2%")', () => {
    expect(fixture.rec12Channel0).toEqual([])
    expect(speechCoverageShortfall(8, fixture.rec12Channel0, 0, 426)).toBeNull()
  })

  it('isolated blips after the last real sentence do not make it incomplete (Rec16 "covers 11%")', () => {
    expect(speechCoverageShortfall(fixture.geminiLastWordEnd.rec16Channel0, fixture.rec16Channel0, 0, 426)).toBeNull()
  })

  it('text that stops while the voice goes on is incomplete (Rec07: words to 125 s, voice to 399 s)', () => {
    const reason = speechCoverageShortfall(fixture.geminiLastWordEnd.rec07Channel0, fixture.rec07Channel0, 0, 426)
    expect(reason).toMatch(/voice continues to 6:3\d/)
  })

  it('works on the recording timeline for a span that does not start at zero', () => {
    const voice = [{ start: 1000, end: 1100 }, { start: 1150, end: 1300 }]
    expect(speechCoverageShortfall(1295, voice, 990, 1310)).toBeNull()
    expect(speechCoverageShortfall(1090, voice, 990, 1310)).toMatch(/text ends at 18:10/)
  })

  it('under five seconds of voice is never incomplete', () => {
    expect(speechCoverageShortfall(null, [{ start: 10, end: 14 }], 0, 426)).toBeNull()
  })
})

describe('planSpeechSpans: only the stretches with voice are sent', () => {
  it('a channel with no voice plans no request', () => {
    expect(planSpeechSpans([], 3600)).toEqual([])
  })

  it('pads each run, keeps short silences inside a span and skips long ones', () => {
    const spans = planSpeechSpans([{ start: 10, end: 20 }, { start: 25, end: 40 }, { start: 200, end: 210 }], 3600)
    expect(spans).toEqual([{ start: 9.5, end: 40.5 }, { start: 199.5, end: 210.5 }])
  })

  it('never passes the cap, and cuts one long monologue into equal pieces', () => {
    const spans = planSpeechSpans([{ start: 0, end: 3000 }], 3000, { maxSpanSeconds: 1200 })
    expect(spans).toHaveLength(3)
    expect(spans.every((s) => s.end - s.start <= 1200)).toBe(true)
    expect(spans[0].start).toBe(0)
    expect(spans.at(-1)!.end).toBe(3000)
  })

  it('packs a whole conversation into few requests (Rec07 channel 0: 105 voice runs)', () => {
    const spans = planSpeechSpans(fixture.rec07Channel0, 426)
    expect(spans.length).toBeLessThanOrEqual(4)
    // Everything with voice is inside some span.
    for (const v of fixture.rec07Channel0) {
      expect(spans.some((s: { start: number; end: number }) => s.start <= v.start && s.end >= v.end)).toBe(true)
    }
    // And it sends less audio than the chunk.
    const sent = spans.reduce((t: number, s: { start: number; end: number }) => t + s.end - s.start, 0)
    expect(sent).toBeLessThan(426)
  })

  it('clips to the audio and ignores broken intervals', () => {
    expect(normalizeIntervals([{ start: -5, end: 3 }, { start: 8, end: 4 }, { start: 2, end: 6 }, { start: NaN, end: 1 }], 5))
      .toEqual([{ start: 0, end: 5 }])
  })
})

describe('voice measures', () => {
  it('counts seconds and finds the last voice inside a window', () => {
    const voice = [{ start: 0, end: 10 }, { start: 20, end: 30 }]
    expect(speechSecondsIn(voice, 5, 25)).toBe(10)
    expect(lastSpeechEndIn(voice, 0, 25)).toBe(25)
    expect(lastSpeechEndIn(voice, 11, 19)).toBeNull()
  })
})

describe('groupWordsIntoLines: lines keep the time of their words', () => {
  const join = (text: string, word: string) => (text ? `${text} ${word}` : word)
  const words = (pairs: Array<[number, number, string]>, speaker = 'Speaker 1') =>
    pairs.map(([startTime, endTime, text]) => ({ startTime, endTime, text, speaker }))

  it('one speaker no longer means one line per chunk: a pause starts a new line (Rec14: 29 lines for 82 minutes)', () => {
    const lines = groupWordsIntoLines(words([[0, 0.4, 'Hola,'], [0.5, 0.9, 'Diego.'], [3, 3.3, '¿Cómo'], [3.4, 3.8, 'estás?']]), join)
    expect(lines.map((l) => [l.text, l.startTime, l.endTime])).toEqual([['Hola, Diego.', 0, 0.9], ['¿Cómo estás?', 3, 3.8]])
  })

  it('a line never passes the cap even without pauses', () => {
    const steady = Array.from({ length: 200 }, (_, i) => [i * 0.5, i * 0.5 + 0.45, 'palabra'] as [number, number, string])
    const lines = groupWordsIntoLines(words(steady), join, { maxLineSeconds: 30 })
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.every((l) => l.endTime - l.startTime <= 30)).toBe(true)
  })

  it('a speaker change still starts a line', () => {
    const lines = groupWordsIntoLines([...words([[0, 0.4, 'Sí.']], 'A'), ...words([[0.5, 0.9, 'No.']], 'B')], join)
    expect(lines.map((l) => l.speaker)).toEqual(['A', 'B'])
  })
})

describe('sliceWavSpan', () => {
  const wav = (seconds: number, rate = 16000) => {
    const body = Buffer.alloc(seconds * rate * 2)
    for (let i = 0; i < seconds * rate; i++) body.writeInt16LE(i % 32000, i * 2)
    const h = Buffer.alloc(44)
    h.write('RIFF', 0); h.writeUInt32LE(36 + body.length, 4); h.write('WAVEfmt ', 8)
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
    h.write('data', 36); h.writeUInt32LE(body.length, 40)
    return Buffer.concat([h, body])
  }

  it('cuts a standalone WAV on frame boundaries', () => {
    const piece = sliceWavSpan(wav(10), 2, 3.5)!
    expect(piece.toString('ascii', 0, 4)).toBe('RIFF')
    expect(piece.readUInt32LE(40)).toBe(1.5 * 16000 * 2)
    // First sample of the piece is sample 32000 of the source.
    expect(piece.readInt16LE(44)).toBe(32000 % 32000)
  })

  it('returns null for anything that is not PCM WAV', () => {
    expect(sliceWavSpan(Buffer.from('ID3 not a wav at all, padding padding padding'), 0, 1)).toBeNull()
    expect(sliceWavSpan(wav(1), 5, 6)).toBeNull()
  })
})
