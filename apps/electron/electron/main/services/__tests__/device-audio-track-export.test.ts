/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportDeviceAudioTracks, inspectDeviceAudioWav } from '../device-audio-track-export'
import { wavHeader } from '../realtime-recorder'

let folder: string
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'device-tracks-')) })
afterEach(() => { rmSync(folder, { recursive: true, force: true }) })

function writeStereo(samples: number[]): string {
  const source = join(folder, 'source.wav')
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2))
  writeFileSync(source, Buffer.concat([wavHeader(data.length), data]))
  return source
}

describe('actual PCM16 WAV track export', () => {
  it('derives exact duration from PCM frames without reading or modifying sample bytes', async () => {
    const source = writeStereo(Array(32002).fill(0)), original = readFileSync(source)
    expect(await inspectDeviceAudioWav(source)).toEqual({ sampleRate: 16000, channels: 2, frames: 16001, seconds: 16001 / 16000, durationMs: 1000 })
    expect(readFileSync(source)).toEqual(original)
    expect(readdirSync(folder)).toEqual(['source.wav'])
  })

  it('bounds metadata traversal and rejects partial PCM frames for duration inspection', async () => {
    const source = writeStereo([1, 2])
    const header = readFileSync(source).subarray(0, 44)
    const emptyChunks = Buffer.alloc(8 * 4096)
    for (let offset = 0; offset < emptyChunks.length; offset += 8) emptyChunks.write('JUNK', offset)
    const longMetadata = Buffer.concat([header.subarray(0, 12), emptyChunks, header.subarray(12), Buffer.alloc(4)])
    longMetadata.writeUInt32LE(longMetadata.length - 8, 4)
    writeFileSync(source, longMetadata)
    await expect(inspectDeviceAudioWav(source)).rejects.toThrow('chunk limit')
    const partial = Buffer.concat([header, Buffer.alloc(3)])
    partial.writeUInt32LE(partial.length - 8, 4); partial.writeUInt32LE(3, 40)
    writeFileSync(source, partial)
    await expect(inspectDeviceAudioWav(source)).rejects.toThrow()
  })
  it('deinterleaves more than one chunk without changing source or track sample clocks', async () => {
    const input = Array.from({ length: 50000 }, (_, index) => (index % 2 ? -1 : 1) * (index % 16000))
    const source = writeStereo(input), original = readFileSync(source)
    const result = await exportDeviceAudioTracks(source, folder)
    expect(result).toMatchObject({ frames: 25000, sampleRate: 16000, seconds: 25000 / 16000, physicalSourceMapping: 'unverified' })
    for (const track of result.tracks) {
      const data = readFileSync(track.path)
      expect(data.readUInt16LE(22)).toBe(1)
      expect(data.readUInt32LE(40)).toBe(50000)
      for (let index = 0; index < 25000; index++) expect(data.readInt16LE(44 + index * 2)).toBe(input[index * 2 + track.channelIndex])
    }
    expect(readFileSync(source)).toEqual(original)
  })

  it('supports synchronized multichannel PCM and skips odd padded unknown chunks', async () => {
    const header = wavHeader(12)
    header.writeUInt16LE(3, 22); header.writeUInt16LE(6, 32); header.writeUInt32LE(96000, 28)
    const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 99, 0])
    header.writeUInt32LE(36 + 12 + junk.length, 4)
    const samples = Buffer.alloc(12)
    ;[1, 2, 3, 4, 5, 6].forEach((value, index) => samples.writeInt16LE(value, index * 2))
    const source = join(folder, 'three.wav')
    writeFileSync(source, Buffer.concat([header.subarray(0, 36), junk, header.subarray(36), samples]))
    const result = await exportDeviceAudioTracks(source, folder)
    expect(result.tracks).toHaveLength(3)
    expect(result.frames).toBe(2)
    expect(result.tracks.map((track) => readFileSync(track.path).readInt16LE(46))).toEqual([4, 5, 6])
  })

  it('never clobbers existing exports and cleans up only its own newly created files', async () => {
    const source = writeStereo([1, 2])
    const occupied = join(folder, 'source.channel-1.wav')
    writeFileSync(occupied, 'keep')
    await expect(exportDeviceAudioTracks(source, folder)).rejects.toThrow()
    expect(readFileSync(occupied, 'utf8')).toBe('keep')
    expect(readdirSync(folder).sort()).toEqual(['source.channel-1.wav', 'source.wav'])
  })

  it('rejects malformed bounds, unsupported codecs and partial frames before producing files', async () => {
    const source = writeStereo([1, 2])
    const original = readFileSync(source)
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt32LE(1000, 4),
      (bytes: Buffer) => bytes.writeUInt16LE(3, 20),
      (bytes: Buffer) => bytes.writeUInt16LE(99, 22),
      (bytes: Buffer) => bytes.writeUInt32LE(3, 40)
    ]) {
      const bytes = Buffer.from(original); mutate(bytes); writeFileSync(source, bytes)
      await expect(exportDeviceAudioTracks(source, folder)).rejects.toThrow()
      expect(readdirSync(folder)).toEqual(['source.wav'])
    }
  })

  it('reports destination errors without modifying the source', async () => {
    const source = writeStereo([1, 2]), original = readFileSync(source)
    await expect(exportDeviceAudioTracks(source, join(folder, 'missing'))).rejects.toThrow()
    expect(readFileSync(source)).toEqual(original)
  })
})
