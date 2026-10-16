/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { DeviceAudioDiagnostics } from '../device-audio-diagnostics'

function packet(samples: number[], muted = false) {
  const data = Buffer.alloc(8 + samples.length * 2)
  samples.forEach((sample, index) => data.writeInt16LE(sample, 8 + index * 2))
  return { data: new Uint8Array(data), muted, rest: 0 }
}

describe('device audio measurements without invented source labels', () => {
  it('preserves neutral IDs, sample clock, raw muted measurements and clipping counts', () => {
    const observer = new DeviceAudioDiagnostics()
    observer.observe(packet([32767, 0, -32768, 1000], true), 10)
    observer.observe(packet([1000, 2000]), 35)
    const snapshot = observer.snapshot()
    expect(snapshot).toMatchObject({ packets: 2, acceptedPackets: 2, mutedPackets: 1, frames: 3,
      sampleElapsedMs: 3 / 16, maximumArrivalGapMs: 25, sourceIsolation: 'unverified',
      format: { provenance: 'host-expectation', physicalSourceMapping: 'unverified' } })
    expect(snapshot.channelIds).toEqual(['channel-0', 'channel-1'])
    expect(snapshot.channels[0].clippedSamples).toBe(2)
    expect(snapshot.channels[1].clippedSamples).toBe(0)
    expect(snapshot.channels[0].peak).toBe(1)
  })

  it('rejects incomplete frames and bounds gap details through long invalid runs', () => {
    const observer = new DeviceAudioDiagnostics()
    for (let n = 0; n < 200; n++) expect(observer.observe(packet([1]))).toBe(false)
    expect(observer.snapshot()).toMatchObject({ frames: 0, rejectedPackets: 200, discontinuityCount: 200, droppedDiscontinuityDetails: 136 })
    expect(observer.snapshot().discontinuities).toHaveLength(64)
    observer.reset()
    expect(observer.snapshot().packets).toBe(0)
  })

  it('returns null for silence and measures delayed known signals', () => {
    const observer = new DeviceAudioDiagnostics()
    observer.observe(packet(new Array(128).fill(0)))
    expect(observer.snapshot().correlation).toBeNull()
    expect(observer.snapshot().windowDelay).toBeNull()
    observer.reset()
    let seed = 0x12345
    const left = Array.from({ length: 3000 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed % 20001) - 10000 })
    const stereo = left.flatMap((value, index) => [value, index >= 7 ? left[index - 7] : 0])
    observer.observe(packet(stereo))
    const delay = observer.snapshot().windowDelay
    expect(delay?.frames).toBe(7)
    expect(delay?.correlation).toBeCloseTo(1)
    expect(delay?.windowFrames).toBe(2048)
  })
})
