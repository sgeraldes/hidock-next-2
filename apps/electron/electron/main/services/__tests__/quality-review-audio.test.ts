// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readReviewAudio } from '../quality-review-audio'

const root = mkdtempSync(join(tmpdir(), 'hidock-review-audio-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('bounded review audio extraction', () => {
  it('rejects oversized and invalid scopes before opening an audio source', async () => {
    await expect(readReviewAudio('does-not-exist', 0, 31)).rejects.toThrow('bounded interval')
    await expect(readReviewAudio('does-not-exist', -1, 1)).rejects.toThrow('bounded interval')
    await expect(readReviewAudio('does-not-exist', 0, NaN)).rejects.toThrow('bounded interval')
  })
  it('extracts a real short imported PCM source using bundled ffmpeg', async () => {
    const rate = 16000, frames = rate * 2, channels = 2
    const data = Buffer.alloc(44 + frames * channels * 2)
    data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22)
    data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * channels * 2, 28)
    data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36)
    data.writeUInt32LE(data.length - 44, 40)
    for (let i = 0; i < frames; i++) {
      data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 5000), 44 + i * 4)
      data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 880 / rate) * 5000), 46 + i * 4)
    }
    const path = join(root, 'source.wav'); writeFileSync(path, data)
    const result = await readReviewAudio(path, 0.5, 1)
    expect(result.length).toBeGreaterThan(1000)
    expect(result.length).toBeLessThan(2 * 1024 * 1024)
    expect(result.toString('latin1', 0, 4)).not.toBe('RIFF')
  })
})
