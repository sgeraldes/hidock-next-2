import type { RealtimeData } from './jensen-device.js'

/** CMD34 body: 4 bytes big-endian sequenceMinusOne, 4 bytes big-endian microphone mute, then PCM. */
export const REALTIME_CHANNEL_METADATA_BYTES = 8
/** One frame is lane 0 sample then lane 1 sample, each int16 little-endian. */
export const REALTIME_CHANNEL_FRAME_BYTES = 4
/** Host expectation for mode 2. It is not negotiated or measured on the live stream. */
export const REALTIME_CHANNEL_SAMPLE_RATE_HZ = 16000
export const REALTIME_CHANNEL_IDS = ['channel-0', 'channel-1'] as const

export type RealtimeChannelId = (typeof REALTIME_CHANNEL_IDS)[number]

export interface RealtimeChannelPcm {
  /** Neutral lane id. Not a microphone/system label. */
  id: RealtimeChannelId
  /** Mono PCM16LE, `frameCount * 2` bytes, in its own ArrayBuffer. */
  pcm: Uint8Array
}

export interface RealtimeChannelsTap {
  sequenceMinusOne: number
  microphoneMuted: boolean
  frameCount: number
  sampleRateHz: typeof REALTIME_CHANNEL_SAMPLE_RATE_HZ
  sampleRateEvidence: 'host-expectation'
  pcmFormat: 'pcm16le-mono'
  channels: [RealtimeChannelPcm, RealtimeChannelPcm]
  /** Bytes after the last whole 4-byte frame. They are not delivered in either lane. */
  droppedTrailingBytes: number
}

/**
 * De-interleaves one accepted CMD34 packet into two independent mono PCM16LE buffers.
 *
 * Lane 0 is the first int16 of each 4-byte frame and lane 1 the second, the same split
 * `splitRealtimeChannels` applies for ASR. Bytes are copied, never reinterpreted, so signed
 * extrema and byte order are exact, and `packet.data` is not modified.
 * Returns null when the packet has no whole frame after the 8 metadata bytes.
 */
export function splitRealtimeChannelsTap(packet: RealtimeData): RealtimeChannelsTap | null {
  const data = packet.data
  if (!(data instanceof Uint8Array)) return null
  const payloadBytes = data.length - REALTIME_CHANNEL_METADATA_BYTES
  if (payloadBytes < REALTIME_CHANNEL_FRAME_BYTES) return null

  const frameCount = Math.floor(payloadBytes / REALTIME_CHANNEL_FRAME_BYTES)
  const lane0 = new Uint8Array(frameCount * 2)
  const lane1 = new Uint8Array(frameCount * 2)
  for (let frame = 0; frame < frameCount; frame++) {
    const source = REALTIME_CHANNEL_METADATA_BYTES + frame * REALTIME_CHANNEL_FRAME_BYTES
    const target = frame * 2
    lane0[target] = data[source]
    lane0[target + 1] = data[source + 1]
    lane1[target] = data[source + 2]
    lane1[target + 1] = data[source + 3]
  }

  return {
    sequenceMinusOne: packet.sequenceMinusOne ?? packet.rest,
    microphoneMuted: packet.microphoneMuted ?? packet.muted,
    frameCount,
    sampleRateHz: REALTIME_CHANNEL_SAMPLE_RATE_HZ,
    sampleRateEvidence: 'host-expectation',
    pcmFormat: 'pcm16le-mono',
    channels: [
      { id: REALTIME_CHANNEL_IDS[0], pcm: lane0 },
      { id: REALTIME_CHANNEL_IDS[1], pcm: lane1 },
    ],
    droppedTrailingBytes: payloadBytes - frameCount * REALTIME_CHANNEL_FRAME_BYTES,
  }
}
