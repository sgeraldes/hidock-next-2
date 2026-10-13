// @vitest-environment node

/**
 * Unit tests for saveRecording's atomic write + cancellation cleanup (Phase-1).
 *
 * Uses a REAL temporary recordings directory (config is mocked to point at it) so we
 * exercise the actual writeFileSync → rename path and can assert on files on disk.
 *
 * Verifies:
 *  - a normal save produces the final file and leaves NO `.partial` temp behind
 *  - a cancel between staging and rename produces NO final file and cleans the temp
 *  - a cancel never deletes a pre-existing valid recording (collision → suffix)
 *  - a write failure cleans up the temp and rethrows
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let recordingsDir: string

vi.mock('../config', () => ({
  getConfig: () => ({ storage: { recordingsPath: recordingsDir, transcriptsPath: join(recordingsDir, '..', 'transcripts') } }),
  getDataPath: () => recordingsDir,
}))

import { saveRecording } from '../file-storage'

describe('saveRecording — atomic write + cancellation cleanup', () => {
  beforeEach(() => {
    recordingsDir = mkdtempSync(join(tmpdir(), 'hidock-atomic-'))
  })

  afterEach(() => {
    rmSync(recordingsDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const partials = () => readdirSync(recordingsDir).filter((f) => f.includes('.partial'))

  it('writes the final file and leaves no .partial temp behind', async () => {
    const data = Buffer.from('hello world')
    const filePath = await saveRecording('2025Dec15-100105-Rec22.hda', data)

    expect(filePath).toBe(join(recordingsDir, '2025Dec15-100105-Rec22.wav'))
    expect(existsSync(filePath as string)).toBe(true)
    expect(readFileSync(filePath as string)).toEqual(data)
    expect(partials()).toHaveLength(0)
  })

  it('cancels between staging and rename: no final file, temp cleaned up, returns null', async () => {
    const data = Buffer.from('abc')
    const result = await saveRecording('rec.hda', data, undefined, undefined, {
      isCancelled: () => true, // cancel fires right after the temp is written
    })

    expect(result).toBeNull()
    expect(existsSync(join(recordingsDir, 'rec.wav'))).toBe(false)
    expect(partials()).toHaveLength(0) // temp cleaned up
    expect(readdirSync(recordingsDir)).toHaveLength(0)
  })

  it('never deletes a pre-existing valid recording on cancel (collision → suffix)', async () => {
    // Pre-existing valid recording at the target name.
    const existingPath = join(recordingsDir, 'rec.wav')
    writeFileSync(existingPath, Buffer.from('ORIGINAL'))

    // A cancelled save for the same device file must NOT touch the original.
    const result = await saveRecording('rec.hda', Buffer.from('NEW'), undefined, undefined, {
      isCancelled: () => true,
    })

    expect(result).toBeNull()
    expect(existsSync(existingPath)).toBe(true)
    expect(readFileSync(existingPath)).toEqual(Buffer.from('ORIGINAL')) // untouched
    expect(partials()).toHaveLength(0)
  })

  it('a completed save alongside an existing file gets a numeric suffix (no overwrite)', async () => {
    writeFileSync(join(recordingsDir, 'rec.wav'), Buffer.from('ORIGINAL'))

    const filePath = await saveRecording('rec.hda', Buffer.from('NEW'))
    expect(filePath).toBe(join(recordingsDir, 'rec-1.wav'))
    expect(readFileSync(join(recordingsDir, 'rec.wav'))).toEqual(Buffer.from('ORIGINAL'))
    expect(readFileSync(filePath as string)).toEqual(Buffer.from('NEW'))
    expect(partials()).toHaveLength(0)
  })

  it('rethrows when the write fails and leaves no partial behind', async () => {
    // Remove the recordings dir so writeFileSync(tempPath) fails with ENOENT — a real
    // failure that exercises the catch → cleanup → rethrow path without fragile mocks.
    rmSync(recordingsDir, { recursive: true, force: true })

    await expect(saveRecording('rec.hda', Buffer.from('data'))).rejects.toThrow()
    expect(existsSync(recordingsDir)).toBe(false) // nothing (re)created
  })

  describe('HDA container naming follows the bytes', () => {
    const rawMp3 = () => Buffer.concat([Buffer.from([0xff, 0xf3, 0xc8, 0x04]), Buffer.alloc(2000, 0x55)])
    const trueWav = () => {
      const data = Buffer.alloc(3200, 1), header = Buffer.alloc(44)
      header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1')
      header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
      header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
      header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40)
      return Buffer.concat([header, data])
    }

    it('publishes raw MPEG bytes from a Buffer as .mp3 with the device stem', async () => {
      const bytes = rawMp3()
      const result = await saveRecording('2026Oct13-100306-Rec07.hda', bytes)

      expect(result).toBe(join(recordingsDir, '2026Oct13-100306-Rec07.mp3'))
      expect(readFileSync(result!)).toEqual(bytes)
      expect(partials()).toHaveLength(0)
    })

    it('publishes an ID3-tagged stream as .mp3', async () => {
      const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 0)])
      const result = await saveRecording('tagged.hda', id3)
      expect(result).toBe(join(recordingsDir, 'tagged.mp3'))
    })

    it('keeps a RIFF/WAVE, unrecognised bytes, and short bytes on the .wav fallback', async () => {
      expect(await saveRecording('pcm.hda', trueWav())).toBe(join(recordingsDir, 'pcm.wav'))
      expect(await saveRecording('junk.hda', Buffer.from('hello world, not audio'))).toBe(join(recordingsDir, 'junk.wav'))
      expect(await saveRecording('tiny.hda', Buffer.from([0xff]))).toBe(join(recordingsDir, 'tiny.wav'))
      expect(await saveRecording('empty.hda', Buffer.alloc(0))).toBe(join(recordingsDir, 'empty.wav'))
      expect(await saveRecording('reserved.hda', Buffer.from([0xff, 0xf9, 0xc8, 0x04, 0, 0]))).toBe(join(recordingsDir, 'reserved.wav'))
    })

    it('does not rename a non-HDA file based on its bytes', async () => {
      const result = await saveRecording('already.wav', rawMp3())
      expect(result).toBe(join(recordingsDir, 'already.wav'))
    })

    it('uses the detected extension for collision suffixes and preserves the earlier file', async () => {
      writeFileSync(join(recordingsDir, 'dup.mp3'), 'EARLIER')
      const result = await saveRecording('dup.hda', rawMp3())

      expect(result).toBe(join(recordingsDir, 'dup-1.mp3'))
      expect(readFileSync(join(recordingsDir, 'dup.mp3'), 'utf8')).toBe('EARLIER')
    })

    it('leaves no final or partial file on cancellation of a raw MPEG save', async () => {
      const result = await saveRecording('cancel-mpeg.hda', rawMp3(), undefined, undefined, { isCancelled: () => true })
      expect(result).toBeNull()
      expect(readdirSync(recordingsDir)).toHaveLength(0)
    })
  })
})
