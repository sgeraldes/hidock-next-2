import { existsSync } from 'fs'
import { dirname } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SECTION_SECONDS, sectionBounds, sectionSegments, transcribeSection } from '../transcript-section-transcription'

const window = { start: 3343.7, end: 3361.3 }

describe('transcribing one section again (mock provider, never a paid call)', () => {
  it('cuts the padded window, transcribes it once, and moves the lines to the recording clock', async () => {
    let slicePath = ''
    const extract = vi.fn(async (_path: string, _start: number, _seconds: number, out: string) => { slicePath = out })
    const transcribe = vi.fn(async () => ({
      fullText: 'uno dos',
      speakers: JSON.stringify([{ start: 1.5, end: 3, text: ' ciento veinte horas ', speaker: 'A' }, { start: 4, end: 40, text: 'fin', speaker: 'B' }, { start: 5, text: '  ' }])
    }))
    const bounds = sectionBounds(window.start, window.end, 5119)
    expect(bounds).toEqual({ start: 3342.7, seconds: expect.closeTo(19.6, 5) })
    const lines = await transcribeSection('C:/audio/rec28.hda', bounds, { extract, transcribe }, { window, label: 'Section 1a2b3c4d' })
    expect(extract).toHaveBeenCalledWith('C:/audio/rec28.hda', 3342.7, bounds.seconds, slicePath)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([
      { start: expect.closeTo(3344.2, 5), end: expect.closeTo(3345.7, 5), text: 'ciento veinte horas', speaker: 'Section 1a2b3c4d / A' },
      { start: expect.closeTo(3346.7, 5), end: window.end, text: 'fin', speaker: 'Section 1a2b3c4d / B' }
    ])
    expect(existsSync(dirname(slicePath))).toBe(false)
  })

  it('keeps only what falls in the flagged window: the padding can hold a neighbour line (CodeRabbit review of #195)', () => {
    const bounds = { start: 99, seconds: 12 }
    const lines = sectionSegments({ fullText: '', speakers: JSON.stringify([
      { start: 0, end: 0.8, text: 'the neighbour before', speaker: 'A' },
      { start: 0.5, end: 3, text: 'crosses the start', speaker: 'A' },
      { start: 4, end: 6, text: 'inside', speaker: 'B' },
      { start: 11.2, end: 12, text: 'the neighbour after', speaker: 'A' }
    ]) }, bounds, { window: { start: 100, end: 110 }, label: 'Section x' })
    expect(lines.map((l) => [l.text, l.start, l.end])).toEqual([['crosses the start', 100, 102], ['inside', 103, 105]])
  })

  it('names the voices of each section run apart, so one run\'s speaker assignment never reaches another', () => {
    const result = { fullText: '', speakers: JSON.stringify([{ start: 1, end: 2, text: 'hola', speaker: 'Speaker 1' }]) }
    const a = sectionSegments(result, { start: 0, seconds: 5 }, { window: { start: 0, end: 5 }, label: 'Section aaaa' })
    const b = sectionSegments(result, { start: 0, seconds: 5 }, { window: { start: 0, end: 5 }, label: 'Section bbbb' })
    expect(a[0].speaker).not.toBe(b[0].speaker)
  })

  it('removes its temporary folder when the provider fails, and passes the failure on', async () => {
    let slicePath = ''
    await expect(transcribeSection('a.wav', { start: 0, seconds: 10 }, {
      extract: async (_p, _s, _n, out) => { slicePath = out },
      transcribe: async () => { throw new Error('quota exceeded') }
    }, { window: { start: 0, end: 10 }, label: 'Section x' })).rejects.toThrow('quota exceeded')
    expect(existsSync(dirname(slicePath))).toBe(false)
  })

  it('refuses an unknown window and one too long to be a section', () => {
    expect(() => sectionBounds(10, 10, null)).toThrow(/unknown/)
    expect(() => sectionBounds(0, MAX_SECTION_SECONDS + 60, null)).toThrow(/whole recording/)
  })

  it('an answer with no speech in the window is an error, never an empty replacement', () => {
    const options = { window: { start: 5, end: 15 }, label: 'Section x' }
    expect(() => sectionSegments({ fullText: '', speakers: '[]' }, { start: 4, seconds: 12 }, options)).toThrow(/no speech/)
    expect(sectionSegments({ fullText: 'solo texto' }, { start: 4, seconds: 12 }, options)).toEqual([{ start: 5, end: 15, text: 'solo texto' }])
  })
})
