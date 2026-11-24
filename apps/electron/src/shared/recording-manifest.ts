import { z } from 'zod'
import type { RecordedAudioLayout } from './recorded-audio-layout'

/** UTF-8 byte length without allocating, or null when the string holds a lone surrogate (TextEncoder would silently substitute U+FFFD). */
function strictUtf8ByteLength(value: string): number | null {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return null
      bytes += 4
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null
    else bytes += 3
  }
  return bytes
}
const withinUtf8Bytes = (value: string, max: number): boolean => {
  const bytes = strictUtf8ByteLength(value)
  return bytes !== null && bytes <= max
}

const hasControlCharacter = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).refine(value =>
  withinUtf8Bytes(value, 128) && !hasControlCharacter(value))
const rate = z.number().int().positive().max(192000)
const clock = z.object({ sampleRateHz: rate, frameCount: safeInteger.refine(value => value > 0),
  encoderDelayFrames: safeInteger, encoderPaddingFrames: safeInteger }).strict().refine(value =>
  Number.isSafeInteger(value.frameCount + value.encoderDelayFrames + value.encoderPaddingFrames))

/** The decoded track is always 16 kHz and its measured duration is decodedFrames / 16000, with no rounding. */
const DECODED_RATE_HZ = 16000

/**
 * A claimed PCM frame count matches the measured decoded duration only through the exact relation
 * frames / 16000. The sole slack is a few floating-point ULPs scaled to the magnitude. Once that
 * slack reaches half a sample, double precision can no longer safely distinguish adjacent frames,
 * so the comparison fails closed regardless of whether the supplied values look equal.
 */
const FLOAT_ULPS = 4
const HALF_SAMPLE_PERIOD_SECONDS = 0.5 / DECODED_RATE_HZ
const clockMatchesMeasuredDuration = (value: z.infer<typeof clock>, durationSeconds: number): boolean => {
  const expected = value.frameCount / DECODED_RATE_HZ
  const allowedSlack = FLOAT_ULPS * Number.EPSILON * Math.max(expected, durationSeconds)
  return allowedSlack < HALF_SAMPLE_PERIOD_SECONDS && Math.abs(expected - durationSeconds) <= allowedSlack
}
const marker = z.object({ markerId: identifier.nullable(), type: z.enum(['unknown', 'manual', 'automatic']),
  label: z.string().optional().refine(value => value === undefined || withinUtf8Bytes(value, 256)),
  position: z.object({ unit: z.enum(['capture-frame', 'legacy-ms']), value: safeInteger }).strict() }).strict()
const manifest = z.object({
  schemaVersion: z.literal(1), recordingId: identifier, contentGeneration: identifier,
  state: z.enum(['open', 'finalized']),
  file: z.object({ name: z.string().min(1).refine(value =>
    withinUtf8Bytes(value, 255) && !/[\\/]/.test(value) && !hasControlCharacter(value) && !['.', '..'].includes(value)),
    byteLength: safeInteger, sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  audio: z.object({ container: z.enum(['wav', 'mp3', 'riff-mpeg']), codec: z.enum(['pcm_s16le', 'mp3']),
    sampleRateHz: rate, channels: z.union([z.literal(1), z.literal(2)]),
    bitsPerSample: z.literal(16).optional(), bitrateKbps: z.union([
      z.literal(64), z.literal(96), z.literal(128), z.literal(160)]).optional(),
    clock: clock.nullable(), sourceMap: z.array(z.object({channelIndex: z.union([z.literal(0), z.literal(1)]),
      role: z.enum(['unknown', 'microphone', 'system'])}).strict()).min(1).max(2) }).strict(),
  markers: z.array(marker).max(1000)
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({code: 'custom', message})
  if (value.state === 'finalized' ? !value.file.sha256 || !value.file.byteLength : value.file.sha256 !== undefined)
    reject('Invalid finalization/digest contract')
  const audio = value.audio
  if (audio.container === 'wav' ? audio.codec !== 'pcm_s16le' || audio.bitsPerSample !== 16 || audio.bitrateKbps !== undefined :
      audio.codec !== 'mp3' || audio.bitsPerSample !== undefined || audio.bitrateKbps === undefined)
    reject('Container/codec properties disagree')
  if (audio.sourceMap.length !== audio.channels || new Set(audio.sourceMap.map(row => row.channelIndex)).size !== audio.channels ||
      audio.sourceMap.some(row => row.channelIndex >= audio.channels)) reject('Source channel map is incomplete')
  const identifiedMarkers = value.markers.filter(row => row.markerId !== null)
  if (new Set(identifiedMarkers.map(row => row.markerId)).size !== identifiedMarkers.length) reject('Duplicate marker identity')
  for (const row of value.markers) {
    if (row.position.unit === 'capture-frame' && (!row.markerId || !audio.clock || row.position.value > audio.clock.frameCount))
      reject('Frame marker requires a measured capture clock')
    if (row.position.unit === 'legacy-ms' && audio.clock &&
        row.position.value > 1000 * audio.clock.frameCount / audio.clock.sampleRateHz) reject('Marker exceeds capture duration')
  }
})

export type RecordingManifest = z.infer<typeof manifest>

/** Supplied independently of manifest claims, by the measurement/calibration owner. */
export interface RecordingClockEvidence {
  originalSha256: string
  evidenceId: string
  source: 'pcm-frame-measurement' | 'independent-encoder-calibration'
  clock: z.infer<typeof clock>
}

/** Proposed v1 structural validation only. This does not establish firmware origin. */
export function parseRecordingManifest(payload: string): RecordingManifest {
  const payloadBytes = strictUtf8ByteLength(payload)
  if (payloadBytes === null) throw new Error('Unsupported or invalid recording manifest v1: malformed Unicode')
  if (payloadBytes > 65536) throw new Error('Recording manifest exceeds 64 KiB')
  let value: unknown
  try { value = JSON.parse(payload) } catch { throw new Error('Invalid recording manifest JSON') }
  const result = manifest.safeParse(value)
  if (!result.success) throw new Error('Unsupported or invalid recording manifest v1')
  return result.data
}

/** Full-artifact binding, not authenticity: the transport owner must separately attest origin. */
export function assertRecordingManifestBinding(value: RecordingManifest, measured: {
  sha256: string; byteLength: number; layout: RecordedAudioLayout; clockEvidence?: RecordingClockEvidence
}): void {
  if (value.state !== 'finalized') throw new Error('Open recording cannot be associated as a finalized artifact')
  const layout = measured.layout
  if (value.file.sha256 !== measured.sha256 || layout.originalSha256 !== measured.sha256 ||
      value.file.byteLength !== measured.byteLength || value.audio.container !== layout.container ||
      value.audio.codec !== layout.codec || value.audio.channels !== layout.channels ||
      value.audio.sampleRateHz !== layout.sampleRate) throw new Error('Recording manifest does not match the downloaded original')
  if (!Number.isFinite(layout.durationSeconds) || layout.durationSeconds <= 0)
    throw new Error('Recording measured duration is not a positive finite number')
  if (value.audio.clock) {
    if (value.audio.clock.sampleRateHz !== layout.sampleRate) {
      throw new Error('Recording capture clock rate differs from the decoded audio rate and v1 has no independent capture-to-decoded relation')
    }
    if (value.audio.clock.sampleRateHz !== DECODED_RATE_HZ) {
      throw new Error('Recording capture clock at a source rate other than 16000 Hz needs a resampling relation v1 cannot express; use a null clock')
    }
    if (layout.container !== 'wav') {
      throw new Error('Recording capture clock cannot be tied to MPEG decoded duration by any independent v1 evidence; use a null clock')
    }
    if (layout.durationSource !== 'decoded-frames') {
      throw new Error('Recording capture clock needs a duration counted from decoded frames, not a decoder probe estimate; use a null clock')
    }
    if (!clockMatchesMeasuredDuration(value.audio.clock, layout.durationSeconds)) {
      throw new Error('Recording clock frame count contradicts the measured decoded duration')
    }
    const proof = measured.clockEvidence
    const measuredClock = proof && clock.safeParse(proof.clock)
    const claim = value.audio.clock
    const evidenceIdOk = proof !== undefined && typeof proof.evidenceId === 'string' && proof.evidenceId.trim() !== '' &&
      withinUtf8Bytes(proof.evidenceId, 128) && !hasControlCharacter(proof.evidenceId)
    if (!proof || !evidenceIdOk || !measuredClock || !measuredClock.success ||
        proof.originalSha256 !== measured.sha256 ||
        (layout.container === 'wav' ? proof.source !== 'pcm-frame-measurement' ||
          claim.encoderDelayFrames !== 0 || claim.encoderPaddingFrames !== 0 :
          proof.source !== 'independent-encoder-calibration') ||
        claim.sampleRateHz !== proof.clock.sampleRateHz || claim.frameCount !== proof.clock.frameCount ||
        claim.encoderDelayFrames !== proof.clock.encoderDelayFrames ||
        claim.encoderPaddingFrames !== proof.clock.encoderPaddingFrames) {
      throw new Error('Recording capture clock lacks matching independent measurement/calibration')
    }
  }
  for (const row of value.markers) if (row.position.unit === 'legacy-ms' && row.position.value > layout.durationSeconds * 1000)
    throw new Error('Recording marker exceeds measured audio duration')
}
