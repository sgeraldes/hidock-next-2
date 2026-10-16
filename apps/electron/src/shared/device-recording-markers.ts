export interface MarkerSubject { kind: 'recording' | 'session'; id: string }
export type MarkerSource = 'manual' | 'shortcut' | 'action' | 'decision' | 'audio-event' | 'native-file'
export interface RecordingMarker {
  id: string; requestId?: string; atMs: number; label?: string; source: MarkerSource
  persistence: 'local-sidecar' | 'native-file'; createdAt: string
  native?: { format: 'HiDockVM'; trailerSha256: string; index: number }
}
export interface AddRecordingMarkerRequest {
  subject: MarkerSubject; requestId: string; atMs?: number; label?: string
  source?: Exclude<MarkerSource, 'native-file'>; target?: 'local' | 'native'
}
export interface MarkerResult {
  status: 'accepted-local' | 'duplicate' | 'unsupported' | 'inactive' | 'full' | 'automation-disabled' | 'rate-limited' | 'invalid'
  marker?: RecordingMarker; reason?: string
}

export interface DeviceRecordingMarkersAPI {
  list(subject: MarkerSubject): Promise<RecordingMarker[]>
  importNative(subject: MarkerSubject): Promise<{ status: 'imported' | 'absent' | 'unsupported'; markers: RecordingMarker[] }>
  getSettings(subject: MarkerSubject): Promise<{ automationEnabled: boolean }>
  setAutomation(subject: MarkerSubject, enabled: boolean): Promise<{ enabled: boolean }>
  add(request: AddRecordingMarkerRequest): Promise<MarkerResult>
}
