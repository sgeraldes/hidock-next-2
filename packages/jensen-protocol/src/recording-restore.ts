import { ownedScratchCrc32 } from './owned-scratch-upload.js'

/** Prospective RSTR2 ABI only; current installation pins are not changed. */
export const RECORDING_RESTORE_COMMAND = 0xf119
export const RECORDING_RESTORE_MAX_BYTES = 0x7fffffff
export const RECORDING_RESTORE_VERSION = 393988
export interface RecordingRestoreDescriptor {
  restoreId: number; ownerToken: Uint8Array; totalBytes: number; wholeCrc32: number; sourceSha256: Uint8Array; filename: string
}
export interface RecordingRestoreSession extends RecordingRestoreDescriptor {
  readonly serialNumber: string; readonly connectionSessionId: number; readonly versionNumber: 393988
}
export type RecordingRestoreOperation = { operation: 'begin' | 'verify-commit-step' | 'abort' | 'recover-step' } |
  { operation: 'append'; offset: number; data: Uint8Array }
export type RecordingRestoreRequest = RecordingRestoreOperation | { operation: 'status' }
export interface RecordingRestoreCapabilities {
  protocol: 1; filenameMaxBytes: 27; fileMaxBytes: 2147483647; chunkMaxBytes: 1024; nonfinalMinBytes: 512;
  verificationBudgetBytes: 4096; featureFlags: 63; journalTotalBytes: 1024; imageAttested: false
}
export interface RecordingRestoreReply {
  acknowledgement: 'accepted' | 'rejected'; stateCode: number; reasonCode: number;
  state: 'absent' | 'receiving' | 'verify-tmp' | 'ready-rename' | 'verify-final' | 'finished' | 'recover-prefix' | 'manual-ambiguity';
  checkpoint: 'unavailable-preoperation-hint' | 'validated-binding';
  metadata: { uploadedBytes: number; verifiedBytes: number; totalBytes: number; wholeCrc32: number; sourceSha256: Uint8Array; filename: string } | null;
  recovery: 'none' | 'read-only-status-required' | 'explicit-recover-step-required' | 'manual-investigation-required';
  deviceFinished: boolean; hostFullSha256ReadbackRequired: true; sha256Provenance: 'stored-expected' | null;
  persistence: 'unverified'; imageAttested: false
}
export interface RecordingRestoreWriteOptions {
  ownedRecordingRestoreConsent: true; normalJensen: true; massStorageInactive: true; audioQuiescent: true;
  timeout?: number; signal?: AbortSignal
}
export type RecordingRestoreWriteOutcome = { status: 'rejected-before-dispatch'; commandAttempted: false; reason: string } |
  { status: 'reply'; commandAttempted: true; reply: RecordingRestoreReply } |
  { status: 'uncertain'; commandAttempted: true; reason: string }
const unsigned = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, i) => value === right[i])
const emptySha = Uint8Array.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.match(/../g)!, value => parseInt(value, 16))
export function isRecordingRestoreFilename(name: string): boolean {
  return typeof name === 'string' && name.length >= 1 && name.length <= 27 && /^[\x20-\x7e]+$/.test(name) &&
    !name.startsWith('.') && !/[\\/:*?"<>|]/.test(name) && !/[. ]$/.test(name) && /\.(hda|wav)$/.test(name)
}
export function isRecordingRestoreDescriptor(value: RecordingRestoreDescriptor): boolean {
  return !!value && unsigned(value.restoreId) && value.restoreId !== 0 && value.ownerToken instanceof Uint8Array && value.ownerToken.length === 16 &&
    value.ownerToken.some(byte => byte !== 0) && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0 && value.totalBytes <= RECORDING_RESTORE_MAX_BYTES &&
    unsigned(value.wholeCrc32) && value.sourceSha256 instanceof Uint8Array && value.sourceSha256.length === 32 && isRecordingRestoreFilename(value.filename) &&
    (value.totalBytes !== 0 || value.wholeCrc32 === 0 && equal(value.sourceSha256, emptySha))
}
export function copyRecordingRestoreDescriptor(value: RecordingRestoreDescriptor): RecordingRestoreDescriptor | null {
  if (!isRecordingRestoreDescriptor(value)) return null
  return { ...value, ownerToken: value.ownerToken.slice(), sourceSha256: value.sourceSha256.slice() }
}
export function encodeRecordingRestore(value: RecordingRestoreDescriptor, request: RecordingRestoreRequest): Uint8Array {
  if (!isRecordingRestoreDescriptor(value) || !request) throw Error('Invalid recording restore binding')
  const op = request.operation === 'begin' ? 0 : request.operation === 'append' ? 1 : request.operation === 'verify-commit-step' ? 2 :
    request.operation === 'abort' ? 3 : request.operation === 'status' ? 4 : request.operation === 'recover-step' ? 6 : -1
  if (op < 0) throw Error('Unsupported recording restore operation')
  let data: Uint8Array | null = null
  if (request.operation === 'append') {
    if (!(request.data instanceof Uint8Array) || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > value.totalBytes ||
      request.data.length < 1 || request.data.length > 1024 || request.data.length > value.totalBytes - request.offset ||
      request.data.length < 512 && request.data.length !== value.totalBytes - request.offset) throw Error('Invalid recording restore append bounds')
    data = request.data.slice()
  }
  const bytes = new Uint8Array(op === 0 ? 62 + value.filename.length : op === 1 ? 29 + data!.length : 21), view = new DataView(bytes.buffer)
  bytes[0] = op; view.setUint32(1, value.restoreId); bytes.set(value.ownerToken, 5)
  if (op === 0) {
    view.setUint32(21, value.totalBytes); view.setUint32(25, value.wholeCrc32); bytes.set(value.sourceSha256, 29)
    bytes[61] = value.filename.length; bytes.set(new TextEncoder().encode(value.filename), 62)
  }
  if (op === 1 && request.operation === 'append') { view.setUint32(21, request.offset); view.setUint32(25, ownedScratchCrc32(data!)); bytes.set(data!, 29) }
  return bytes
}
export function parseRecordingRestoreCapabilities(bytes: Uint8Array): RecordingRestoreCapabilities | null {
  if (bytes.length !== 24 || bytes[0] !== 0 || !equal(bytes.subarray(1, 6), new TextEncoder().encode('RSTR2')) || bytes[6] !== 1 || bytes[7] !== 27) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 0x7fffffff || view.getUint16(12) !== 1024 || view.getUint16(14) !== 512 || view.getUint16(16) !== 4096 ||
    view.getUint16(18) !== 63 || view.getUint32(20) !== 1024) return null
  return { protocol: 1, filenameMaxBytes: 27, fileMaxBytes: 2147483647, chunkMaxBytes: 1024, nonfinalMinBytes: 512,
    verificationBudgetBytes: 4096, featureFlags: 63, journalTotalBytes: 1024, imageAttested: false }
}
/** Capabilities and validated-owner STATUS only; RECOVER is a mutation. */
export function isRecordingRestoreReadOnlyBody(body: readonly number[] | Uint8Array): boolean {
  if (Array.from(body).some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return body.length === 1 && body[0] === 5 || body.length === 21 && body[0] === 4 &&
    body.slice(1, 5).some(value => value !== 0) && body.slice(5, 21).some(value => value !== 0)
}
export function parseRecordingRestoreReply(value: RecordingRestoreDescriptor, request: RecordingRestoreRequest, bytes: Uint8Array): RecordingRestoreReply | null {
  if (!isRecordingRestoreDescriptor(value) || !request || bytes.length < 4 || bytes[0] > 1 || bytes[1] > 7) return null
  try { encodeRecordingRestore(value, request) } catch { return null }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), reason = view.getUint16(2)
  if (reason > 14 || bytes[0] === 0 && reason !== 0 || bytes[0] === 1 && reason === 0) return null
  const base: RecordingRestoreReply = { acknowledgement: bytes[0] === 0 ? 'accepted' : 'rejected', stateCode: bytes[1], reasonCode: reason,
    state: (['absent', 'receiving', 'verify-tmp', 'ready-rename', 'verify-final', 'finished', 'recover-prefix', 'manual-ambiguity'] as const)[bytes[1]],
    checkpoint: 'unavailable-preoperation-hint', metadata: null, recovery: reason === 8 ? 'explicit-recover-step-required' :
      reason === 10 || reason === 11 ? 'manual-investigation-required' : 'none',
    deviceFinished: false, hostFullSha256ReadbackRequired: true, sha256Provenance: null, persistence: 'unverified', imageAttested: false }
  if (bytes.length === 4) return bytes[0] === 1 ? { ...base,
    recovery: base.recovery === 'manual-investigation-required' ? base.recovery : 'read-only-status-required' } : null
  if (bytes.length < 54 || bytes.length !== 53 + bytes[52] || bytes[52] > 27 || bytes[0] === 1 && request.operation !== 'status') return null
  const filename = String.fromCharCode(...bytes.subarray(53)), uploadedBytes = view.getUint32(4), verifiedBytes = view.getUint32(8)
  const totalBytes = view.getUint32(12), wholeCrc32 = view.getUint32(16), sourceSha256 = bytes.slice(20, 52)
  if (!isRecordingRestoreFilename(filename) || filename !== value.filename || totalBytes !== value.totalBytes || wholeCrc32 !== value.wholeCrc32 ||
    !equal(sourceSha256, value.sourceSha256) || uploadedBytes > totalBytes || verifiedBytes > uploadedBytes) return null
  if (bytes[0] === 0) {
    if (bytes[1] === 7 || request.operation === 'begin' && (bytes[1] !== 1 || uploadedBytes !== 0 || verifiedBytes !== 0) ||
      request.operation === 'append' && (bytes[1] !== 1 || uploadedBytes !== request.offset + request.data.length) ||
      request.operation === 'abort' && (bytes[1] !== 0 || uploadedBytes !== 0 || verifiedBytes !== 0) ||
      (bytes[1] === 3 || bytes[1] === 5) && (uploadedBytes !== totalBytes || verifiedBytes !== totalBytes)) return null
  }
  return { ...base, checkpoint: 'validated-binding', metadata: { uploadedBytes, verifiedBytes, totalBytes, wholeCrc32, sourceSha256, filename },
    deviceFinished: bytes[0] === 0 && bytes[1] === 5 && uploadedBytes === totalBytes && verifiedBytes === totalBytes, sha256Provenance: 'stored-expected' }
}
