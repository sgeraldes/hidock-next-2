// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import ffmpegPath from 'ffmpeg-static'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { analyzeAudioPreflight } from '../audio-preflight'

// Runs the bundled ffmpeg for real (audio-preflight.test.ts mocks child_process).
describe('audio transcription preflight on a real WebM', () => {
  it('decodes a streaming WebM with no duration header', async () => {
    const path = join(tmpdir(), `hidock-preflight-${process.pid}-${Date.now()}.webm`)
    const bytes = execFileSync(ffmpegPath!, ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { windowsHide: true })
    writeFileSync(path, bytes)
    try {
      const report = await analyzeAudioPreflight(path)
      expect(report.durationSeconds).toBeGreaterThan(1.9)
      expect(report.durationSeconds).toBeLessThan(2.2)
      expect(report.status).toBe('speech_present')
    } finally { rmSync(path) }
  })
})
