/** Source roles describe wiring, never a person or a voice identity. */
export type RecordedAudioRole = 'unknown' | 'microphone' | 'system'
export interface RecordedAudioRoleMapping {
  evidence: 'user-confirmed' | 'verified-recorded-metadata'
  /** Parent validates this evidence against the recording, not today's device settings. */
  evidenceId: string
  roles: RecordedAudioRole[]
}
export interface RecordedAudioLayout {
  container: 'wav' | 'mp3' | 'riff-mpeg' | 'ogg' | 'flac' | 'mp4' | 'webm'
  codec: string
  channels: number
  sampleRate: number
  durationSeconds: number
  durationSource: 'decoder-probe' | 'decoded-frames'
  bitrateKbps?: number
  originalSha256: string
}
export interface RecordedAudioChannel {
  id: string
  channelIndex: number
  path: string
  sampleRate: 16000
  frames: number
  durationSeconds: number
  sourceRole: RecordedAudioRole
  mappingEvidence: RecordedAudioRoleMapping | null
  timelineOffsetSeconds: 0
}
