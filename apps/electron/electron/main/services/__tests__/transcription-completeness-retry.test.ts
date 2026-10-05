// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { retryInSmallerChunks } from '../transcription-completeness-retry'

describe('bounded completeness retry', () => {
  it('extracts real WAV chunks, offsets turns, skips silent chunks and removes temporary files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'completeness-test-'))
    const path = join(dir, 'audio.wav')
    const pcm = Buffer.alloc(16000 * 2 * 3)
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 1000), i * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    writeFileSync(path, Buffer.concat([header, pcm]))
    const paths: string[] = []
    try {
      const result = await retryInSmallerChunks(path, 3, () => true, async (chunk) => {
        paths.push(chunk)
        expect(existsSync(chunk)).toBe(true)
        return { fullText: 'hello', speakers: JSON.stringify([{ start: 0.1, end: 0.8, speaker: 'A', text: 'hello' }]) }
      }, [{ start: 0, end: 1 }, { start: 2, end: 3 }], 1)
      expect(paths).toHaveLength(2)
      expect(JSON.parse(result.speakers!).map((s: { start: number }) => s.start)).toEqual([0.1, 2.1])
      expect(paths.every(p => !existsSync(p))).toBe(true)
    } finally { rmSync(dir, { recursive: true }) }
  })
  it('checks eligibility before extraction or another provider call', async () => {
    const provider = vi.fn()
    await expect(retryInSmallerChunks('unused', 600, () => false, provider)).rejects.toThrow('cancelled')
    expect(provider).not.toHaveBeenCalled()
  })
})
