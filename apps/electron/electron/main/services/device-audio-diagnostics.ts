import type { RealtimeData } from '@hidock/jensen-protocol'

export const DEVICE_AUDIO_EXPECTED_FORMAT = {
  sampleRate: 16000, channels: 2, bitsPerSample: 16, encoding: 'pcm16le',
  provenance: 'host-expectation', physicalSourceMapping: 'unverified'
} as const

export interface DeviceAudioSnapshot {
  format: typeof DEVICE_AUDIO_EXPECTED_FORMAT
  channelIds: ['channel-0', 'channel-1']
  packets: number
  acceptedPackets: number
  rejectedPackets: number
  rejectedBytes: number
  mutedPackets: number
  frames: number
  sampleElapsedMs: number
  firstReceivedAtMs: number | null
  lastReceivedAtMs: number | null
  maximumArrivalGapMs: number
  lastRest: number | null
  maximumRest: number
  channels: Array<{ id: string; rms: number; peak: number; clippedSamples: number; activeSamples: number }>
  correlation: number | null
  windowDelay: { frames: number; correlation: number; maximumLagFrames: number; windowFrames: number } | null
  discontinuities: Array<{ reason: string; atFrame: number }>
  discontinuityCount: number
  droppedDiscontinuityDetails: number
  sourceIsolation: 'unverified'
}

/** Sample statistics are bounded and never assign microphone/speaker identities.
 * Correlation/delay are signal similarities, not proof of source isolation. */
export class DeviceAudioDiagnostics {
  private packets = 0
  private acceptedPackets = 0
  private rejectedPackets = 0
  private rejectedBytes = 0
  private mutedPackets = 0
  private frames = 0
  private firstReceivedAtMs: number | null = null
  private lastReceivedAtMs: number | null = null
  private maximumArrivalGapMs = 0
  private lastRest: number | null = null
  private maximumRest = 0
  private sums = [0, 0]
  private squares = [0, 0]
  private peaks = [0, 0]
  private clipped = [0, 0]
  private active = [0, 0]
  private cross = 0
  private window = [new Float64Array(2048), new Float64Array(2048)]
  private windowIndex = 0
  private windowFrames = 0
  private discontinuities: Array<{ reason: string; atFrame: number }> = []
  private discontinuityCount = 0

  reset(): void {
    this.packets = this.acceptedPackets = this.rejectedPackets = this.rejectedBytes = this.mutedPackets = this.frames = 0
    this.firstReceivedAtMs = this.lastReceivedAtMs = null
    this.lastRest = null
    this.maximumRest = 0
    this.maximumArrivalGapMs = this.cross = this.windowIndex = this.windowFrames = this.discontinuityCount = 0
    this.sums.fill(0); this.squares.fill(0); this.peaks.fill(0); this.clipped.fill(0); this.active.fill(0)
    this.discontinuities = []
    this.window.forEach((channel) => channel.fill(0))
  }

  noteDiscontinuity(reason: string): void {
    this.discontinuityCount++
    if (this.discontinuities.length < 64) this.discontinuities.push({ reason: reason.slice(0, 160), atFrame: this.frames })
  }

  /** Returns whether this packet is a complete frame sequence in the expected format.
   * Arrival gaps do not establish dropped samples; the producer sequence value
   * alone does not establish dequeued packet size, wrap behavior or loss. */
  observe(packet: RealtimeData, receivedAtMs?: number): boolean {
    this.packets++
    if (Number.isFinite(packet.rest) && packet.rest >= 0) {
      this.lastRest = packet.rest
      this.maximumRest = Math.max(this.maximumRest, packet.rest)
    }
    if (packet.muted) this.mutedPackets++
    if (receivedAtMs !== undefined && Number.isFinite(receivedAtMs)) {
      this.firstReceivedAtMs ??= receivedAtMs
      if (this.lastReceivedAtMs !== null) this.maximumArrivalGapMs = Math.max(this.maximumArrivalGapMs, receivedAtMs - this.lastReceivedAtMs)
      this.lastReceivedAtMs = receivedAtMs
    }
    const bytes = packet.data.length - 8
    if (bytes < 0 || bytes % 4 !== 0) {
      this.rejectedPackets++
      this.rejectedBytes += Math.max(0, bytes)
      this.noteDiscontinuity('invalid-pcm-frame-alignment')
      return false
    }
    this.acceptedPackets++
    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength)
    for (let offset = 8; offset < packet.data.length; offset += 4) {
      const pair = [view.getInt16(offset, true), view.getInt16(offset + 2, true)]
      for (let channel = 0; channel < 2; channel++) {
        const sample = pair[channel]
        this.sums[channel] += sample
        this.squares[channel] += sample * sample
        this.peaks[channel] = Math.max(this.peaks[channel], Math.abs(sample))
        if (sample === -32768 || sample === 32767) this.clipped[channel]++
        if (Math.abs(sample) >= 128) this.active[channel]++
        this.window[channel][this.windowIndex] = sample
      }
      this.cross += pair[0] * pair[1]
      this.windowIndex = (this.windowIndex + 1) % this.window[0].length
      this.windowFrames = Math.min(this.windowFrames + 1, this.window[0].length)
      this.frames++
    }
    return true
  }

  snapshot(): DeviceAudioSnapshot {
    const n = this.frames
    const variance = this.squares.map((square, channel) => n ? square - this.sums[channel] ** 2 / n : 0)
    const denominator = Math.sqrt(Math.max(0, variance[0]) * Math.max(0, variance[1]))
    return {
      format: DEVICE_AUDIO_EXPECTED_FORMAT, channelIds: ['channel-0', 'channel-1'],
      packets: this.packets, acceptedPackets: this.acceptedPackets, rejectedPackets: this.rejectedPackets,
      rejectedBytes: this.rejectedBytes, mutedPackets: this.mutedPackets, frames: n,
      sampleElapsedMs: n * 1000 / DEVICE_AUDIO_EXPECTED_FORMAT.sampleRate,
      firstReceivedAtMs: this.firstReceivedAtMs, lastReceivedAtMs: this.lastReceivedAtMs,
      maximumArrivalGapMs: this.maximumArrivalGapMs,
      lastRest: this.lastRest, maximumRest: this.maximumRest,
      channels: [0, 1].map((channel) => ({ id: `channel-${channel}`, rms: n ? Math.sqrt(this.squares[channel] / n) / 32768 : 0,
        peak: this.peaks[channel] / 32768, clippedSamples: this.clipped[channel], activeSamples: this.active[channel] })),
      correlation: denominator > 0 ? Math.max(-1, Math.min(1, (this.cross - this.sums[0] * this.sums[1] / n) / denominator)) : null,
      windowDelay: this.measureDelay(), discontinuities: this.discontinuities.map((item) => ({ ...item })),
      discontinuityCount: this.discontinuityCount,
      droppedDiscontinuityDetails: this.discontinuityCount - this.discontinuities.length, sourceIsolation: 'unverified'
    }
  }

  private measureDelay(): DeviceAudioSnapshot['windowDelay'] {
    const count = this.windowFrames
    if (count < 64) return null
    const start = (this.windowIndex - count + this.window[0].length) % this.window[0].length
    const channels = this.window.map((channel) => Array.from({ length: count }, (_, index) => channel[(start + index) % channel.length]))
    const limit = Math.min(64, Math.floor(count / 4))
    let best: { frames: number; correlation: number } | null = null
    for (let lag = -limit; lag <= limit; lag++) {
      let a = 0, b = 0, aa = 0, bb = 0, ab = 0, n = 0
      for (let index = Math.max(0, -lag); index < Math.min(count, count - lag); index++) {
        const left = channels[0][index], right = channels[1][index + lag]
        a += left; b += right; aa += left * left; bb += right * right; ab += left * right; n++
      }
      const denominator = Math.sqrt(Math.max(0, aa - a * a / n) * Math.max(0, bb - b * b / n))
      if (!denominator) continue
      const correlation = Math.max(-1, Math.min(1, (ab - a * b / n) / denominator))
      if (!best || Math.abs(correlation) > Math.abs(best.correlation)) best = { frames: lag, correlation }
    }
    return best ? { ...best, maximumLagFrames: limit, windowFrames: count } : null
  }
}
