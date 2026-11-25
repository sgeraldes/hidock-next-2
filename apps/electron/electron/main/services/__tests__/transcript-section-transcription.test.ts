import { existsSync } from 'fs'
import { dirname } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SECTION_SECONDS, sectionBounds, sectionSegments, transcribeSection } from '../transcript-section-transcription'

describe('transcribing one section again (mock provider, never a paid call)', () => {
  it('cuts the padded window, transcribes it once, and moves the lines to the recording clock', async () => {
    let slicePath = ''
    const extract = vi.fn(async (_path: string, _start: number, _seconds: number, out: string) => { slicePath = out })
    const transcribe = vi.fn(async () => ({
      fullText: 'uno dos',
      speakers: JSON.stringify([{ start: 0.5, end: 2, text: ' ciento veinte horas ', speaker: 'A' }, { start: 3, end: 40, text: 'fin', speaker: 'B' }, { start: 4, text: '  ' }])
    }))
    const bounds = sectionBounds(3343.7, 3361.3, 5119)
    expect(bounds).toEqual({ start: 3342.7, seconds: expect.closeTo(19.6, 5) })
    const lines = await transcribeSection('C:/audio/rec28.hda', bounds, { extract, transcribe })
    expect(extract).toHaveBeenCalledWith('C:/audio/rec28.hda', 3342.7, bounds.seconds, slicePath)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([
      { start: 3343.2, end: expect.closeTo(3344.7, 5), text: 'ciento veinte horas', speaker: 'Section / A' },
      { start: expect.closeTo(3345.7, 5), end: expect.closeTo(3342.7 + bounds.seconds, 5), text: 'fin', speaker: 'Section / B' }
    ])
    expect(existsSync(dirname(slicePath))).toBe(false)
  })

  it('removes its temporary folder when the provider fails, and passes the failure on', async () => {
    let slicePath = ''
    await expect(transcribeSection('a.wav', { start: 0, seconds: 10 }, {
      extract: async (_p, _s, _n, out) => { slicePath = out },
      transcribe: async () => { throw new Error('quota exceeded') }
    })).rejects.toThrow('quota exceeded')
    expect(existsSync(dirname(slicePath))).toBe(false)
  })

  it('refuses an unknown window and one too long to be a section', () => {
    expect(() => sectionBounds(10, 10, null)).toThrow(/unknown/)
    expect(() => sectionBounds(0, MAX_SECTION_SECONDS + 60, null)).toThrow(/whole recording/)
  })

  it('an answer with no speech is an error, never an empty replacement', () => {
    expect(() => sectionSegments({ fullText: '', speakers: '[]' }, 0, 10)).toThrow(/no speech/)
    expect(sectionSegments({ fullText: 'solo texto' }, 5, 10)).toEqual([{ start: 5, end: 15, text: 'solo texto' }])
  })
})
