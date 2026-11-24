/** Physical file facts from a bounded header read; never inferred from a suffix. */
export type AudioFact<T> =
  | { known: true; value: T; provenance: string }
  | { known: false; reason: string }

export interface RecordingAudioMetadata {
  status: 'verified' | 'unverified' | 'truncated' | 'invalid' | 'unsupported' | 'source-changed' | 'error'
  statusReason: string | null
  byteLength: number | null
  container: AudioFact<'riff-wave' | 'mpeg-audio'>
  codec: AudioFact<'pcm_s16le' | 'mp3'>
  channelCount: AudioFact<1 | 2>
  sampleRateHz: AudioFact<number>
  bitDepth: AudioFact<16>
  nominalBitrateBps: AudioFact<number>
  averageBitrateBps: AudioFact<number>
  bitrateMode: AudioFact<'constant' | 'variable'>
  durationMs: AudioFact<number>
}
