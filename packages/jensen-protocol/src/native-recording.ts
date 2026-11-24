/** Exact H1E 6.3.0 contracts corroborated by the vendor client/native dispatcher. */
export interface NativeRecordingStatus {
  recording: string | null
  /** BE16 elapsed seconds, not milliseconds or a PCM frame count. */
  duration: number
  /** Unsigned display levels; no physical source or calibrated dB assignment. */
  samples: number[]
  type: 'recording' | 'whisper' | null
}

export interface NativeRecordingCommandAck {
  result: 'success' | 'failed'
  /** A zero reply acknowledges queueing only; marker persistence is not verified. */
  acknowledgement: 'queued' | 'rejected'
  persistence: 'unverified'
}

/**
 * CMD29: [type, filenameLength, filename..., secondsBE16, levelCount, levels...].
 * An empty successful reply represents inactive state, but the native handler
 * also sends empty on allocation failure. A safety-critical idle decision must
 * corroborate this with CMD18 through the same app transport owner.
 * Malformed/unknown replies return null and MUST NOT be interpreted as idle.
 */
export function parseNativeRecordingStatusPayload(body: Uint8Array): NativeRecordingStatus | null {
  if (body.length === 0) return { recording: null, duration: 0, samples: [], type: null }
  // Both count fields are single bytes, so the complete nonempty body is <=515.
  if (body.length < 5 || body.length > 515 || (body[0] !== 0 && body[0] !== 1)) return null
  const filenameLength = body[1]
  if (filenameLength === 0 || filenameLength > body.length - 5) return null
  const durationOffset = 2 + filenameLength
  const sampleCount = body[durationOffset + 2]
  const sampleOffset = durationOffset + 3
  if (sampleCount !== body.length - sampleOffset) return null
  const filenameBytes = body.subarray(2, durationOffset)
  // A NUL-bearing "filename" cannot establish a meaningful active filename.
  if (filenameBytes.includes(0)) return null
  const recording = Array.from(filenameBytes, byte => String.fromCharCode(byte)).join('')
  return {
    recording,
    duration: (body[durationOffset] << 8) | body[durationOffset + 1],
    samples: Array.from(body.subarray(sampleOffset)),
    type: body[0] === 0 ? 'recording' : 'whisper',
  }
}

/** CMD28's one-byte ACK; success does not mean a marker was appended or persisted. */
export function parseNativeRecordingCommandAck(body: Uint8Array): NativeRecordingCommandAck | null {
  if (body.length !== 1) return null
  const accepted = body[0] === 0
  return {
    result: accepted ? 'success' : 'failed',
    acknowledgement: accepted ? 'queued' : 'rejected',
    persistence: 'unverified',
  }
}
