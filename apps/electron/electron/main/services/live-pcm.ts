import type { RealtimeData } from '@hidock/jensen-protocol'

/** Known stereo capture only. Mixing does not establish speaker identity. */
export function liveStereoToMono(packet: RealtimeData): Buffer {
  const length = packet.data.length - 8
  if (length < 0 || length % 4) throw new Error('Live stereo audio frame is incomplete')
  const mono = Buffer.alloc(length / 2)
  // Qualified H1E microphone mute is already applied by the producer; lane B
  // may still carry audio. Only legacy whole-stream mute suppresses this mix.
  if (packet.microphoneMuted === undefined && packet.muted) return mono
  const source = new DataView(packet.data.buffer, packet.data.byteOffset + 8, length)
  for (let i = 0; i < length / 4; i++) {
    mono.writeInt16LE(Math.round((source.getInt16(i * 4, true) + source.getInt16(i * 4 + 2, true)) / 2), i * 2)
  }
  return mono
}
