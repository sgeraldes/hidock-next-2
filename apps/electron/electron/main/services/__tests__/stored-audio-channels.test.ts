/** @vitest-environment node */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import ffmpegPath from 'ffmpeg-static'
import { prepareStoredAudioChannels, inspectStoredAudio } from '../stored-audio-channels'
let folder: string
function wav(channels: number): Buffer {
  const frames = 16000,
    data = Buffer.alloc(frames * channels * 2),
    head = Buffer.alloc(44)
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      data.writeInt16LE(Math.round(Math.sin(i * (c + 1) * 0.13) * 4000), 2 * (i * channels + c))
  head.write('RIFF')
  head.writeUInt32LE(data.length + 36, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(16000, 24)
  head.writeUInt32LE(32000 * channels, 28)
  head.writeUInt16LE(channels * 2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}
function pcm(path: string): Buffer {
  const b = readFileSync(path)
  let p = 12
  while (p + 8 <= b.length) {
    const n = b.readUInt32LE(p + 4)
    if (b.toString('ascii', p, p + 4) === 'data') return b.subarray(p + 8, p + 8 + n)
    p += 8 + n + (n % 2)
  }
  throw new Error('no PCM')
}
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'stored-audio-fixtures-'))
})
afterAll(() => rmSync(folder, { recursive: true, force: true }))
it.each([
  ['ogg', 'libopus', 'ogg'], ['flac', 'flac', 'flac'],
  ['m4a', 'aac', 'mp4'], ['webm', 'libopus', 'webm']
])('retains existing %s import support and separate stereo decoding', async (extension, codec, container) => {
  const source = join(folder, `existing-${extension}.wav`)
  const encoded = join(folder, `existing.${extension}`)
  writeFileSync(source, wav(2))
  execFileSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', source,
    '-c:a', codec, '-y', encoded], { windowsHide: true, timeout: 10000 })
  const prepared = await prepareStoredAudioChannels(encoded, folder)
  try {
    expect(prepared.layout).toMatchObject({ container, channels: 2 })
    expect(prepared.tracks).toHaveLength(2)
    expect(prepared.tracks.every(track => track.frames > 0)).toBe(true)
  } finally { await prepared.cleanup() }
})
it('preserves exact PCM channels, sample clock, unknown mapping and original bytes', async () => {
  const path = join(folder, 'stereo.hda'),
    original = wav(2)
  writeFileSync(path, Buffer.concat([original, Buffer.from('CUSTOM-MARKER-TRAILER')]))
  const before = readFileSync(path),
    prepared = await prepareStoredAudioChannels(path, folder)
  expect(prepared.layout).toMatchObject({
    container: 'wav',
    channels: 2,
    sampleRate: 16000,
    durationSeconds: 1,
    durationSource: 'decoded-frames'
  })
  for (const track of prepared.tracks) {
    expect(track.sourceRole).toBe('unknown')
    expect(track.mappingEvidence).toBeNull()
    const data = pcm(track.path)
    for (let i = 0; i < 16000; i++)
      expect(data.readInt16LE(i * 2)).toBe(original.readInt16LE(44 + (i * 2 + track.channelIndex) * 2))
  }
  expect(readFileSync(path)).toEqual(before)
  await prepared.cleanup()
  expect(existsSync(prepared.tracks[0].path)).toBe(false)
}, 60000)
it.each([64, 96, 128, 160])(
  'measures MP3 %ikbps mono/stereo, including legacy RIFF-MPEG and markers',
  async (bitrate) => {
    for (const channels of [1, 2]) {
      const source = join(folder, `source-${channels}.wav`)
      writeFileSync(source, wav(channels))
      const mp3 = join(folder, `audio-${channels}-${bitrate}.hda`)
      execFileSync(
        ffmpegPath!,
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '2',
          '-i',
          source,
          '-c:a',
          'libmp3lame',
          '-b:a',
          `${bitrate}k`,
          '-threads',
          '2',
          '-f',
          'mp3',
          '-y',
          mp3
        ],
        { windowsHide: true, timeout: 10000 }
      )
      const encoded = readFileSync(mp3),
        header = wav(2).subarray(0, 44)
      header.writeUInt32LE(encoded.length + 36, 4)
      header.writeUInt32LE(encoded.length, 40)
      const wrapped = join(folder, `wrapped-${channels}-${bitrate}.hda`)
      writeFileSync(wrapped, Buffer.concat([header, encoded, Buffer.from('CUSTOM-MARKER-TRAILER')]))
      for (const path of [mp3, wrapped]) {
        const original = readFileSync(path),
          result = await prepareStoredAudioChannels(path, folder)
        expect(result.layout.channels).toBe(channels)
        expect(result.layout.codec).toMatch(/^mp3/)
        expect(result.layout.bitrateKbps).toBe(bitrate)
        expect(result.layout.container).toBe(path === mp3 ? 'mp3' : 'riff-mpeg')
        expect(result.tracks).toHaveLength(channels)
        expect(result.tracks[0].durationSeconds).toBeCloseTo(1, 2)
        expect(readFileSync(path)).toEqual(original)
        await result.cleanup()
      }
    }
  },
  120000
)
it('refuses multichannel without downmix, invalid mapping, cancellation and cleans only owned files', async () => {
  const multi = join(folder, 'multi.wav')
  writeFileSync(multi, wav(3))
  const before = readdirSync(folder).sort()
  expect((await inspectStoredAudio(multi)).channels).toBe(3)
  await expect(prepareStoredAudioChannels(multi, folder)).rejects.toThrow(/mono or stereo/)
  expect(readdirSync(folder).sort()).toEqual(before)
  const controller = new AbortController()
  controller.abort()
  await expect(inspectStoredAudio(multi, { signal: controller.signal })).rejects.toThrow()
  const mono = join(folder, 'mono.wav')
  writeFileSync(mono, wav(1))
  await expect(
    prepareStoredAudioChannels(mono, folder, {
      mapping: { evidence: 'user-confirmed', evidenceId: '', roles: ['microphone'] }
    })
  ).rejects.toThrow(/mapping/)
  const result = await prepareStoredAudioChannels(mono, folder, {
    mapping: { evidence: 'user-confirmed', evidenceId: 'fixture-confirmation', roles: ['microphone'] }
  })
  expect(result.tracks[0].sourceRole).toBe('microphone')
  await result.cleanup()
}, 60000)

it('detects headerless wrapped MPEG but never mistakes one PCM sync-looking sample for MPEG', async () => {
  const source = join(folder, 'raw-source.wav')
  writeFileSync(source, wav(2))
  const encodedPath = join(folder, 'raw.mp3')
  execFileSync(
    ffmpegPath!,
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-i',
      source,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '96k',
      '-id3v2_version',
      '0',
      '-write_xing',
      '0',
      '-threads',
      '2',
      '-y',
      encodedPath
    ],
    { windowsHide: true, timeout: 10000 }
  )
  const encoded = readFileSync(encodedPath),
    head = wav(2).subarray(0, 44)
  head.writeUInt32LE(encoded.length + 36, 4)
  head.writeUInt32LE(encoded.length, 40)
  const wrapped = join(folder, 'headerless.hda')
  writeFileSync(wrapped, Buffer.concat([head, encoded]))
  expect((await inspectStoredAudio(wrapped)).container).toBe('riff-mpeg')
  const suspicious = wav(2)
  encoded.copy(suspicious, 44, 0, 4)
  const pcmPath = join(folder, 'pcm-sync.wav')
  writeFileSync(pcmPath, suspicious)
  expect((await inspectStoredAudio(pcmPath)).container).toBe('wav')
}, 60000)
