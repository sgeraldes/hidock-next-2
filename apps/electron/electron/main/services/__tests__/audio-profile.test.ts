// @vitest-environment node

/**
 * The audio check reads loudness from the MP3 frame gains of the device's
 * stream and sorts a recording into silent, noise only, too short or speech.
 * Measured on the owner's library on 24-sep: 150 of 154 short recordings agree
 * with a decoded reference, and no recording with speech is called silent or noise.
 */

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bundledFfmpegPath,
  decodeFrameLevels,
  FRAME_SECONDS,
  LOUD_GAIN,
  profileAudioFile,
  profileFromGains,
  scanDeviceMp3,
  soundRanges,
} from '../audio-profile'

const QUIET = 138 // the owner's silent recordings sit at 138-139
const LOUD = 160

/** One 288-byte frame of the device's stream (MPEG-2 L3, 64 kbps, 16 kHz, mono) with this gain. */
function frame(gain: number, crc = false): Buffer {
  const f = Buffer.alloc(288)
  f[0] = 0xff
  f[1] = crc ? 0xf2 : 0xf3
  f[2] = 0x88
  f[3] = 0xc4
  const side = crc ? 6 : 4
  // part2_3_length = 2200 (bits 9..20), as the device's encoder writes in every frame
  f[side + 1] = 0x44
  f[side + 2] = 0xc0
  // global_gain = side-info bits 30..37
  f[side + 3] = (gain >> 6) & 0x03
  f[side + 4] = (gain << 2) & 0xff
  return f
}

/** A stream from [gain, seconds] pieces. */
function stream(pieces: Array<[number, number]>, options: { riff?: boolean; crc?: boolean } = {}): Buffer {
  const frames: Buffer[] = []
  for (const [gain, seconds] of pieces) {
    for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) frames.push(frame(gain, options.crc))
  }
  const body = Buffer.concat(frames)
  if (!options.riff) return body
  // The older captures: a 44-byte header declaring 16-bit PCM over the MP3.
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.write('WAVE', 8, 'latin1')
  return Buffer.concat([header, body])
}

const gainsOf = (pieces: Array<[number, number]>) => scanDeviceMp3(stream(pieces))!

describe('reading the device stream', () => {
  it('reads one gain per frame, with or without the PCM header in front', () => {
    const plain = scanDeviceMp3(stream([[QUIET, 1], [LOUD, 1]]))!
    const wrapped = scanDeviceMp3(stream([[QUIET, 1], [LOUD, 1]], { riff: true }))!
    expect(plain.length).toBe(Math.round(1 / FRAME_SECONDS) * 2)
    expect(Array.from(wrapped)).toEqual(Array.from(plain))
    expect(plain[0]).toBe(QUIET)
    expect(plain[plain.length - 1]).toBe(LOUD)
  })

  it('reads the gain past a CRC', () => {
    expect(scanDeviceMp3(stream([[LOUD, 1]], { crc: true }))![0]).toBe(LOUD)
  })

  it('says "not this stream" for anything else, so it gets decoded', () => {
    expect(scanDeviceMp3(Buffer.alloc(100_000, 0x11))).toBeNull()
    expect(scanDeviceMp3(Buffer.alloc(10))).toBeNull()
  })

  it('knows the real length from the frames, not from a header', () => {
    // The old headers claim 4 times the real byte rate: a 40 s file "is" 10 s.
    expect(profileFromGains(gainsOf([[LOUD, 40]])).durationSeconds).toBeCloseTo(40, 0)
  })
})

describe('categories', () => {
  it('silent: 20 s with no sound (the Rec56 case)', () => {
    const p = profileFromGains(gainsOf([[QUIET, 20]]))
    expect(p.category).toBe('silent')
    expect(p.soundSeconds).toBe(0)
    expect(p.medianLevel).toBe(QUIET)
  })

  it('noise only: a few knocks in 30 s of silence', () => {
    const p = profileFromGains(gainsOf([[QUIET, 10], [LOUD, 0.3], [QUIET, 10], [LOUD, 0.4], [QUIET, 10]]))
    expect(p.category).toBe('noise')
    expect(p.spikeCount).toBe(2)
    expect(p.ranges).toEqual([])
  })

  it('speech: sustained sound', () => {
    expect(profileFromGains(gainsOf([[QUIET, 5], [LOUD, 6], [QUIET, 5]])).category).toBe('speech')
  })

  it('too short: under 10 seconds, whatever it holds', () => {
    expect(profileFromGains(gainsOf([[LOUD, 8]])).category).toBe('too_short')
  })

  it('does not split speech at the short pauses between syllables', () => {
    // 1.2 s of sound in 0.36 s bursts with 0.18 s gaps: one stretch, not four spikes.
    const bursts: Array<[number, number]> = []
    for (let i = 0; i < 4; i++) bursts.push([LOUD, 0.36], [QUIET, 0.18])
    const p = profileFromGains(gainsOf([[QUIET, 12], ...bursts, [QUIET, 12]]))
    expect(p.longestSoundSeconds).toBeGreaterThan(1.5)
    expect(p.spikeCount).toBe(0)
  })

  it('keeps the typical level where it is when a few loud spikes arrive', () => {
    const p = profileFromGains(gainsOf([[QUIET, 30], [255, 0.2], [QUIET, 30]]))
    expect(p.medianLevel).toBe(QUIET)
  })
})

describe('time ranges with sound', () => {
  it('finds the talk in a long silent recording, padded', () => {
    const p = profileFromGains(gainsOf([[QUIET, 900], [LOUD, 60], [QUIET, 1200], [LOUD, 30], [QUIET, 60]]))
    expect(p.ranges).toHaveLength(2)
    expect(p.ranges[0].start).toBeCloseTo(900 - 0.5, 0)
    expect(p.ranges[0].end).toBeCloseTo(960 + 0.5, 0)
    expect(p.soundShare).toBeLessThan(0.05)
  })

  it('bridges pauses under 2 s and drops blips under 1 s', () => {
    const loud = (secs: number) => Array.from({ length: Math.round(secs / FRAME_SECONDS) }, () => 1)
    const quiet = (secs: number) => Array.from({ length: Math.round(secs / FRAME_SECONDS) }, () => 0)
    const flags = [...quiet(5), ...loud(3), ...quiet(1.5), ...loud(3), ...quiet(10), ...loud(0.5), ...quiet(10)]
    const ranges = soundRanges(flags)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].end - ranges[0].start).toBeCloseTo(7.5 + 1, 0)
  })

  it('uses the same loudness line as the transcription pre-flight', () => {
    expect(LOUD_GAIN).toBe(142)
  })
})

describe('confirming a verdict that would hide a recording', () => {
  it('decodes before calling it silent or noise, and keeps the decoded verdict', async () => {
    const buf = stream([[QUIET, 20]])
    // The decoded audio says there is speech the gain did not see.
    const decoded = Float32Array.from({ length: Math.round(20 / FRAME_SECONDS) }, (_, i) => (i > 100 && i < 300 ? -20 : -70))
    const decode = vi.fn(async () => decoded)
    const p = await profileAudioFile(buf, 'rec.wav', decode)
    expect(decode).toHaveBeenCalledOnce()
    expect(p.category).toBe('speech')
    expect(p.envelope[0]).toBe(QUIET) // the waveform keeps the fast envelope
  })

  it('does not decode when the fast verdict is speech', async () => {
    const decode = vi.fn()
    const p = await profileAudioFile(stream([[LOUD, 20]]), 'rec.wav', decode)
    expect(p.category).toBe('speech')
    expect(decode).not.toHaveBeenCalled()
  })

  it('decodes any file that is not the device stream', async () => {
    const decode = vi.fn(async () => Float32Array.from({ length: 400 }, () => -80))
    const p = await profileAudioFile(Buffer.alloc(50_000, 0x22), 'import.m4a', decode)
    expect(decode).toHaveBeenCalledOnce()
    expect(p.method).toBe('decoded')
    expect(p.category).toBe('silent')
  })
})

describe('streams from other encoders', () => {
  it('does not trust the gain of a stream whose frames are not filled like the device ones', () => {
    // Same format, but part2_3_length varies from frame to frame (any VBR-minded encoder).
    const frames = Array.from({ length: 600 }, (_, i) => {
      const f = frame(QUIET)
      f[5] = 0x10 + (i % 7) // part2_3_length no longer 2200
      return f
    })
    expect(scanDeviceMp3(Buffer.concat(frames))).toBeNull()
  })

  it('sends a real LAME file in the same format to decoding (it reads silence as loud)', () => {
    let ffmpeg: string
    try {
      ffmpeg = bundledFfmpegPath()
    } catch {
      return // no bundled ffmpeg in this environment
    }
    if (!existsSync(ffmpeg)) return
    const dir = mkdtempSync(join(tmpdir(), 'hidock-lame-'))
    try {
      const out = join(dir, 'voice.mp3')
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=10',
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
        '-ac', '1', '-ar', '16000', '-codec:a', 'libmp3lame', '-b:a', '64k', out,
      ])
      expect(scanDeviceMp3(readFileSync(out))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('decoding', () => {
  it('uses the ffmpeg the app ships, outside the asar archive', () => {
    expect(bundledFfmpegPath()).not.toMatch(/app\.asar[\\/]/)
  })

  it('fails on a file it cannot decode instead of returning part of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-bad-'))
    try {
      const bad = join(dir, 'bad.m4a')
      writeFileSync(bad, Buffer.alloc(4096, 0x33))
      await expect(decodeFrameLevels(bad)).rejects.toThrow(/could not decode/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
