/**
 * Source-only codec for the proposed H1E native voice-energy observation.
 * This module is not yet exported from the package index or wired to USB.
 * Its fields describe the encoded cache snapshot only; no voice, source,
 * freshness, time, or image identity is inferred.
 */

export const NATIVE_VOICE_ENERGY_OBSERVATION_COMMAND = 0xf11a
export const NATIVE_VOICE_ENERGY_OBSERVATION_REPLY_BYTES = 32
export const NATIVE_VOICE_ENERGY_OBSERVATION_VERSION = 2
export const NATIVE_VOICE_ENERGY_OBSERVATION_REQUEST_BYTES = 1
export const NATIVE_VOICE_ENERGY_HAS_SAMPLE = 0x01

export const NATIVE_VOICE_ENERGY_STATUS_OK = 0
export const NATIVE_VOICE_ENERGY_STATUS_BUSY = 1
export const NATIVE_VOICE_ENERGY_STATUS_UNAVAILABLE = 2

export type NativeVoiceEnergyStatus = 0 | 1 | 2

export interface NativeVoiceEnergyObservation {
  version: 2
  status: NativeVoiceEnergyStatus
  hasSample: boolean
  attempts: number
  successes: number
  providerStatus: number
  /** Null until HAS_SAMPLE is set; zero is a valid raw word. */
  raw: number | null
  sequence: number
  voice: 'unknown'
  source: 'unknown'
  freshness: 'unknown'
  age: null
  imageAttested: false
}

export type NativeVoiceEnergyDecodeErrorCode =
  | 'invalid-type'
  | 'invalid-length'
  | 'invalid-status'
  | 'invalid-version'
  | 'unknown-flags'
  | 'reserved-nonzero'
  | 'non-ok-payload-nonempty'
  | 'odd-sequence'
  | 'unsampled-payload-nonzero'

export class NativeVoiceEnergyDecodeError extends Error {
  readonly code: NativeVoiceEnergyDecodeErrorCode

  constructor(code: NativeVoiceEnergyDecodeErrorCode) {
    super(`Invalid native voice-energy reply: ${code}`)
    this.name = 'NativeVoiceEnergyDecodeError'
    this.code = code
  }
}

/** Encode the exact one-byte selector request. This function sends nothing. */
export function encodeNativeVoiceEnergyObservationRequest(): Uint8Array {
  return Uint8Array.of(NATIVE_VOICE_ENERGY_OBSERVATION_VERSION)
}

/**
 * Strictly decode the C v2 32-byte payload in big-endian field order.
 * Throws only NativeVoiceEnergyDecodeError for malformed or incoherent data.
 */
export function decodeNativeVoiceEnergyObservationReply(body: Uint8Array): NativeVoiceEnergyObservation {
  if (!(body instanceof Uint8Array)) throw new NativeVoiceEnergyDecodeError('invalid-type')
  if (body.byteLength !== NATIVE_VOICE_ENERGY_OBSERVATION_REPLY_BYTES) {
    throw new NativeVoiceEnergyDecodeError('invalid-length')
  }

  const statusByte = body[0]
  if (statusByte > NATIVE_VOICE_ENERGY_STATUS_UNAVAILABLE) {
    throw new NativeVoiceEnergyDecodeError('invalid-status')
  }
  if (body[1] !== NATIVE_VOICE_ENERGY_OBSERVATION_VERSION) {
    throw new NativeVoiceEnergyDecodeError('invalid-version')
  }

  const flags = body[2]
  if ((flags & ~NATIVE_VOICE_ENERGY_HAS_SAMPLE) !== 0) {
    throw new NativeVoiceEnergyDecodeError('unknown-flags')
  }
  if (body[3] !== 0 || body.subarray(24).some((value) => value !== 0)) {
    throw new NativeVoiceEnergyDecodeError('reserved-nonzero')
  }

  const status = statusByte as NativeVoiceEnergyStatus
  const hasSample = (flags & NATIVE_VOICE_ENERGY_HAS_SAMPLE) !== 0
  if (statusByte !== NATIVE_VOICE_ENERGY_STATUS_OK) {
    if (body.subarray(2).some((value) => value !== 0)) {
      throw new NativeVoiceEnergyDecodeError('non-ok-payload-nonempty')
    }
    return {
      version: NATIVE_VOICE_ENERGY_OBSERVATION_VERSION,
      status,
      hasSample: false,
      attempts: 0,
      successes: 0,
      providerStatus: 0,
      raw: null,
      sequence: 0,
      voice: 'unknown',
      source: 'unknown',
      freshness: 'unknown',
      age: null,
      imageAttested: false
    }
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const attempts = view.getUint32(4, false)
  const successes = view.getUint32(8, false)
  const providerStatus = view.getInt32(12, false)
  const rawWord = view.getUint32(16, false)
  const sequence = view.getUint32(20, false)

  if ((sequence & 1) !== 0) throw new NativeVoiceEnergyDecodeError('odd-sequence')
  if (!hasSample && (successes !== 0 || rawWord !== 0)) {
    throw new NativeVoiceEnergyDecodeError('unsampled-payload-nonzero')
  }

  return {
    version: NATIVE_VOICE_ENERGY_OBSERVATION_VERSION,
    status,
    hasSample,
    attempts,
    successes,
    providerStatus,
    raw: hasSample ? rawWord : null,
    sequence,
    voice: 'unknown',
    source: 'unknown',
    freshness: 'unknown',
    age: null,
    imageAttested: false
  }
}

/**
 * V1-style boundary for a future SDK caller: malformed replies become null
 * rather than exceptions that could escape the transport/IPC method.
 */
export function parseNativeVoiceEnergyObservationReply(body: Uint8Array): NativeVoiceEnergyObservation | null {
  try {
    return decodeNativeVoiceEnergyObservationReply(body)
  } catch (error) {
    if (error instanceof NativeVoiceEnergyDecodeError) return null
    throw error
  }
}
