import type { OwnedScratchUploadReply } from '@hidock/jensen-protocol'

/** Operator assurance is explicit; the app cannot infer physical audio quiescence. */
export interface DeviceScratchWriteAssurance {
  ownedScratchWriteConsent: true
  audioQuiescent: true
  /** Main-process callers only; renderer IPC cannot pass an AbortSignal. */
  signal?: AbortSignal
}
export interface DeviceScratchUploadDescriptor { totalBytes: number; wholeCrc32: number }
export interface DeviceScratchAppend { offset: number; data: Uint8Array }
export interface DeviceScratchUploadResult {
  sessionId: string | null
  filename: string | null
  totalBytes: number | null
  status: 'rejected-before-dispatch' | 'reply' | 'uncertain' | 'status-unavailable'
  /** Scratch mutation only; STATUS is a read and returns false here. */
  commandAttempted: boolean | null
  reason: string | null
  reply: OwnedScratchUploadReply | null
  finished: boolean
}
