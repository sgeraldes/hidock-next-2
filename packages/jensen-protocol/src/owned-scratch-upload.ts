/** Candidate6.3.2 owned-new-file wire contract. No caller path or automatic retries. */
export const OWNED_SCRATCH_UPLOAD_COMMAND = 0xf118
export const OWNED_SCRATCH_MAX_BYTES = 0x7fffff
export const OWNED_SCRATCH_MAX_CHUNK_BYTES = 1024
export interface OwnedScratchUploadDescriptor {
  uploadId: number
  ownerToken: number
  totalBytes: number
  wholeCrc32: number
}
export interface OwnedScratchUploadSession extends OwnedScratchUploadDescriptor {
  readonly serialNumber: string
  readonly connectionSessionId: number
  readonly versionNumber: 393986 | 393988
}
export type OwnedScratchUploadOperation = { operation: 'begin' } | { operation: 'append'; offset: number; data: Uint8Array } |
  { operation: 'commit' } | { operation: 'abort' }
export type OwnedScratchUploadRequest = OwnedScratchUploadOperation | { operation: 'status' }
export type OwnedScratchUploadState = 'absent-or-error' | 'receiving' | 'verify-tmp' | 'ready' | 'finished' | 'verify-final'
export interface OwnedScratchUploadReply {
  operation: OwnedScratchUploadRequest['operation']
  acknowledgement: 'accepted' | 'rejected'
  stateCode: 0 | 1 | 2 | 3 | 4 | 5
  state: OwnedScratchUploadState
  progressBytes: number
  progressKind: 'uploaded' | 'readback' | 'none'
  /** Only ACK0 +state4 +exact total; does not attest power-loss atomicity. */
  finished: boolean
  persistence: 'unverified'
  imageAttested: false
}
export interface OwnedScratchWriteOptions {
  ownedScratchWriteConsent: true
  normalJensen: true
  massStorageInactive: true
  /** Explicit owner assurance, not inferred UAC/microphone exclusion. */
  audioQuiescent: true
  timeout?: number
  signal?: AbortSignal
}
export type OwnedScratchWriteOutcome =
  { status: 'rejected-before-dispatch'; reason: string; commandAttempted: false } |
  { status: 'reply'; commandAttempted: true; reply: OwnedScratchUploadReply } |
  { status: 'uncertain'; reason: string; commandAttempted: true }

const unsigned = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
export function isOwnedScratchUploadDescriptor(value: OwnedScratchUploadDescriptor): boolean {
  return !!value && unsigned(value.uploadId) && value.uploadId !== 0 && unsigned(value.ownerToken) && value.ownerToken !== 0 &&
    Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 && value.totalBytes <= OWNED_SCRATCH_MAX_BYTES && unsigned(value.wholeCrc32)
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
export function ownedScratchCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]
  return (value ^ 0xffffffff) >>> 0
}
export function ownedScratchFilename(uploadId: number): string {
  if (!unsigned(uploadId) || uploadId === 0) throw Error('Invalid scratch upload ID')
  return `REA${uploadId.toString(16).toUpperCase().padStart(8, '0')}.hda`
}
export function encodeOwnedScratchUpload(descriptor: OwnedScratchUploadDescriptor, request: OwnedScratchUploadRequest): Uint8Array {
  if (!isOwnedScratchUploadDescriptor(descriptor) || !request) throw Error('Invalid owned scratch descriptor')
  const op = request.operation === 'begin' ? 0 : request.operation === 'append' ? 1 : request.operation === 'commit' ? 2 : request.operation === 'abort' ? 3 : request.operation === 'status' ? 4 : -1
  if (op < 0) throw Error('Unsupported scratch operation')
  let data: Uint8Array | null = null
  if (request.operation === 'append') {
    if (!(request.data instanceof Uint8Array) || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > descriptor.totalBytes ||
      request.data.length < 1 || request.data.length > OWNED_SCRATCH_MAX_CHUNK_BYTES || request.data.length > descriptor.totalBytes - request.offset ||
      request.data.length < 512 && request.data.length !== descriptor.totalBytes - request.offset) throw Error('Invalid scratch append bounds')
    data = request.data.slice() // Request bytes and checksum cannot race caller mutation.
  }
  const body = new Uint8Array(op === 0 ? 17 : op === 1 ? 17 + data!.length : 9), view = new DataView(body.buffer)
  body[0] = op; view.setUint32(1, descriptor.uploadId); view.setUint32(5, descriptor.ownerToken)
  if (op === 0) { view.setUint32(9, descriptor.totalBytes); view.setUint32(13, descriptor.wholeCrc32) }
  if (op === 1 && request.operation === 'append') { view.setUint32(9, request.offset); view.setUint32(13, ownedScratchCrc32(data!)); body.set(data!, 17) }
  return body
}
/** Source-qualified FA_READ1 journal load/stat path only; malformed op4 is not whitelisted. */
export function isOwnedScratchStatusBody(body: readonly number[] | Uint8Array): boolean {
  if (body.length !== 9 || body[0] !== 4 || Array.from(body).some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return body.slice(1, 5).some(value => value !== 0) && body.slice(5, 9).some(value => value !== 0)
}
export function parseOwnedScratchUploadReply(descriptor: OwnedScratchUploadDescriptor, request: OwnedScratchUploadRequest, body: Uint8Array): OwnedScratchUploadReply | null {
  if (!isOwnedScratchUploadDescriptor(descriptor) || !request || !['begin', 'append', 'commit', 'abort', 'status'].includes(request.operation) ||
    request.operation === 'append' && (!(request.data instanceof Uint8Array) || !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > descriptor.totalBytes || request.data.length < 1 || request.data.length > 1024 || request.data.length > descriptor.totalBytes - request.offset) ||
    body.length !== 6 || body[0] > 1 || body[1] > 5) return null
  const stateCode = body[1] as OwnedScratchUploadReply['stateCode'], progressBytes = new DataView(body.buffer, body.byteOffset + 2, 4).getUint32(0)
  if (progressBytes > descriptor.totalBytes) return null
  if (body[0] === 0) {
    if (request.operation === 'begin' && (stateCode !== 1 || progressBytes !== 0)) return null
    if (request.operation === 'append' && (stateCode !== 1 || progressBytes !== request.offset + request.data.length)) return null
    if (request.operation === 'abort' && (stateCode !== 0 || progressBytes !== 0)) return null
    if (request.operation === 'commit' && stateCode !== 2 && stateCode !== 3 && stateCode !== 4 && stateCode !== 5) return null
    if (request.operation === 'status' && stateCode === 0) return null
    if ((stateCode === 3 || stateCode === 4) && progressBytes !== descriptor.totalBytes) return null
  }
  return { operation: request.operation, acknowledgement: body[0] === 0 ? 'accepted' : 'rejected', stateCode,
    state: (['absent-or-error', 'receiving', 'verify-tmp', 'ready', 'finished', 'verify-final'] as const)[stateCode], progressBytes,
    progressKind: stateCode === 0 ? 'none' : stateCode === 1 ? 'uploaded' : 'readback',
    finished: body[0] === 0 && stateCode === 4 && progressBytes === descriptor.totalBytes, persistence: 'unverified', imageAttested: false }
}
