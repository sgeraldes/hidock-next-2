// @vitest-environment node
import { expect, it } from 'vitest'
import { assertRecordingManifestBinding, parseRecordingManifest } from '../recording-manifest'

const sha = 'a'.repeat(64)
const fixture = () => ({
  schemaVersion: 1, recordingId: 'Device-Id', contentGeneration: 'Generation-A', state: 'finalized',
  file: { name: 'capture.wav', byteLength: 64044, sha256: sha },
  audio: {
    container: 'wav', codec: 'pcm_s16le', sampleRateHz: 16000, channels: 2, bitsPerSample: 16,
    clock: null,
    sourceMap: [{ channelIndex: 0, role: 'unknown' }, { channelIndex: 1, role: 'unknown' }]
  },
  markers: []
})
const measured = () => ({
  sha256: sha, byteLength: 64044,
  layout: {
    container: 'wav' as const, codec: 'pcm_s16le', channels: 2, sampleRate: 16000,
    durationSeconds: 1, durationSource: 'decoded-frames' as const, originalSha256: sha
  }
})

it('rejects metadata not in the v1 vocabulary at every untrusted nested boundary', () => {
  for (const mutate of [
    (input: any) => { input.file.downloadedAt = '2099-01-01T00:00:00Z' },
    (input: any) => { input.audio.clockEvidence = { source: 'firmware' } },
    (input: any) => { input.audio.sourceMap[0].personId = 'someone' },
    (input: any) => { input.markers = [{ markerId: 'm1', type: 'manual', position: { unit: 'legacy-ms', value: 1 }, timestamp: 1 }] }
  ]) {
    const input = fixture()
    mutate(input)
    expect(() => parseRecordingManifest(JSON.stringify(input))).toThrow('invalid')
  }
})

it('requires the explicit null clock and a complete zero-based source map', () => {
  const missingClock: any = fixture()
  delete missingClock.audio.clock
  expect(() => parseRecordingManifest(JSON.stringify(missingClock))).toThrow('invalid')

  const wrongSourceIndex: any = fixture()
  wrongSourceIndex.audio.channels = 1
  wrongSourceIndex.audio.sourceMap = [{ channelIndex: 1, role: 'unknown' }]
  expect(() => parseRecordingManifest(JSON.stringify(wrongSourceIndex))).toThrow('invalid')
})

it('uses UTF-8 byte limits for names and rejects ill-formed Unicode instead of replacement-normalizing it', () => {
  const atLimit: any = fixture()
  atLimit.file.name = `${'😀'.repeat(63)}.wav` // 256 bytes: suffix makes it too large.
  expect(() => parseRecordingManifest(JSON.stringify(atLimit))).toThrow('invalid')

  const wellFormedAtLimit: any = fixture()
  wellFormedAtLimit.file.name = '😀'.repeat(63) // 252 UTF-8 bytes.
  expect(parseRecordingManifest(JSON.stringify(wellFormedAtLimit)).file.name).toBe(wellFormedAtLimit.file.name)

  const malformedIdentifier: any = fixture()
  malformedIdentifier.recordingId = 'id-\uD800'
  expect(() => parseRecordingManifest(JSON.stringify(malformedIdentifier))).toThrow('invalid')
})

it('preserves opaque identity bytes: case and normalization variants remain distinct, not canonicalized', () => {
  const input: any = fixture()
  input.recordingId = 'Device-Id'
  input.contentGeneration = 'e\u0301' // NFD; it is deliberately not the NFC byte sequence "é".
  const parsed = parseRecordingManifest(JSON.stringify(input))
  expect(parsed.recordingId).toBe('Device-Id')
  expect(parsed.contentGeneration).toBe('e\u0301')
  expect(parsed.contentGeneration).not.toBe('é')
})

it('does not bind a manifest to a decoder layout measured from a different original', () => {
  const parsed = parseRecordingManifest(JSON.stringify(fixture()))
  const observation = measured()
  observation.layout.originalSha256 = 'b'.repeat(64)
  expect(() => assertRecordingManifestBinding(parsed, observation)).toThrow('does not match')
})

it('accepts a differently-rated pre-encoder clock structurally, but rejects association without a representable resampling map', () => {
  const input: any = fixture()
  input.audio.clock = { sampleRateHz: 48000, frameCount: 48000, encoderDelayFrames: 0, encoderPaddingFrames: 0 }
  const parsed = parseRecordingManifest(JSON.stringify(input))
  expect(parsed.audio.clock).toEqual(input.audio.clock)
  expect(() => assertRecordingManifestBinding(parsed, {
    ...measured(),
    clockEvidence: {
      originalSha256: sha, evidenceId: 'preencoder-48k-proof', source: 'pcm-frame-measurement',
      clock: { ...input.audio.clock }
    }
  })).toThrow('independent')
})

it('retains a known legacy marker type with a null persistent ID without authenticating the metadata', () => {
  for (const type of ['manual', 'automatic']) {
    const input: any = fixture()
    input.markers = [{ markerId: null, type, position: { unit: 'legacy-ms', value: 1 } }]
    const parsed = parseRecordingManifest(JSON.stringify(input))
    expect(parsed.markers[0]).toMatchObject({ markerId: null, type })
    expect(parsed).not.toHaveProperty('firmwareVerified')
  }
})
