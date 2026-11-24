// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertRecordingManifestBinding, parseRecordingManifest, type RecordingClockEvidence } from '../recording-manifest'

const sha = 'a'.repeat(64)
const wavClock = (frameCount: number, sampleRateHz = 16000) =>
  ({ sampleRateHz, frameCount, encoderDelayFrames: 0, encoderPaddingFrames: 0 })
const manifestFor = (clock: object | null, extra: object = {}): any => ({
  schemaVersion: 1, recordingId: 'device-id', contentGeneration: 'generation-1', state: 'finalized',
  file: { name: 'capture.wav', byteLength: 64044, sha256: sha },
  audio: {
    container: 'wav', codec: 'pcm_s16le', sampleRateHz: 16000, channels: 2, bitsPerSample: 16, clock,
    sourceMap: [{ channelIndex: 0, role: 'unknown' }, { channelIndex: 1, role: 'unknown' }]
  },
  markers: [], ...extra
})
const layoutFor = (durationSeconds: number, durationSource: 'decoded-frames' | 'decoder-probe' = 'decoded-frames') => ({
  container: 'wav' as const, codec: 'pcm_s16le', channels: 2, sampleRate: 16000,
  durationSeconds, durationSource, originalSha256: sha
})
const measuredFor = (durationSeconds: number, clockEvidence?: RecordingClockEvidence, durationSource?: 'decoded-frames' | 'decoder-probe') =>
  ({ sha256: sha, byteLength: 64044, layout: layoutFor(durationSeconds, durationSource), clockEvidence })
const proofFor = (clock: object, evidenceId = 'pcm-proof'): RecordingClockEvidence =>
  ({ originalSha256: sha, evidenceId, source: 'pcm-frame-measurement', clock: clock as any })
const bind = (clock: object | null, durationSeconds: number, proofClock: object | null = clock, evidenceId?: string,
  durationSource?: 'decoded-frames' | 'decoder-probe', extra: object = {}) =>
  assertRecordingManifestBinding(parseRecordingManifest(JSON.stringify(manifestFor(clock, extra))),
    measuredFor(durationSeconds, proofClock ? proofFor(proofClock, evidenceId) : undefined, durationSource))

describe('measured duration must be a positive finite number before any marker check', () => {
  for (const [name, duration] of [['NaN', Number.NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['zero', 0], ['negative', -1]] as const) {
    it(`rejects ${name} even with a null clock and no markers`, () => {
      expect(() => bind(null, duration)).toThrow('positive finite')
    })
    it(`rejects ${name} before a legacy marker can pass a NaN comparison`, () => {
      const markers = [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 5_000_000 } }]
      expect(() => bind(null, duration, null, undefined, undefined, { markers })).toThrow('positive finite')
    })
  }
  it('accepts a small positive measured duration', () => {
    expect(() => bind(null, 0.001)).not.toThrow()
  })
})

describe('a non-null clock must agree with the independently measured decoded duration', () => {
  it('rejects 999999 WAV frames on a measured 1 second even when the proof copies the claim', () => {
    const claim = wavClock(999999)
    expect(() => bind(claim, 1)).toThrow('contradicts the measured decoded duration')
  })
  it('rejects a claim that is short of the measured duration by the same margin', () => {
    expect(() => bind(wavClock(8000), 1)).toThrow('contradicts')
  })
  it('accepts exact PCM frames', () => {
    expect(() => bind(wavClock(16000), 1)).not.toThrow()
  })
  it('rejects every small frame discrepancy on a measured second: there is no millisecond or one-frame slack', () => {
    for (const frames of [15984, 15990, 15991, 15992, 15999, 16001, 16007, 16008, 16009, 16010, 16016]) {
      expect(() => bind(wavClock(frames), 1)).toThrow('contradicts')
    }
  })
  it('rejects the one-frame and nine-frame mismatches the earlier 0.5 ms rule accepted', () => {
    expect(() => bind(wavClock(16001), 1)).toThrow('contradicts')
    expect(() => bind(wavClock(15999), 1)).toThrow('contradicts')
    expect(() => bind(wavClock(16009), 1)).toThrow('contradicts')
    expect(() => bind(wavClock(15991), 1)).toThrow('contradicts')
  })
  it('accepts a fractional duration that is exactly frames / 16000', () => {
    for (const frames of [1, 7, 16001, 24000, 123457, 240001]) {
      expect(() => bind(wavClock(frames), frames / 16000)).not.toThrow()
    }
  })
  it('accepts a six-hour fractional exact duration and rejects either one-sample difference', () => {
    const frames = 6 * 60 * 60 * 16000 + 7
    const duration = frames / 16000
    expect(() => bind(wavClock(frames), duration)).not.toThrow()
    expect(() => bind(wavClock(frames + 1), duration)).toThrow('contradicts')
    expect(() => bind(wavClock(frames - 1), duration)).toThrow('contradicts')
  })
  it('rejects one frame off a fractional duration', () => {
    expect(() => bind(wavClock(24001), 24000 / 16000)).toThrow('contradicts')
    expect(() => bind(wavClock(23999), 24000 / 16000)).toThrow('contradicts')
  })
  it('accepts large exact durations and still rejects one frame off at that size', () => {
    for (const seconds of [15, 3600, 14400, 86400]) {
      const frames = seconds * 16000
      expect(() => bind(wavClock(frames), frames / 16000)).not.toThrow()
      expect(() => bind(wavClock(frames + 1), frames / 16000)).toThrow('contradicts')
      expect(() => bind(wavClock(frames - 1), frames / 16000)).toThrow('contradicts')
    }
    expect(() => bind(wavClock(240000), 14)).toThrow('contradicts')
  })
  it('tolerates only floating-point noise of a few ULPs and nothing near a frame', () => {
    const exact = 123457 / 16000
    expect(() => bind(wavClock(123457), exact + Number.EPSILON * exact)).not.toThrow()
    expect(() => bind(wavClock(123457), exact - Number.EPSILON * exact)).not.toThrow()
    expect(() => bind(wavClock(123457), exact + 1e-6)).toThrow('contradicts')
    expect(() => bind(wavClock(123457), exact + 1 / 16000 / 2)).toThrow('contradicts')
  })
  it('refuses a clock whose duration came from a decoder probe, which is an estimate and not a frame count', () => {
    expect(() => bind(wavClock(16000), 1, wavClock(16000), undefined, 'decoder-probe')).toThrow('decoded frames')
  })
  it('still binds a null clock whatever the duration source', () => {
    expect(() => bind(null, 1, null, undefined, 'decoder-probe')).not.toThrow()
  })
  it('keeps the rate mismatch refusal ahead of the duration comparison', () => {
    const claim = wavClock(48000, 48000)
    expect(() => bind(claim, 1)).toThrow('capture clock rate differs')
  })
})

describe('a non-null PCM clock is only supported for a directly measured 16000 Hz source', () => {
  const bindAtRate = (rate: number, clockClaim: object | null, durationSeconds: number) => {
    const input = manifestFor(clockClaim)
    input.audio.sampleRateHz = rate
    const parsed = parseRecordingManifest(JSON.stringify(input))
    return assertRecordingManifestBinding(parsed, {
      sha256: sha, byteLength: 64044, clockEvidence: clockClaim ? proofFor(clockClaim) : undefined,
      layout: { ...layoutFor(durationSeconds), sampleRate: rate }
    })
  }
  for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 96000, 192000]) {
    it(`rejects a ${rate} Hz clock even when the claim, proof and frames / rate all agree`, () => {
      expect(() => bindAtRate(rate, wavClock(rate, rate), 1)).toThrow('null clock')
    })
    it(`keeps a ${rate} Hz source bindable with a null clock`, () => {
      expect(() => bindAtRate(rate, null, 1)).not.toThrow()
    })
  }
  it('rejects a 48000 Hz clock whose frames equal the 16 kHz decoded count, with no ratio deduced', () => {
    expect(() => bindAtRate(48000, wavClock(16000, 48000), 1)).toThrow('null clock')
  })
  it('accepts the directly measured 16000 Hz source with zero delay and padding', () => {
    expect(() => bindAtRate(16000, wavClock(16000), 1)).not.toThrow()
  })
  it('rejects a 16000 Hz PCM claim with encoder delay or padding', () => {
    const delayed = { sampleRateHz: 16000, frameCount: 16000, encoderDelayFrames: 1, encoderPaddingFrames: 0 }
    expect(() => bindAtRate(16000, delayed, 1)).toThrow('independent')
  })
})

describe('MPEG never carries a non-null clock in v1', () => {
  const mp3Manifest = (clock: object | null) => {
    const input = manifestFor(clock)
    input.audio.container = 'mp3'; input.audio.codec = 'mp3'; delete input.audio.bitsPerSample; input.audio.bitrateKbps = 128
    return parseRecordingManifest(JSON.stringify(input))
  }
  const mp3Measured = (container: 'mp3' | 'riff-mpeg', clockEvidence?: RecordingClockEvidence) => ({
    sha256: sha, byteLength: 64044, clockEvidence,
    layout: { ...layoutFor(1, 'decoder-probe'), container, codec: 'mp3' }
  })
  it('rejects a calibrated MPEG clock whose frames happen to match the duration', () => {
    const claim = { sampleRateHz: 16000, frameCount: 16000, encoderDelayFrames: 576, encoderPaddingFrames: 128 }
    const proof: RecordingClockEvidence = { originalSha256: sha, evidenceId: 'calibration', source: 'independent-encoder-calibration', clock: claim }
    expect(() => assertRecordingManifestBinding(mp3Manifest(claim), mp3Measured('mp3', proof))).toThrow('null clock')
  })
  it('rejects an MPEG clock for the riff-mpeg container too', () => {
    const input = manifestFor(wavClock(16000))
    input.audio.container = 'riff-mpeg'; input.audio.codec = 'mp3'; delete input.audio.bitsPerSample; input.audio.bitrateKbps = 128
    const parsed = parseRecordingManifest(JSON.stringify(input))
    expect(() => assertRecordingManifestBinding(parsed, mp3Measured('riff-mpeg', proofFor(wavClock(16000)))))
      .toThrow('null clock')
  })
  it('binds the same MPEG recording when the clock is null', () => {
    expect(() => assertRecordingManifestBinding(mp3Manifest(null), mp3Measured('mp3'))).not.toThrow()
  })
})

describe('clock evidence identifiers and arithmetic are bounded', () => {
  it('accepts an evidence id of exactly 128 UTF-8 bytes and rejects 129', () => {
    expect(() => bind(wavClock(16000), 1, wavClock(16000), 'e'.repeat(128))).not.toThrow()
    expect(() => bind(wavClock(16000), 1, wavClock(16000), 'e'.repeat(129))).toThrow('independent')
  })
  it('measures the evidence id in bytes, not UTF-16 units', () => {
    expect(() => bind(wavClock(16000), 1, wavClock(16000), '😀'.repeat(32))).not.toThrow() // 128 bytes
    expect(() => bind(wavClock(16000), 1, wavClock(16000), '😀'.repeat(33))).toThrow('independent') // 132 bytes
  })
  it('rejects blank, control-character and malformed-Unicode evidence ids', () => {
    for (const id of ['', '   ', 'proof\u0000x', 'proof\nx', 'proof-\uD800']) {
      expect(() => bind(wavClock(16000), 1, wavClock(16000), id)).toThrow('independent')
    }
  })
  it('rejects a clock whose frames plus encoder delay and padding exceed the safe integer range', () => {
    const base = manifestFor(wavClock(1))
    base.audio.clock = { sampleRateHz: 16000, frameCount: Number.MAX_SAFE_INTEGER, encoderDelayFrames: 1, encoderPaddingFrames: 0 }
    expect(() => parseRecordingManifest(JSON.stringify(base))).toThrow('invalid')
    base.audio.clock = { sampleRateHz: 16000, frameCount: Number.MAX_SAFE_INTEGER - 2, encoderDelayFrames: 1, encoderPaddingFrames: 1 }
    expect(parseRecordingManifest(JSON.stringify(base)).audio.clock?.frameCount).toBe(Number.MAX_SAFE_INTEGER - 2)
  })
  it('rejects a proof clock that overflows even when the manifest claim is small', () => {
    const overflowing = { sampleRateHz: 16000, frameCount: Number.MAX_SAFE_INTEGER, encoderDelayFrames: 1, encoderPaddingFrames: 0 }
    expect(() => bind(wavClock(16000), 1, overflowing)).toThrow('independent')
  })
  it('refuses an astronomically large claimed frame count against a small measured duration', () => {
    expect(() => bind(wavClock(Number.MAX_SAFE_INTEGER - 2), 1)).toThrow('contradicts')
  })
  it('rejects exact-looking equality when floating-point slack reaches half a sample', () => {
    const frames = Number.MAX_SAFE_INTEGER
    const duration = frames / 16000
    expect(() => bind(wavClock(frames), duration)).toThrow('contradicts')
  })
})

describe('behaviour that must stay permitted', () => {
  it('binds a null-ID marker with a known manual or automatic type', () => {
    for (const type of ['manual', 'automatic']) {
      const markers = [{ markerId: null, type, position: { unit: 'legacy-ms', value: 500 } }]
      expect(() => bind(null, 1, null, undefined, undefined, { markers })).not.toThrow()
    }
  })
  it('treats the source map as keyed by channelIndex, whatever its order', () => {
    const input = manifestFor(null)
    input.audio.sourceMap = [{ channelIndex: 1, role: 'system' }, { channelIndex: 0, role: 'microphone' }]
    const parsed = parseRecordingManifest(JSON.stringify(input))
    expect(() => assertRecordingManifestBinding(parsed, measuredFor(1))).not.toThrow()
    expect(parsed.audio.sourceMap.find(row => row.channelIndex === 0)?.role).toBe('microphone')
  })
  it('keeps binding independently measured PCM with a matching proof', () => {
    expect(() => bind(wavClock(32000), 2)).not.toThrow()
  })
  it('keeps legacy milliseconds within the measured duration and rejects those beyond it', () => {
    const inside = [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1000 } }]
    const beyond = [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1001 } }]
    expect(() => bind(null, 1, null, undefined, undefined, { markers: inside })).not.toThrow()
    expect(() => bind(null, 1, null, undefined, undefined, { markers: beyond })).toThrow('exceeds measured audio duration')
  })
})
