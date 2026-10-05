import { describe, expect, it } from 'vitest'
import { AudioPreflightError, parseAudioPreflightOutput, analyzeAudioPreflight } from '../audio-preflight'
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
  it('classifies a long lobby recording containing only brief cough/noise as no_speech', () => {
    const output = `
Duration: 00:02:54.85, start: 0.000000, bitrate: 64 kb/s
[silencedetect] silence_start: 0
[silencedetect] silence_end: 0.700 | silence_duration: 0.700
[silencedetect] silence_start: 1.500
[silencedetect] silence_end: 100.000 | silence_duration: 98.500
[silencedetect] silence_start: 100.670
[silencedetect] silence_end: 174.8535 | silence_duration: 74.1835
[Parsed_volumedetect] mean_volume: -44.6 dB
[Parsed_volumedetect] max_volume: -5.7 dB
`

    const report = parseAudioPreflightOutput(output, 174.8535)

    expect(report.status).toBe('no_speech')
    expect(report.nonSilentSeconds).toBe(1.47)
    expect(report.nonSilentRatio).toBeLessThan(0.01)
    expect(report.maxVolumeDb).toBe(-5.7)
    expect(report.reasonCodes).toContain('insufficient_sustained_audio_activity')
  })

  it('allows a recording with sustained audio activity to reach ASR', () => {
    const output = `
Duration: 00:01:00.00, start: 0.000000, bitrate: 64 kb/s
[silencedetect] silence_start: 0
[silencedetect] silence_end: 5.000 | silence_duration: 5.000
[silencedetect] silence_start: 55.000
[silencedetect] silence_end: 60.000 | silence_duration: 5.000
[Parsed_volumedetect] mean_volume: -24.0 dB
[Parsed_volumedetect] max_volume: -3.0 dB
`

    const report = parseAudioPreflightOutput(output)

    expect(report.status).toBe('speech_present')
    expect(report.nonSilentSeconds).toBe(50)
    expect(report.activityIntervals).toEqual([{ start: 5, end: 55, duration: 50 }])
  })

  it('fails closed when duration cannot be established', () => {
    expect(() => parseAudioPreflightOutput('invalid ffmpeg output')).toThrow(AudioPreflightError)
  })
})
