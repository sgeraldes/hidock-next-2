// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { liveStereoToMono } from '../live-pcm'
function packet() {
  const data = new Uint8Array(16), view = new DataView(data.buffer)
  view.setInt16(10, 3000, true); view.setInt16(14, -1000, true)
  return { data, rest: 1, muted: true }
}
describe('live PCM command metadata semantics', () => {
  it('preserves lane B during qualified microphone mute for remote ASR input', () => {
    const mono = liveStereoToMono({ ...packet(), sequenceMinusOne: 1, microphoneMuted: true })
    expect(mono.readInt16LE(0)).toBe(1500)
    expect(mono.readInt16LE(2)).toBe(-500)
  })
  it('retains the unqualified legacy mute interpretation', () => {
    expect(liveStereoToMono(packet())).toEqual(Buffer.alloc(4))
  })
  it('refuses a partial stereo frame', () => {
    expect(() => liveStereoToMono({ ...packet(), data: new Uint8Array(15) })).toThrow('incomplete')
  })
})
