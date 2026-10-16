/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
vi.mock('../database', () => ({ getRecordingById: vi.fn() }))
import { getRecordingAudioMetadata } from '../recording-audio-metadata'
import { parseAudioHeaderPrefix, readAudioHeaderMetadata, type AudioHeaderMetadata } from '../audio-header-metadata'

const unknown = parseAudioHeaderPrefix(new Uint8Array(), 0)
const metadata: AudioHeaderMetadata = {
  ...unknown.fields, status: unknown.status, statusReason: unknown.statusReason, byteLength: 0,
  source: { sizeBytes: 0, mtimeNs: '1' },
  io: { maxPrefixBytes: 65536, prefixBytesRequested: 0, prefixBytesRead: 0,
    readCalls: 0, handleOpened: true, handleClosed: true }
}

describe('selected Library audio metadata boundary', () => {
  it('does not report PCM duration for legacy RIFF containing corroborated MPEG frames', () => {
    const bytes = Buffer.alloc(44 + 576)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(64000, 28)
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(576, 40)
    Buffer.from([0xff, 0xf3, 0x88, 0xc0]).copy(bytes, 44)
    Buffer.from([0xff, 0xf3, 0x88, 0xc0]).copy(bytes, 44 + 288)
    const result = parseAudioHeaderPrefix(bytes, bytes.length)
    expect(result.fields.container).toMatchObject({ known: true, value: 'riff-wave' })
    expect(result.fields.codec).toMatchObject({ known: true, value: 'mp3' })
    expect(result.fields.channelCount).toMatchObject({ known: true, value: 1 })
    expect(result.fields.nominalBitrateBps).toMatchObject({ known: true, value: 64000 })
    expect(result.fields.bitDepth.known).toBe(false)
    expect(result.fields.durationMs.known).toBe(false)
  })
  it('returns physical stereo WAV facts for an actual short file named .hda', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-audio-facts-'))
    const file = join(directory, 'synthetic.hda')
    const bytes = Buffer.alloc(2092)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(2084, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(64000, 28)
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(2048, 40)
    // The cleanup below removes this directory recursively: refuse anything but our own temp dir.
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('hidock-audio-facts-')) {
      throw new Error('Unexpected synthetic fixture cleanup path')
    }
    try {
      await writeFile(file, bytes)
      const result = await getRecordingAudioMetadata('short-audio', {
        getRecording: () => ({ file_path: file }), readHeader: readAudioHeaderMetadata
      })
      expect(result.success).toBe(true)
      expect(result.data?.byteLength).toBe(2092)
      expect(result.data?.container).toMatchObject({ known: true, value: 'riff-wave' })
      expect(result.data?.durationMs).toMatchObject({ known: true, value: 32 })
      expect(result.data?.channelCount).toMatchObject({ known: true, value: 2 })
      expect(result.data?.nominalBitrateBps).toMatchObject({ known: true, value: 512000 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('rejects arbitrary paths and missing rows before opening a file', async () => {
    const readHeader = vi.fn().mockResolvedValue(metadata)
    const getRecording = vi.fn().mockReturnValue(undefined)
    expect((await getRecordingAudioMetadata('C:/private.wav', { getRecording, readHeader })).success).toBe(false)
    expect((await getRecordingAudioMetadata('missing-id', { getRecording, readHeader })).success).toBe(false)
    expect(readHeader).not.toHaveBeenCalled()
  })
  it('refuses to publish facts when the recording is purged during the header read', async () => {
    const getRecording = vi.fn().mockReturnValueOnce({ file_path: '/owned.wav' }).mockReturnValueOnce(undefined)
    expect((await getRecordingAudioMetadata('id', {
      getRecording, readHeader: vi.fn().mockResolvedValue(metadata)
    })).success).toBe(false)
  })
  it('refuses a replaced path and preserves unknown facts for a current file', async () => {
    const changed = vi.fn().mockReturnValueOnce({ file_path: '/owned.wav' })
      .mockReturnValueOnce({ file_path: '/replacement.wav' })
    expect((await getRecordingAudioMetadata('id', {
      getRecording: changed, readHeader: vi.fn().mockResolvedValue(metadata)
    })).success).toBe(false)
    const result = await getRecordingAudioMetadata('id', {
      getRecording: () => ({ file_path: '/owned.wav' }), readHeader: vi.fn().mockResolvedValue(metadata)
    })
    expect(result.success).toBe(true)
    expect(result.data?.durationMs.known).toBe(false)
    expect(result.data).not.toHaveProperty('source')
    expect(result.data).not.toHaveProperty('io')
  })
})
