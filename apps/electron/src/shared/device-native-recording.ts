export interface DeviceNativeRecordingStatus {
  recording: string | null
  duration: number
  samples: number[]
  type: 'recording' | 'whisper' | null
}
export interface NativeRecordingRequest {
  requestId: string
  /** null is permitted only when starting a new native recording. */
  expectedRecording: string | null
}
export interface NativeRecordingDispatch {
  status: 'acknowledged' | 'inconclusive' | 'rejected' | 'duplicate'
  persistence: 'unverified'
  previousStatus?: 'acknowledged' | 'inconclusive' | 'rejected'
  recording?: string
  manualOnly?: true
  error?: string
}
