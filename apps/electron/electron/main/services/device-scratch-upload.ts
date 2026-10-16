import { randomInt, randomUUID } from 'node:crypto'
import {
  OWNED_SCRATCH_MAX_BYTES, OWNED_SCRATCH_MAX_CHUNK_BYTES, encodeOwnedScratchUpload,
  ownedScratchFilename, parseOwnedScratchUploadReply
} from '@hidock/jensen-protocol'
import type { JensenDevice, OwnedScratchUploadOperation, OwnedScratchUploadReply, OwnedScratchUploadRequest, OwnedScratchUploadSession } from '@hidock/jensen-protocol'
import type { DeviceScratchAppend, DeviceScratchUploadDescriptor, DeviceScratchUploadResult, DeviceScratchWriteAssurance } from '../../../src/shared/device-scratch-upload'
import type { DeviceScratchJournal, DeviceScratchResolutionEvidence } from './device-scratch-journal'

type ScratchDevice = Pick<JensenDevice, 'isConnected' | 'getModel' | 'getConnectionSessionId' | 'serialNumber' | 'versionNumber' | 'versionCode' |
  'getDeviceInfo' | 'getCardInfo' | 'createOwnedScratchUploadSession' | 'getOwnedScratchUploadStatus' | 'applyOwnedScratchUpload'>
export interface DeviceScratchUploadDependencies {
  device(): ScratchDevice
  serialize<T>(operation: () => Promise<T>): Promise<T>
  idle(): boolean
  normalJensen(): boolean
  massStorageInactive(): boolean
  ownerAvailable?(ownerId: number): boolean
  journal?: DeviceScratchJournal
}
interface PrivateSession {
  id: string
  ownerId: number
  bound: OwnedScratchUploadSession
  uncertain: boolean
  reply: OwnedScratchUploadReply | null
  uploadedBytes: number
  resolved: boolean
}
const MAX_SESSIONS = 16, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const STATES = ['absent-or-error', 'receiving', 'verify-tmp', 'ready', 'finished', 'verify-final']
const scratchVersion = (number: number | null, code: string | null) =>
  number === 393986 && code === '6.3.2' || number === 393988 && code === '6.3.4'

/** Private ownership with OS-sealed restart records: never accepts a path/name.
 * Each invocation makes at most one scratch operation; commits are caller-paced. */
export class DeviceScratchUploadService {
  private readonly sessions = new Map<string, PrivateSession>()
  constructor(private readonly deps: DeviceScratchUploadDependencies) {}
  /** Firmware fence; no serializer nesting, native IO or implicit recovery. */
  async hasUnresolvedOwnership(): Promise<boolean> {
    try { return !this.deps.journal || (await this.deps.journal.list()).length > 0 || [...this.sessions.values()].some(s => !s.resolved) }
    catch { return true }
  }
  private async release(session: PrivateSession, evidence: DeviceScratchResolutionEvidence): Promise<void> {
    if (!this.deps.journal) throw Error('Sealed scratch ownership is unavailable')
    const record = await this.deps.journal.load(session.id), original = record.session, bound = session.bound
    if (original.uploadId !== bound.uploadId || original.ownerToken !== bound.ownerToken || original.totalBytes !== bound.totalBytes ||
      original.wholeCrc32 !== bound.wholeCrc32 || original.serialNumber !== bound.serialNumber || original.versionNumber !== bound.versionNumber) throw Error('Scratch ownership binding changed')
    await this.deps.journal.resolve(record, evidence)
    session.resolved = true
    // Retain bounded completed checkpoints for existing caller API semantics;
    // they are no longer leases and can be evicted to admit a new operation.
    if (evidence.kind !== 'native-finished') this.sessions.delete(session.id)
  }
  private async resolveNative(session: PrivateSession, reply: OwnedScratchUploadReply, operation: OwnedScratchUploadRequest['operation']): Promise<void> {
    if (reply.acknowledgement !== 'accepted') return
    const identity = { serialNumber: session.bound.serialNumber, versionNumber: session.bound.versionNumber, connectionSessionId: session.bound.connectionSessionId }
    if (operation === 'abort' && reply.stateCode === 0 && reply.progressBytes === 0) await this.release(session, { kind: 'native-absent', operation, ...identity })
    // f118 FINISHED clears open-write ownership only. It does not prove file
    // content, unlike RSTR2 restore's full-SHA readback resolution requirement.
    if ((operation === 'commit' || operation === 'status') && reply.stateCode === 4 && reply.progressBytes === session.bound.totalBytes) {
      await this.release(session, { kind: 'native-finished', operation, ...identity, progressBytes: reply.progressBytes })
    }
  }

  private result(session: PrivateSession | null, status: DeviceScratchUploadResult['status'], reason: string | null,
    commandAttempted: boolean | null = false, reply: OwnedScratchUploadReply | null = null): DeviceScratchUploadResult {
    return { sessionId: session?.id ?? null, filename: session ? ownedScratchFilename(session.bound.uploadId) : null,
      totalBytes: session?.bound.totalBytes ?? null, status, reason, commandAttempted, reply,
      finished: status === 'reply' && reply?.acknowledgement === 'accepted' && reply.stateCode === 4 && reply.progressBytes === session?.bound.totalBytes }
  }
  private available(device: ScratchDevice): boolean {
    return this.deps.idle() && this.deps.normalJensen() && this.deps.massStorageInactive() && device.isConnected() &&
      device.getModel() === 'hidock-h1e' && scratchVersion(device.versionNumber, device.versionCode) && !!device.serialNumber?.trim()
  }
  private same(device: ScratchDevice, session: PrivateSession): boolean {
    return this.available(device) && device.versionNumber === session.bound.versionNumber &&
      device.serialNumber === session.bound.serialNumber && device.getConnectionSessionId() === session.bound.connectionSessionId
  }
  private consent(value: DeviceScratchWriteAssurance): boolean {
    return value?.ownedScratchWriteConsent === true && value.audioQuiescent === true &&
      Object.keys(value).every(key => ['ownedScratchWriteConsent', 'audioQuiescent', 'signal'].includes(key)) && !value.signal?.aborted
  }
  private owned(ownerId: number, id: string): PrivateSession | null {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof id !== 'string' || !UUID.test(id)) return null
    const session = this.sessions.get(id.toLowerCase())
    return session?.ownerId === ownerId ? session : null
  }
  private reply(session: PrivateSession, request: OwnedScratchUploadRequest, value: OwnedScratchUploadReply): OwnedScratchUploadReply | null {
    if (!value || value.operation !== request.operation || !['accepted', 'rejected'].includes(value.acknowledgement) ||
      !Number.isInteger(value.stateCode) || value.stateCode < 0 || value.stateCode > 5 || !Number.isSafeInteger(value.progressBytes) ||
      value.progressBytes < 0 || value.progressBytes > session.bound.totalBytes || value.state !== STATES[value.stateCode]) return null
    const bytes = new Uint8Array(6)
    bytes[0] = value.acknowledgement === 'accepted' ? 0 : 1; bytes[1] = value.stateCode
    new DataView(bytes.buffer).setUint32(2, value.progressBytes)
    return parseOwnedScratchUploadReply(session.bound, request, bytes)
  }
  private confirm(session: PrivateSession, reply: OwnedScratchUploadReply): void {
    session.reply = reply
    if (reply.acknowledgement !== 'accepted') return
    session.uncertain = false
    session.uploadedBytes = reply.stateCode === 1 ? reply.progressBytes : reply.stateCode >= 2 ? session.bound.totalBytes : 0
  }
  private reserveSlot(): boolean {
    if (this.sessions.size < MAX_SESSIONS) return true
    for (const [id, session] of this.sessions) {
      if (session.resolved) {
        this.sessions.delete(id) // Immutable sealed record remains recoverable via explicit STATUS.
        return true
      }
    }
    return false
  }
  private ordered(session: PrivateSession | null, operation: () => Promise<DeviceScratchUploadResult>, ownerId = session?.ownerId): Promise<DeviceScratchUploadResult> {
    try { return this.deps.serialize(() => {
      if (ownerId === undefined || this.deps.ownerAvailable?.(ownerId) === false) return Promise.resolve(this.result(session, 'rejected-before-dispatch', 'application-owner-unavailable'))
      return operation()
    }).catch(() => this.result(session, 'rejected-before-dispatch', 'application-owner-unavailable')) }
    catch { return Promise.resolve(this.result(session, 'rejected-before-dispatch', 'application-owner-unavailable')) }
  }
  private async apply(session: PrivateSession, request: OwnedScratchUploadOperation, assurance: DeviceScratchWriteAssurance): Promise<DeviceScratchUploadResult> {
    const device = this.deps.device()
    if (this.deps.ownerAvailable?.(session.ownerId) === false) return this.result(session, 'rejected-before-dispatch', 'application-owner-unavailable')
    if (!this.deps.journal?.isAvailable()) return this.result(session, 'rejected-before-dispatch', 'host-encryption-unavailable')
    if (!this.consent(assurance)) return this.result(session, 'rejected-before-dispatch', 'explicit-consent-and-audio-assurance-required')
    if (!this.same(device, session)) return this.result(session, 'rejected-before-dispatch', 'session-or-owner-unavailable')
    if (session.resolved) return this.result(session, 'rejected-before-dispatch', 'resolved-owned-session')
    if (session.uncertain) return this.result(session, 'rejected-before-dispatch', 'explicit-status-required-after-uncertainty')
    try {
      const outcome = await device.applyOwnedScratchUpload(session.bound, request, {
        ownedScratchWriteConsent: true, audioQuiescent: true, normalJensen: true, massStorageInactive: true,
        timeout: 5, signal: assurance.signal
      })
      if (outcome.status === 'rejected-before-dispatch') return this.result(session, outcome.status, 'sdk-preflight-rejected')
      if (outcome.status === 'uncertain' || !this.same(device, session) || assurance.signal?.aborted) {
        session.uncertain = true
        return this.result(session, 'uncertain', 'mutation-outcome-unconfirmed', true)
      }
      const parsed = this.reply(session, request, outcome.reply)
      if (!parsed) { session.uncertain = true; return this.result(session, 'uncertain', 'mutation-reply-invalid', true) }
      this.confirm(session, parsed)
      await this.resolveNative(session, parsed, request.operation)
      return this.result(session, 'reply', null, true, parsed)
    } catch {
      // An unexpected exception from an invoked backend cannot prove dispatch did
      // not happen. Do not expose its raw error or retry it.
      session.uncertain = true
      return this.result(session, 'uncertain', 'invoked-backend-outcome-unknown', null)
    }
  }

  begin(ownerId: number, descriptor: DeviceScratchUploadDescriptor, assurance: DeviceScratchWriteAssurance): Promise<DeviceScratchUploadResult> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !descriptor || Object.keys(descriptor).some(key => !['totalBytes', 'wholeCrc32'].includes(key)) ||
      !Number.isSafeInteger(descriptor.totalBytes) || descriptor.totalBytes < 1 || descriptor.totalBytes > OWNED_SCRATCH_MAX_BYTES ||
      !Number.isSafeInteger(descriptor.wholeCrc32) || descriptor.wholeCrc32 < 0 || descriptor.wholeCrc32 > 0xffffffff || !this.consent(assurance)) {
      return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'invalid-descriptor-or-assurance'))
    }
    const copied = { ...descriptor }, permission = { ...assurance }
    return this.ordered(null, async () => {
      const device = this.deps.device()
      if (!this.available(device) || !this.consent(permission)) return this.result(null, 'rejected-before-dispatch', 'owner-unavailable')
      if (!this.deps.journal?.isAvailable()) return this.result(null, 'rejected-before-dispatch', 'host-encryption-unavailable')
      if (!this.reserveSlot()) return this.result(null, 'rejected-before-dispatch', 'process-session-capacity-reached')
      const serial = device.serialNumber, epoch = device.getConnectionSessionId(), version = device.versionNumber, code = device.versionCode
      try {
        const info = await device.getDeviceInfo(5), card = await device.getCardInfo(5)
        if (!this.available(device) || !this.consent(permission) || device.serialNumber !== serial || device.getConnectionSessionId() !== epoch ||
          info?.serialNumber !== serial || info.model !== 'hidock-h1e' || info.versionNumber !== version || info.versionCode !== code ||
          device.versionNumber !== version || device.versionCode !== code) {
          return this.result(null, 'rejected-before-dispatch', 'fresh-identity-unavailable')
        }
        const journalBytes = 48 * Math.ceil(copied.totalBytes / 512)
        const requiredMiB = Math.ceil((copied.totalBytes + journalBytes) / 1048576) + 8
        const cardStatus = card && /^[a-f0-9]{1,8}$/i.test(card.status) ? parseInt(card.status, 16) : NaN
        if (!card || !Number.isSafeInteger(card.capacity) || card.capacity <= 0 || !Number.isSafeInteger(card.free) || card.free < requiredMiB ||
          card.free > card.capacity || !Number.isSafeInteger(card.used) || card.used < 0 || card.used !== card.capacity - card.free ||
          !Number.isSafeInteger(cardStatus) || (cardStatus & ~0x40) !== 0x900) return this.result(null, 'rejected-before-dispatch', 'scratch-space-or-card-unavailable')
        const uploadId = randomInt(1, 0x100000000), ownerToken = randomInt(1, 0x100000000)
        const bound = device.createOwnedScratchUploadSession(uploadId, ownerToken, copied.totalBytes, copied.wholeCrc32)
        if (!bound || bound.serialNumber !== serial || bound.connectionSessionId !== epoch || bound.versionNumber !== version ||
          bound.uploadId !== uploadId || bound.ownerToken !== ownerToken || bound.totalBytes !== copied.totalBytes || bound.wholeCrc32 !== copied.wholeCrc32) {
          return this.result(null, 'rejected-before-dispatch', 'sdk-session-unqualified')
        }
        const session: PrivateSession = { id: randomUUID(), ownerId, bound: Object.freeze({ ...bound }), uncertain: false, reply: null, uploadedBytes: 0, resolved: false }
        // Durable sealed ownership must complete before the native BEGIN boundary.
        // Recheck the trusted owner after readiness, and apply() checks again after fsync.
        if (this.deps.ownerAvailable?.(ownerId) === false) return this.result(null, 'rejected-before-dispatch', 'application-owner-unavailable')
        try { await this.deps.journal.create(session.id, session.bound) }
        catch (error) { return this.result(null, 'rejected-before-dispatch', error instanceof Error && error.message === 'Scratch journal capacity exhausted' ? 'scratch-journal-capacity-exhausted' : 'sealed-ownership-not-durable') }
        this.sessions.set(session.id, session)
        const result = await this.apply(session, { operation: 'begin' }, permission)
        if (result.status === 'rejected-before-dispatch') {
          try { await this.release(session, { kind: 'begin-not-dispatched' }) }
          catch { return this.result(session, result.status, 'pre-dispatch-resolution-unavailable') }
        }
        return result
      } catch { return this.result(null, 'rejected-before-dispatch', 'fresh-readiness-unavailable') }
    }, ownerId)
  }
  append(ownerId: number, id: string, request: DeviceScratchAppend, assurance: DeviceScratchWriteAssurance): Promise<DeviceScratchUploadResult> {
    const session = this.owned(ownerId, id)
    if (!session || !request || Object.keys(request).some(key => !['offset', 'data'].includes(key)) || !(request.data instanceof Uint8Array) ||
      request.data.byteLength < 1 || request.data.byteLength > OWNED_SCRATCH_MAX_CHUNK_BYTES) return Promise.resolve(this.result(session, 'rejected-before-dispatch', 'invalid-owned-append'))
    const operation = { operation: 'append' as const, offset: request.offset, data: request.data.slice() }, permission = { ...assurance }
    try { encodeOwnedScratchUpload(session.bound, operation) } catch { return Promise.resolve(this.result(session, 'rejected-before-dispatch', 'invalid-append-bounds')) }
    return this.ordered(session, async () => {
      if (session.reply?.acknowledgement !== 'accepted' || session.reply.stateCode !== 1 || operation.offset !== session.uploadedBytes) {
        return this.result(session, 'rejected-before-dispatch', 'append-requires-confirmed-contiguous-offset')
      }
      return this.apply(session, operation, permission)
    })
  }
  commit(ownerId: number, id: string, assurance: DeviceScratchWriteAssurance): Promise<DeviceScratchUploadResult> {
    const session = this.owned(ownerId, id), permission = { ...assurance }
    if (!session) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'unknown-owned-session'))
    return this.ordered(session, async () => {
      if (session.reply?.acknowledgement !== 'accepted' || session.uploadedBytes !== session.bound.totalBytes || ![1, 2, 3, 5].includes(session.reply.stateCode)) {
        return this.result(session, 'rejected-before-dispatch', 'commit-requires-complete-owned-upload')
      }
      return this.apply(session, { operation: 'commit' }, permission)
    })
  }
  abort(ownerId: number, id: string, assurance: DeviceScratchWriteAssurance): Promise<DeviceScratchUploadResult> {
    const session = this.owned(ownerId, id), permission = { ...assurance }
    if (!session) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'unknown-owned-session'))
    return this.ordered(session, () => {
      if (session.reply?.stateCode === 4 && session.reply.acknowledgement === 'accepted') return Promise.resolve(this.result(session, 'rejected-before-dispatch', 'finished-file-preserved'))
      return this.apply(session, { operation: 'abort' }, permission)
    })
  }
  status(ownerId: number, id: string, signal?: AbortSignal): Promise<DeviceScratchUploadResult> {
    let session = this.owned(ownerId, id)
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof id !== 'string' || !UUID.test(id) || !session && this.sessions.has(id.toLowerCase())) {
      return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'unknown-owned-session'))
    }
    return this.ordered(session, async () => {
      const device = this.deps.device()
      if (!this.available(device) || signal?.aborted) return this.result(session, 'status-unavailable', 'owner-unavailable')
      // Another queued explicit STATUS may have bound this record in the interim.
      // Re-evaluate process ownership inside the actual serialized slot.
      session = this.owned(ownerId, id)
      if (!session && this.sessions.has(id.toLowerCase())) return this.result(null, 'rejected-before-dispatch', 'unknown-owned-session')
      let recovered = false
      if (!session) {
        try {
          const record = await this.deps.journal?.load(id)
          if (!record) return this.result(null, 'rejected-before-dispatch', 'unknown-owned-session')
          session = { id: record.id, ownerId, bound: record.session, uncertain: true, reply: null, uploadedBytes: 0, resolved: await this.deps.journal!.isResolved(record.id) }
          recovered = true
        } catch { return this.result(null, 'status-unavailable', 'sealed-ownership-unavailable') }
      }
      let bound = session.bound
      // Sealed historical firmware identity is immutable. Reconnect may rebind
      // an epoch, never silently migrate a393986 record onto393988 firmware.
      if (device.versionNumber !== bound.versionNumber) return this.result(session, 'status-unavailable', 'historical-firmware-binding-mismatch')
      try {
        session.uncertain = true // A failed fresh observation cannot retain an old mutation checkpoint.
        if (recovered || !this.same(device, session)) {
          const info = await device.getDeviceInfo(5)
          if (!this.available(device) || info?.serialNumber !== session.bound.serialNumber || info.model !== 'hidock-h1e' ||
            info.versionNumber !== bound.versionNumber || info.versionNumber !== device.versionNumber || info.versionCode !== device.versionCode) {
            return this.result(session, 'status-unavailable', 'original-device-not-corroborated')
          }
          const fresh = device.createOwnedScratchUploadSession(bound.uploadId, bound.ownerToken, bound.totalBytes, bound.wholeCrc32)
          if (!fresh || fresh.serialNumber !== session.bound.serialNumber || fresh.versionNumber !== bound.versionNumber || fresh.uploadId !== bound.uploadId ||
            fresh.ownerToken !== bound.ownerToken || fresh.totalBytes !== bound.totalBytes || fresh.wholeCrc32 !== bound.wholeCrc32) {
            return this.result(session, 'status-unavailable', 'status-rebind-unqualified')
          }
          bound = Object.freeze({ ...fresh })
        }
        if (this.deps.ownerAvailable?.(ownerId) === false) return this.result(session, 'status-unavailable', 'application-owner-unavailable')
        const reply = await device.getOwnedScratchUploadStatus(bound, 5, signal)
        if (!this.available(device) || this.deps.ownerAvailable?.(ownerId) === false || signal?.aborted || device.versionNumber !== bound.versionNumber ||
          device.serialNumber !== bound.serialNumber || device.getConnectionSessionId() !== bound.connectionSessionId || !reply) {
          return this.result(session, 'status-unavailable', 'status-unconfirmed')
        }
        const parsed = this.reply(session, { operation: 'status' }, reply)
        if (!parsed) return this.result(session, 'status-unavailable', 'status-reply-invalid')
        if (parsed.acknowledgement === 'accepted') {
          session.bound = bound // Explicit read-only rebind only after ownership confirmation.
        }
        this.confirm(session, parsed)
        await this.resolveNative(session, parsed, 'status')
        if (parsed.acknowledgement === 'accepted' && recovered) {
          // A confirmed completed record can resolve even when all16 unknown
          // leases are occupied. Keep its checkpoint only when a slot exists.
          if (!this.reserveSlot()) {
            if (!session.resolved) return this.result(session, 'status-unavailable', 'process-session-capacity-reached')
          } else this.sessions.set(session.id, session)
        }
        return this.result(session, 'reply', null, false, parsed)
      } catch { return this.result(session, 'status-unavailable', 'status-unconfirmed') }
    }, ownerId)
  }
}
