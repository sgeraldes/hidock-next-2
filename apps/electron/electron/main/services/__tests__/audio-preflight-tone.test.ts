// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyzeAudioPreflight } from '../audio-preflight'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('audio transcription preflight', () => {
  it('observes that a real 121-second sine tone has energy, which cannot prove speech', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-tone-preflight-'))
    const path = join(dir, 'tone.wav')
    const pcm = Buffer.alloc(16000 * 2 * 121)
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 8000), i * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    writeFileSync(path, Buffer.concat([header, pcm]))
    try {
      const report = await analyzeAudioPreflight(path, 121)
      expect(report.status).toBe('speech_present')
      expect(report.nonSilentSeconds).toBeCloseTo(121)
    } finally { rmSync(dir, { recursive: true }) }
  })
})
