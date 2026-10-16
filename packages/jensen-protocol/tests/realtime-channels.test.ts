import { describe, expect, it } from 'vitest'
import { parseRealtimePayload } from '../src/jensen-device.js'
import { REALTIME_CHANNEL_IDS, splitRealtimeChannelsTap } from '../src/realtime-channels.js'

function body(metadata: number[], frames: Array<[number, number]>, trailing: number[] = []): Uint8Array {
  const out = new Uint8Array(8 + frames.length * 4 + trailing.length)
  out.set(metadata, 0)
  const view = new DataView(out.buffer)
  frames.forEach(([a, b], i) => {
    view.setInt16(8 + i * 4, a, true)
    view.setInt16(8 + i * 4 + 2, b, true)
  })
  out.set(trailing, 8 + frames.length * 4)
  return out
}

const META = [0, 0, 1, 0, 0, 0, 0, 1] // sequenceMinusOne 256, microphone muted

describe('splitRealtimeChannelsTap', () => {
  it('keeps the 8 metadata bytes out of the samples and reports them as metadata', () => {
    const packet = parseRealtimePayload(body(META, [[1, 2], [3, 4]]))!
    const tap = splitRealtimeChannelsTap(packet)!
    expect(tap.sequenceMinusOne).toBe(256)
    expect(tap.microphoneMuted).toBe(true)
    expect(tap.frameCount).toBe(2)
    expect(Array.from(tap.channels[0].pcm)).toEqual([1, 0, 3, 0])
    expect(Array.from(tap.channels[1].pcm)).toEqual([2, 0, 4, 0])
  })

  it('preserves signed extrema and little-endian byte order byte for byte', () => {
    const packet = parseRealtimePayload(body(META, [[-32768, 32767], [32767, -32768], [-1, 0x0102]]))!
    const tap = splitRealtimeChannelsTap(packet)!
    expect(Array.from(tap.channels[0].pcm)).toEqual([0x00, 0x80, 0xff, 0x7f, 0xff, 0xff])
    expect(Array.from(tap.channels[1].pcm)).toEqual([0xff, 0x7f, 0x00, 0x80, 0x02, 0x01])
    const view = new DataView(tap.channels[0].pcm.buffer)
    expect(view.getInt16(0, true)).toBe(-32768)
    expect(view.getInt16(2, true)).toBe(32767)
  })

  it('aligns on whole frames and reports the dropped trailing bytes', () => {
    const packet = parseRealtimePayload(body(META, [[10, 20], [30, 40]], [0xaa, 0xbb, 0xcc]))!
    const tap = splitRealtimeChannelsTap(packet)!
    expect(tap.frameCount).toBe(2)
    expect(tap.droppedTrailingBytes).toBe(3)
    expect(tap.channels[0].pcm.length).toBe(4)
    expect(tap.channels[1].pcm.length).toBe(4)
  })

  it('returns two independent buffers and leaves the original packet untouched', () => {
    const packet = parseRealtimePayload(body(META, [[5, 6]]))!
    const before = Array.from(packet.data)
    const tap = splitRealtimeChannelsTap(packet)!
    expect(tap.channels[0].pcm.buffer).not.toBe(tap.channels[1].pcm.buffer)
    expect(tap.channels[0].pcm.buffer).not.toBe(packet.data.buffer)
    tap.channels[0].pcm[0] = 0xff
    expect(Array.from(packet.data)).toEqual(before)
    expect(tap.channels[1].pcm[0]).toBe(6)
  })

  it('reads a packet whose data is a view at a nonzero byte offset', () => {
    const raw = body(META, [[7, 8]])
    const shifted = new Uint8Array(raw.length + 3)
    shifted.set(raw, 3)
    const tap = splitRealtimeChannelsTap({ rest: 0, muted: false, data: shifted.subarray(3) })!
    expect(Array.from(tap.channels[0].pcm)).toEqual([7, 0])
    expect(Array.from(tap.channels[1].pcm)).toEqual([8, 0])
  })

  it('uses neutral ids and labels the 16 kHz rate as a host expectation', () => {
    const tap = splitRealtimeChannelsTap(parseRealtimePayload(body(META, [[1, 1]]))!)!
    expect(tap.channels.map((channel) => channel.id)).toEqual([...REALTIME_CHANNEL_IDS])
    expect(tap.sampleRateHz).toBe(16000)
    expect(tap.sampleRateEvidence).toBe('host-expectation')
  })

  it('returns null for metadata-only, short and non-byte data, and does not throw', () => {
    expect(splitRealtimeChannelsTap({ rest: 0, muted: false, data: new Uint8Array(8) })).toBeNull()
    expect(splitRealtimeChannelsTap({ rest: 0, muted: false, data: new Uint8Array(11) })).toBeNull()
    expect(splitRealtimeChannelsTap({ rest: 0, muted: false, data: new Uint8Array(0) })).toBeNull()
    expect(splitRealtimeChannelsTap({ rest: 0, muted: false, data: [1, 2, 3] as unknown as Uint8Array })).toBeNull()
  })

  it('falls back to the legacy rest/muted fields when the exact fields are absent', () => {
    const tap = splitRealtimeChannelsTap({ rest: 9, muted: true, data: new Uint8Array(12) })!
    expect(tap.sequenceMinusOne).toBe(9)
    expect(tap.microphoneMuted).toBe(true)
  })
})
