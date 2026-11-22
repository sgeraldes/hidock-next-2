import { open, unlink } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { basename, join } from 'path'
import { readAudioDuration } from './audio-duration'

export interface DeviceAudioTrackExport {
  sampleRate: number
  frames: number
  seconds: number
  tracks: Array<{ channelId: string; channelIndex: number; path: string }>
  physicalSourceMapping: 'unverified'
}

async function readExact(file: FileHandle, bytes: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes)
  let offset = 0
  while (offset < bytes) {
    const result = await file.read(buffer, offset, bytes - offset, position + offset)
    if (!result.bytesRead) throw new Error('Truncated WAV file')
    offset += result.bytesRead
  }
  return buffer
}

async function writeAll(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset, position + offset)
    if (!result.bytesWritten) throw new Error('Could not write exported track')
    offset += result.bytesWritten
  }
}

function monoHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40)
  return header
}

interface Pcm16WavLayout {
  original: { size: number; mtimeMs: number }
  format: { channels: number; rate: number; align: number }
  data: { position: number; bytes: number }
  frames: number
}

/** Bounded metadata inspection shared by duration resolution and channel export. */
async function readPcm16WavLayout(source: FileHandle, sourcePath: string): Promise<Pcm16WavLayout> {
  const original = await source.stat()
  if (!original.isFile()) throw new Error('Source is not a regular WAV file')
  const header = await readExact(source, 12, 0)
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a RIFF WAV file')
  const end = header.readUInt32LE(4) + 8
  if (end > original.size || end < 12) throw new Error('Invalid WAV container size')
  let format: Pcm16WavLayout['format'] | null = null
  let data: Pcm16WavLayout['data'] | null = null
  let chunks = 0
  for (let position = 12; position < end;) {
    if (++chunks > 4096) throw new Error('WAV metadata chunk limit exceeded')
    if (end - position < 8) throw new Error('Truncated WAV chunk header')
    const chunk = await readExact(source, 8, position)
    const id = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4)
    const next = position + 8 + length + (length % 2)
    if (next > end) throw new Error('WAV chunk exceeds container bounds')
    if (id === 'fmt ') {
      if (format || length < 16) throw new Error('Invalid or duplicate WAV format chunk')
      const fmt = await readExact(source, 16, position + 8)
      const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), align = fmt.readUInt16LE(12)
      if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error('Only uncompressed PCM16 WAV is supported')
      if (channels < 1 || channels > 32 || !rate || rate > 384000 || align !== channels * 2 || fmt.readUInt32LE(8) !== rate * align) throw new Error('Invalid WAV sample format')
      format = { channels, rate, align }
    } else if (id === 'data') {
      if (data) throw new Error('Duplicate WAV data chunk')
      data = { position: position + 8, bytes: length }
    }
    position = next
  }
  if (!format || !data || data.bytes % format.align) throw new Error('Missing WAV format/data or incomplete PCM frame')
  // Legacy HiDock RIFF files can declare PCM while carrying actual MPEG frames.
  // Deinterleaving those bytes would manufacture noisy tracks and a false duration.
  if (readAudioDuration(sourcePath)?.how.startsWith('mpeg ')) throw new Error('Compressed MPEG payload is not PCM16 WAV; decode before channel export')
  const final = await source.stat()
  if (final.size !== original.size || final.mtimeMs !== original.mtimeMs) throw new Error('Source WAV changed during inspection')
  return { original, format, data, frames: data.bytes / format.align }
}

/** Derives time from validated PCM frame count, never capture-manifest timing or a decoder guess. */
export async function inspectDeviceAudioWav(sourcePath: string): Promise<{ sampleRate: number; channels: number; frames: number; seconds: number; durationMs: number }> {
  const source = await open(sourcePath, 'r')
  try {
    const { format, frames } = await readPcm16WavLayout(source, sourcePath)
    return { sampleRate: format.rate, channels: format.channels, frames, seconds: frames / format.rate, durationMs: Math.floor(frames * 1000 / format.rate) }
  } finally { await source.close() }
}

/** Parent resolves source and destination through trusted file selection, never arbitrary renderer paths.
 * PCM16 samples are deinterleaved without resampling; all channels share exactly the same frame clock.
 * Outputs use exclusive creation. Only files created by this call are removed on failure. */
export async function exportDeviceAudioTracks(sourcePath: string, outputDirectory: string): Promise<DeviceAudioTrackExport> {
  const source = await open(sourcePath, 'r')
  const outputs: Array<{ file: FileHandle; path: string }> = []
  let succeeded = false
  try {
    const { original, format, data, frames } = await readPcm16WavLayout(source, sourcePath)
    const stem = basename(sourcePath).replace(/\.wav$/i, '')
    for (let channel = 0; channel < format.channels; channel++) {
      const path = join(outputDirectory, `${stem}.channel-${channel}.wav`)
      const file = await open(path, 'wx')
      outputs.push({ file, path })
      await writeAll(file, monoHeader(format.rate, frames * 2), 0)
    }
    const chunkFrames = Math.max(1, Math.floor(65536 / format.align))
    for (let frame = 0; frame < frames; frame += chunkFrames) {
      const count = Math.min(chunkFrames, frames - frame)
      const input = await readExact(source, count * format.align, data.position + frame * format.align)
      for (let channel = 0; channel < format.channels; channel++) {
        const mono = Buffer.alloc(count * 2)
        for (let index = 0; index < count; index++) mono.writeInt16LE(input.readInt16LE(index * format.align + channel * 2), index * 2)
        await writeAll(outputs[channel].file, mono, 44 + frame * 2)
      }
    }
    const final = await source.stat()
    if (final.size !== original.size || final.mtimeMs !== original.mtimeMs) throw new Error('Source WAV changed during export')
    for (const output of outputs) await output.file.sync()
    succeeded = true
    return { sampleRate: format.rate, frames, seconds: frames / format.rate, physicalSourceMapping: 'unverified',
      tracks: outputs.map((output, channelIndex) => ({ channelId: `channel-${channelIndex}`, channelIndex, path: output.path })) }
  } finally {
    try {
      await source.close()
    } finally {
      for (const output of outputs) {
        await output.file.close().catch(() => undefined)
        if (!succeeded) await unlink(output.path).catch(() => undefined)
      }
    }
  }
}
