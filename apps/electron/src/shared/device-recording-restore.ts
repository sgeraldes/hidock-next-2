import type { RecordingRestoreReply } from '@hidock/jensen-protocol'

export interface DeviceRecordingRestoreAssurance {
  ownedRecordingRestoreConsent: true
  audioQuiescent: true
  /** Main-process callers only; renderer IPC accepts the two explicit booleans. */
  signal?: AbortSignal
}
export interface DeviceRecordingRestoreResult {
  sessionId: string | null
  filename: string | null
  totalBytes: number | null
  status: 'rejected-before-dispatch' | 'reply' | 'uncertain' | 'status-unavailable' | 'readback-failed' | 'restore-verified'
  reason: string | null
  commandAttempted: boolean | null
  reply: RecordingRestoreReply | null
  deviceFinished: boolean
  restoreVerified: boolean
}
/** The main process resolves the library source; no renderer file path or bytes. */
export interface DeviceRecordingRestoreAppend { offset: number; count: number }
