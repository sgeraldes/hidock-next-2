// @vitest-environment node
import { expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpeg from 'ffmpeg-static'
import { extractVideoAudio } from '../paste-video'

it('extracts a real video fixture to WAV using bundled ffmpeg without a window or provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hidock-paste-video-'))
  const video = join(dir, 'fixture.mp4')
  const wav = join(dir, 'audio.wav')
  try {
    execFileSync(ffmpeg!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-shortest', video], { windowsHide: true })
    await extractVideoAudio(video, wav)
    const bytes = readFileSync(wav)
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.length).toBeGreaterThan(1000)
  } finally {
    unlinkSync(video)
    unlinkSync(wav)
    rmdirSync(dir)
  }
})
