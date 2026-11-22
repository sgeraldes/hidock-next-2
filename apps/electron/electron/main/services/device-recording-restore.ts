import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { encodeRecordingRestore, isRecordingRestoreFilename, parseRecordingRestoreReply } from '@hidock/jensen-protocol'
import type { JensenDevice, RecordingRestoreOperation, RecordingRestoreReply, RecordingRestoreRequest, RecordingRestoreSession } from '@hidock/jensen-protocol'
import { RESTORE_UUID } from './device-recording-restore-journal'
import type { DeviceRecordingRestoreJournal, RecordingRestoreOwnershipRecord, RecordingRestoreResolutionEvidence, RecordingRestoreSourceFingerprint } from './device-recording-restore-journal'
import type { DeviceRecordingRestoreAssurance, DeviceRecordingRestoreResult } from '../../../src/shared/device-recording-restore'
export type { DeviceRecordingRestoreAssurance, DeviceRecordingRestoreResult } from '../../../src/shared/device-recording-restore'

type RestoreDevice = Pick<JensenDevice, 'isConnected' | 'getModel' | 'getConnectionSessionId' | 'serialNumber' | 'versionNumber' | 'versionCode' |
  'getDeviceInfo' | 'getCardInfo' | 'createRecordingRestoreSession' | 'getRecordingRestoreStatus' | 'applyRecordingRestore'>
export interface DeviceRecordingRestoreDependencies {
  device(): RestoreDevice
  serialize<T>(operation: () => Promise<T>): Promise<T>
  idle(): boolean; normalJensen(): boolean; massStorageInactive(): boolean; ownerAvailable(ownerId: number): boolean
  /** `sha256` is the host-computed digest from the stored original-backup receipt (host download evidence, not a native device digest). */
  getTrustedSource(recordingId: string): Promise<{ path: string; filename: string; sha256: string } | null>
  journal: DeviceRecordingRestoreJournal
  readback(session: RecordingRestoreSession, onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal): Promise<{ status: 'complete' | 'cancelled' | 'error'; received: number }>
  /** Main-only test injection; default is one random identity for this Node process. */
  processId?: string
}
interface PrivateRestore {
  record: RecordingRestoreOwnershipRecord; ownerId: number; bound: RecordingRestoreSession; uncertain: boolean; reply: RecordingRestoreReply | null
  blockHashes: Buffer | null; commitSourceChecked: boolean
}
const HOST_PROCESS_ID = randomUUID()
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); return n >>> 0 })
const copySession = (s: RecordingRestoreSession): RecordingRestoreSession => ({ ...s, ownerToken: s.ownerToken.slice(), sourceSha256: s.sourceSha256.slice() })

/** Explicit caller-paced RSTR2 restore. Construction never reads/writes the device. */
export class DeviceRecordingRestoreService {
  private readonly sessions = new Map<string, PrivateRestore>()
  private readonly processId: string
  constructor(private readonly deps: DeviceRecordingRestoreDependencies) {
    this.processId = deps.processId ?? HOST_PROCESS_ID
    if (!RESTORE_UUID.test(this.processId)) throw Error('Invalid main process identity')
  }
  /** Firmware prepare/execute fence. Filesystem-only; safe inside the existing
   * device serializer. Unknown, corrupt or unavailable durable state blocks. */
  async hasUnresolvedOwnership(): Promise<boolean> {
    try { return (await this.deps.journal.list()).length > 0 || this.sessions.size > 0 }
    catch { return true }
  }
  private async release(s: PrivateRestore, evidence: RecordingRestoreResolutionEvidence): Promise<void> {
    await this.deps.journal.resolve(s.record, evidence)
    // The lease disappears only after the sealed receipt has been fsynced and
    // loaded back against its immutable ownership authority.
    this.sessions.delete(s.record.id)
  }
  private absent(reply: RecordingRestoreReply): boolean {
    return reply.acknowledgement === 'accepted' && reply.checkpoint === 'validated-binding' && reply.stateCode === 0 &&
      reply.metadata?.uploadedBytes === 0 && reply.metadata.verifiedBytes === 0
  }
  private async releaseAbsent(s: PrivateRestore, operation: 'abort' | 'status'): Promise<void> {
    await this.release(s, { kind: 'native-absent', operation, serialNumber: s.bound.serialNumber,
      versionNumber: s.bound.versionNumber, connectionSessionId: s.bound.connectionSessionId })
  }
  private result(s: PrivateRestore | null, status: DeviceRecordingRestoreResult['status'], reason: string | null,
    attempted: boolean | null = false, reply: RecordingRestoreReply | null = null): DeviceRecordingRestoreResult {
    const finished = reply?.acknowledgement === 'accepted' && reply.stateCode === 5 && reply.metadata?.uploadedBytes === s?.bound.totalBytes && reply.metadata?.verifiedBytes === s?.bound.totalBytes
    return { sessionId: s?.record.id ?? null, filename: s?.bound.filename ?? null, totalBytes: s?.bound.totalBytes ?? null,
      status, reason, commandAttempted: attempted, reply: reply ? { ...reply, metadata: reply.metadata ? { ...reply.metadata, sourceSha256: reply.metadata.sourceSha256.slice() } : null } : null,
      deviceFinished: !!finished, restoreVerified: status === 'restore-verified' && !!finished }
  }
  private available(d: RestoreDevice): boolean {
    return d === this.deps.device() && this.deps.idle() && this.deps.normalJensen() && this.deps.massStorageInactive() && d.isConnected() &&
      d.getModel() === 'hidock-h1e' && d.versionNumber === 393988 && d.versionCode === '6.3.4' && !!d.serialNumber?.trim()
  }
  private same(d: RestoreDevice, s: PrivateRestore): boolean { return this.available(d) && d.serialNumber === s.bound.serialNumber && d.getConnectionSessionId() === s.bound.connectionSessionId }
  private consent(a: DeviceRecordingRestoreAssurance): boolean {
    return a?.ownedRecordingRestoreConsent === true && a.audioQuiescent === true && !a.signal?.aborted &&
      Object.keys(a).every(k => ['ownedRecordingRestoreConsent', 'audioQuiescent', 'signal'].includes(k))
  }
  private owned(owner: number, id: string): PrivateRestore | null {
    if (!Number.isSafeInteger(owner) || owner < 1 || typeof id !== 'string' || !RESTORE_UUID.test(id)) return null
    const s = this.sessions.get(id.toLowerCase()); return s?.ownerId === owner ? s : null
  }
  private slot(): boolean {
    // FINISHED alone is unresolved. Unknown native outcomes retain ownership.
    return this.sessions.size < 16
  }
  private ordered(owner: number, s: PrivateRestore | null, fn: () => Promise<DeviceRecordingRestoreResult>): Promise<DeviceRecordingRestoreResult> {
    try { return this.deps.serialize(async () => {
      if (!this.deps.ownerAvailable(owner)) return this.result(s, 'rejected-before-dispatch', 'application-owner-unavailable')
      return fn()
    }).catch(() => this.result(s, 'rejected-before-dispatch', 'operation-unavailable')) }
    catch { return Promise.resolve(this.result(s, 'rejected-before-dispatch', 'operation-unavailable')) }
  }
  private fingerprint(path: string, filename: string, stat: BigIntStats): RecordingRestoreSourceFingerprint {
    if (!stat.isFile() || stat.size < 0n || stat.size > 0x7fffffffn) throw Error('Invalid trusted source')
    return { path: resolve(path), filename, size: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }
  }
  private async trusted(recordingId: string): Promise<{ fingerprint: RecordingRestoreSourceFingerprint; sha256: string }> {
    const source = await this.deps.getTrustedSource(recordingId)
    if (!source || typeof source.path !== 'string' || !isAbsolute(source.path) || !isRecordingRestoreFilename(source.filename) ||
      typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Invalid trusted source')
    const stat = await lstat(source.path, { bigint: true })
    if (stat.isSymbolicLink()) throw Error('Invalid trusted source')
    return { fingerprint: this.fingerprint(source.path, source.filename, stat), sha256: source.sha256 }
  }
  private sameSource(a: RecordingRestoreSourceFingerprint, b: RecordingRestoreSourceFingerprint): boolean {
    return a.path === b.path && a.filename === b.filename && a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  }
  private async unchanged(s: PrivateRestore): Promise<boolean> {
    try {
      // Receipt digest pinned at BEGIN: a newer receipt version or a different digest fails closed without rehashing the file.
      const current = await this.trusted(s.record.recordingId)
      return this.sameSource(s.record.source, current.fingerprint) && current.sha256 === Buffer.from(s.record.session.sourceSha256).toString('hex')
    } catch { return false }
  }
  private async hashSource(owner: number, source: RecordingRestoreSourceFingerprint, signal?: AbortSignal): Promise<{ sha: Uint8Array; crc: number; blockHashes: Buffer }> {
    const file = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    const blockHashes = Buffer.alloc(Math.ceil(source.size / buffer.length) * 32) // <=1MiB for the exact2GiB-1 limit.
    let offset = 0, crc = 0xffffffff
    try {
      if (!this.sameSource(source, this.fingerprint(source.path, source.filename, await file.stat({ bigint: true })))) throw Error('Source changed')
      while (offset < source.size) {
        if (signal?.aborted || !this.deps.ownerAvailable(owner)) throw Error('Owner unavailable')
        const wanted = Math.min(buffer.length, source.size - offset); let read = 0
        while (read < wanted) { const { bytesRead } = await file.read(buffer, read, wanted - read, offset + read); if (!bytesRead) throw Error('Source truncated'); read += bytesRead }
        const bytes = buffer.subarray(0, read); hash.update(bytes)
        createHash('sha256').update(bytes).digest().copy(blockHashes, Math.floor(offset / buffer.length) * 32)
        for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
        offset += read
      }
      if (!this.sameSource(source, this.fingerprint(source.path, source.filename, await file.stat({ bigint: true })))) throw Error('Source changed')
      return { sha: Uint8Array.from(hash.digest()), crc: (~crc) >>> 0, blockHashes }
    } finally { await file.close() }
  }
  private async sourceProof(s: PrivateRestore, signal?: AbortSignal, rehash = false): Promise<boolean> {
    if (!await this.unchanged(s)) return false
    if (!s.blockHashes || rehash) {
      try {
        const hashed = await this.hashSource(s.ownerId, s.record.source, signal)
        if (!sameBytes(hashed.sha, s.bound.sourceSha256) || hashed.crc !== s.bound.wholeCrc32) return false
        s.blockHashes = hashed.blockHashes
      } catch { return false }
    }
    return true
  }
  private normalized(s: PrivateRestore, request: RecordingRestoreRequest, reply: RecordingRestoreReply): RecordingRestoreReply | null {
    try {
      if (!reply || !['accepted', 'rejected'].includes(reply.acknowledgement) || !Number.isInteger(reply.stateCode) || reply.stateCode < 0 || reply.stateCode > 7 ||
        !Number.isInteger(reply.reasonCode) || reply.reasonCode < 0 || reply.reasonCode > 14) return null
      const m = reply.metadata, bytes = new Uint8Array(m ? 53 + s.bound.filename.length : 4), view = new DataView(bytes.buffer)
      bytes[0] = reply.acknowledgement === 'accepted' ? 0 : 1; bytes[1] = reply.stateCode; view.setUint16(2, reply.reasonCode)
      if (m) {
        if (m.filename !== s.bound.filename || !sameBytes(m.sourceSha256, s.bound.sourceSha256) ||
          ![m.uploadedBytes, m.verifiedBytes, m.totalBytes, m.wholeCrc32].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff)) return null
        view.setUint32(4, m.uploadedBytes); view.setUint32(8, m.verifiedBytes); view.setUint32(12, m.totalBytes); view.setUint32(16, m.wholeCrc32)
        bytes.set(m.sourceSha256, 20); bytes[52] = m.filename.length; bytes.set(new TextEncoder().encode(m.filename), 53)
      }
      return parseRecordingRestoreReply(s.bound, request, bytes)
    } catch { return null }
  }
  private confirm(s: PrivateRestore, reply: RecordingRestoreReply): void {
    s.reply = reply
    s.uncertain = reply.checkpoint !== 'validated-binding' || reply.stateCode === 7 || reply.recovery === 'read-only-status-required' || reply.recovery === 'manual-investigation-required'
  }
  private async apply(s: PrivateRestore, request: RecordingRestoreOperation, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> {
    const d = this.deps.device()
    if (!this.deps.ownerAvailable(s.ownerId) || !this.consent(assurance) || !this.same(d, s) || !this.deps.journal.isAvailable()) return this.result(s, 'rejected-before-dispatch', 'owner-session-or-assurance-unavailable')
    if (s.reply?.stateCode === 5) return this.result(s, 'rejected-before-dispatch', 'finished-file-protected')
    if (s.uncertain) return this.result(s, 'rejected-before-dispatch', 'explicit-status-required')
    if ((s.reply?.stateCode === 6 || s.reply?.recovery === 'explicit-recover-step-required') && !['recover-step', 'abort'].includes(request.operation)) return this.result(s, 'rejected-before-dispatch', 'explicit-recovery-required')
    try {
      const outcome = await d.applyRecordingRestore(s.bound, request, { ownedRecordingRestoreConsent: true, audioQuiescent: true, normalJensen: true, massStorageInactive: true, signal: assurance.signal, timeout: 5 })
      if (outcome.status === 'rejected-before-dispatch') return this.result(s, outcome.status, 'sdk-preflight-rejected')
      if (outcome.status === 'uncertain' || !this.same(d, s) || assurance.signal?.aborted) { s.uncertain = true; return this.result(s, 'uncertain', 'mutation-outcome-unconfirmed', true) }
      const reply = this.normalized(s, request, outcome.reply)
      if (!reply) { s.uncertain = true; return this.result(s, 'uncertain', 'mutation-reply-invalid', true) }
      this.confirm(s, reply)
      if (request.operation === 'abort' && this.absent(reply)) await this.releaseAbsent(s, 'abort')
      return this.result(s, 'reply', null, true, reply)
    } catch { s.uncertain = true; return this.result(s, 'uncertain', 'invoked-backend-outcome-unknown', null) }
  }
  begin(owner: number, recordingId: string, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> {
    if (!Number.isSafeInteger(owner) || owner < 1 || typeof recordingId !== 'string' || !recordingId || recordingId.length > 256 || !this.consent(assurance)) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'invalid-library-reference-or-assurance'))
    const permission = { ...assurance }
    return this.ordered(owner, null, async () => {
      const d = this.deps.device()
      if (!this.available(d) || !this.deps.journal.isAvailable()) return this.result(null, 'rejected-before-dispatch', 'owner-version-encryption-unavailable')
      if (!this.slot()) return this.result(null, 'rejected-before-dispatch', 'restore-session-capacity-exhausted')
      const serial = d.serialNumber, epoch = d.getConnectionSessionId()
      try {
        const trusted = await this.trusted(recordingId), source = trusted.fingerprint, hashed = await this.hashSource(owner, source, permission.signal)
        // The bytes on disk must be the bytes the host received; a same-size local edit before BEGIN stops here.
        if (Buffer.from(hashed.sha).toString('hex') !== trusted.sha256) return this.result(null, 'rejected-before-dispatch', 'source-changed')
        const info = await d.getDeviceInfo(5), card = await d.getCardInfo(5)
        if (!this.available(d) || !this.consent(permission) || !this.deps.ownerAvailable(owner) || d.serialNumber !== serial || d.getConnectionSessionId() !== epoch ||
          info?.serialNumber !== serial || info.model !== 'hidock-h1e' || info.versionNumber !== 393988 || info.versionCode !== '6.3.4') return this.result(null, 'rejected-before-dispatch', 'fresh-identity-unavailable')
        const required = Math.ceil((source.size + 1024) / 1048576) + 8, status = card && /^[a-f0-9]{1,8}$/i.test(card.status) ? parseInt(card.status, 16) : NaN
        if (!card || !Number.isSafeInteger(card.capacity) || !Number.isSafeInteger(card.free) || !Number.isSafeInteger(card.used) || card.capacity <= 0 || card.free < required || card.free > card.capacity || card.used !== card.capacity - card.free || (status & ~0x40) !== 0x900) return this.result(null, 'rejected-before-dispatch', 'space-or-card-unavailable')
        const descriptor = { restoreId: randomInt(1, 0x100000000), ownerToken: Uint8Array.from(randomBytes(16)), totalBytes: source.size, wholeCrc32: hashed.crc, sourceSha256: hashed.sha, filename: source.filename }
        const bound = d.createRecordingRestoreSession(descriptor)
        if (!bound || bound.serialNumber !== serial || bound.connectionSessionId !== epoch || bound.versionNumber !== 393988 ||
          bound.restoreId !== descriptor.restoreId || !sameBytes(bound.ownerToken, descriptor.ownerToken) || !sameBytes(bound.sourceSha256, hashed.sha) || bound.filename !== source.filename || bound.totalBytes !== source.size || bound.wholeCrc32 !== hashed.crc) return this.result(null, 'rejected-before-dispatch', 'sdk-session-unqualified')
        const record: RecordingRestoreOwnershipRecord = { schema: 'RSTR2', id: randomUUID(), createdAt: new Date().toISOString(), processId: this.processId,
          ownerId: owner, recordingId, source, session: copySession(bound) }
        const s: PrivateRestore = { record, ownerId: owner, bound: copySession(bound), uncertain: false, reply: null, blockHashes: hashed.blockHashes, commitSourceChecked: false }
        // Establish source proof before journaling, then recheck after durability.
        if (!await this.sourceProof(s, permission.signal)) return this.result(null, 'rejected-before-dispatch', 'source-changed')
        await this.deps.journal.create(record)
        this.sessions.set(record.id, s)
        if (!await this.sourceProof(s, permission.signal, true)) {
          try { await this.release(s, { kind: 'begin-not-dispatched' }) }
          catch { return this.result(s, 'rejected-before-dispatch', 'pre-dispatch-resolution-unavailable') }
          return this.result(s, 'rejected-before-dispatch', 'source-changed')
        }
        const result = await this.apply(s, { operation: 'begin' }, permission)
        if (result.status === 'rejected-before-dispatch') {
          try { await this.release(s, { kind: 'begin-not-dispatched' }) }
          catch { return this.result(s, result.status, 'pre-dispatch-resolution-unavailable') }
        }
        return result
      } catch (error) { return this.result(null, 'rejected-before-dispatch', error instanceof Error && error.message === 'Restore journal capacity exhausted' ?
        'restore-journal-capacity-exhausted' : 'source-readiness-or-durability-unavailable') }
    })
  }
  append(owner: number, id: string, request: { offset: number; count: number }, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> {
    const s = this.owned(owner, id), permission = { ...assurance }
    if (!s || !request || Object.keys(request).some(k => !['offset', 'count'].includes(k)) || !Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > 1024) return Promise.resolve(this.result(s, 'rejected-before-dispatch', 'invalid-owned-range'))
    const { offset, count } = request
    return this.ordered(owner, s, async () => {
      if (s.uncertain || !s.reply?.metadata || s.reply.acknowledgement !== 'accepted' || s.reply.stateCode !== 1 || s.reply.metadata.uploadedBytes !== offset) return this.result(s, 'rejected-before-dispatch', 'confirmed-contiguous-status-required')
      try {
        encodeRecordingRestore(s.bound, { operation: 'append', offset, data: new Uint8Array(count) })
        if (!await this.sourceProof(s, permission.signal)) return this.result(s, 'rejected-before-dispatch', 'source-changed')
        const file = await open(s.record.source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), data = new Uint8Array(count)
        try {
          if (!this.sameSource(s.record.source, this.fingerprint(s.record.source.path, s.bound.filename, await file.stat({ bigint: true })))) throw Error()
          // Stat timestamps alone can miss an immediate same-size Windows write.
          // Compare each touched64KiB block with its initial cryptographic proof.
          const buffer = Buffer.alloc(65536)
          for (let base = Math.floor(offset / 65536) * 65536; base < offset + count; base += 65536) {
            const wanted = Math.min(65536, s.bound.totalBytes - base); let received = 0
            while (received < wanted) { const { bytesRead } = await file.read(buffer, received, wanted - received, base + received); if (!bytesRead) throw Error(); received += bytesRead }
            const expected = s.blockHashes!.subarray(Math.floor(base / 65536) * 32, Math.floor(base / 65536) * 32 + 32)
            if (!sameBytes(Uint8Array.from(createHash('sha256').update(buffer.subarray(0, wanted)).digest()), expected)) return this.result(s, 'rejected-before-dispatch', 'source-changed')
            const start = Math.max(base, offset), end = Math.min(base + wanted, offset + count)
            data.set(buffer.subarray(start - base, end - base), start - offset)
          }
          if (!this.sameSource(s.record.source, this.fingerprint(s.record.source.path, s.bound.filename, await file.stat({ bigint: true })))) throw Error()
        } finally { await file.close() }
        if (!await this.unchanged(s)) return this.result(s, 'rejected-before-dispatch', 'source-changed')
        return this.apply(s, { operation: 'append', offset, data }, permission)
      } catch { return this.result(s, 'rejected-before-dispatch', 'source-or-range-unavailable') }
    })
  }
  private step(owner: number, id: string, operation: 'verify-commit-step' | 'recover-step' | 'abort', assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> {
    const s = this.owned(owner, id), permission = { ...assurance }
    if (!s) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'unknown-owned-session'))
    return this.ordered(owner, s, async () => {
      if (s.reply?.stateCode === 5) return this.result(s, 'rejected-before-dispatch', 'finished-file-protected')
      if (operation === 'verify-commit-step' && (!s.reply?.metadata || s.reply.metadata.uploadedBytes !== s.bound.totalBytes || ![1, 2, 3, 4].includes(s.reply.stateCode))) return this.result(s, 'rejected-before-dispatch', 'complete-confirmed-upload-required')
      if (operation === 'recover-step' && (s.reply?.checkpoint !== 'validated-binding' || s.reply.stateCode !== 6 && s.reply.recovery !== 'explicit-recover-step-required')) return this.result(s, 'rejected-before-dispatch', 'explicit-recovery-status-required')
      if (operation !== 'abort' && !await this.sourceProof(s, permission.signal, operation === 'verify-commit-step' && !s.commitSourceChecked)) return this.result(s, 'rejected-before-dispatch', 'source-changed')
      if (operation === 'verify-commit-step') s.commitSourceChecked = true
      return this.apply(s, { operation }, permission)
    })
  }
  verifyCommitStep(owner: number, id: string, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> { return this.step(owner, id, 'verify-commit-step', assurance) }
  recoverStep(owner: number, id: string, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> { return this.step(owner, id, 'recover-step', assurance) }
  abort(owner: number, id: string, assurance: DeviceRecordingRestoreAssurance): Promise<DeviceRecordingRestoreResult> { return this.step(owner, id, 'abort', assurance) }
  private async refresh(owner: number, id: string, signal?: AbortSignal): Promise<PrivateRestore | null> {
    let s = this.owned(owner, id)
    if (!s && this.sessions.has(id.toLowerCase())) return null
    const d = this.deps.device()
    if (!this.available(d) || signal?.aborted) return null
    if (!s) {
      const record = await this.deps.journal.load(id)
      if (record.processId === this.processId && record.ownerId !== owner) return null
      if (await this.deps.journal.isResolved(id)) return null
      s = { record, ownerId: owner, bound: copySession(record.session), uncertain: true, reply: null, blockHashes: null, commitSourceChecked: false }
    }
    // A failed fresh STATUS must not leave an older checkpoint authorizing a
    // mutation after an unconfirmed recovery/state observation.
    s.uncertain = true
    // Every explicit STATUS refreshes identity, including same-process sessions.
    const info = await d.getDeviceInfo(5)
    if (!this.available(d) || !this.deps.ownerAvailable(owner) || signal?.aborted || info?.serialNumber !== s.record.session.serialNumber ||
      info.model !== 'hidock-h1e' || info.versionNumber !== 393988 || info.versionCode !== '6.3.4') return null
    const bound = d.createRecordingRestoreSession(s.record.session)
    if (!bound || bound.serialNumber !== s.record.session.serialNumber || bound.versionNumber !== 393988 || bound.restoreId !== s.record.session.restoreId ||
      bound.totalBytes !== s.record.session.totalBytes || bound.wholeCrc32 !== s.record.session.wholeCrc32 || bound.filename !== s.record.session.filename ||
      !sameBytes(bound.ownerToken, s.record.session.ownerToken) || !sameBytes(bound.sourceSha256, s.record.session.sourceSha256)) return null
    const reply = await d.getRecordingRestoreStatus(bound, 5, signal)
    if (!reply || !this.available(d) || !this.deps.ownerAvailable(owner) || signal?.aborted || d.serialNumber !== bound.serialNumber || d.getConnectionSessionId() !== bound.connectionSessionId) return null
    const parsed = this.normalized(s, { operation: 'status' }, reply)
    if (!parsed) return null
    this.confirm(s, parsed)
    if (parsed.checkpoint !== 'validated-binding') { s.uncertain = true; return s }
    s.bound = copySession(bound)
    if (this.absent(parsed)) { await this.releaseAbsent(s, 'status'); return s }
    if (!this.sessions.has(id.toLowerCase()) && !this.slot()) throw Error('restore-session-capacity-exhausted')
    this.sessions.set(s.record.id, s)
    return s
  }
  status(owner: number, id: string, signal?: AbortSignal): Promise<DeviceRecordingRestoreResult> {
    if (!Number.isSafeInteger(owner) || owner < 1 || typeof id !== 'string' || !RESTORE_UUID.test(id)) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'unknown-owned-session'))
    return this.ordered(owner, this.owned(owner, id), async () => {
      try { const s = await this.refresh(owner, id, signal); return s ? this.result(s, 'reply', null, false, s.reply) : this.result(null, 'status-unavailable', 'owned-status-unconfirmed') }
      catch (error) { return this.result(null, 'status-unavailable', error instanceof Error && error.message === 'restore-session-capacity-exhausted' ?
        error.message : 'sealed-or-native-status-unavailable') }
    })
  }
  verifyReadback(owner: number, id: string, signal?: AbortSignal): Promise<DeviceRecordingRestoreResult> {
    const current = this.owned(owner, id)
    if (!current) return Promise.resolve(this.result(null, 'rejected-before-dispatch', 'explicit-owned-status-required'))
    return this.ordered(owner, current, async () => {
      try {
        const s = await this.refresh(owner, id, signal)
        if (!s || s.uncertain || !s.reply?.deviceFinished || !await this.sourceProof(s, signal, true)) return this.result(s, 'readback-failed', 'finished-owned-source-unconfirmed')
        const d = this.deps.device(), hash = createHash('sha256'); let count = 0, invalid = false
        const result = await this.deps.readback(copySession(s.bound), chunk => {
          if (!(chunk instanceof Uint8Array) || chunk.length > 1048576 || chunk.length > s.bound.totalBytes - count ||
            signal?.aborted || !this.deps.ownerAvailable(owner) || !this.same(d, s)) { invalid = true; throw Error('Invalid bounded readback') }
          hash.update(chunk); count += chunk.length
        }, signal)
        if (invalid || result.status !== 'complete' || result.received !== count || count !== s.bound.totalBytes || signal?.aborted ||
          !this.deps.ownerAvailable(owner) || !this.same(d, s) || !await this.sourceProof(s, signal, true) || !sameBytes(Uint8Array.from(hash.digest()), s.bound.sourceSha256)) return this.result(s, 'readback-failed', 'full-source-sha-readback-unconfirmed')
        await this.release(s, { kind: 'full-sha256-readback', serialNumber: s.bound.serialNumber, versionNumber: s.bound.versionNumber,
          connectionSessionId: s.bound.connectionSessionId, totalBytes: count, sha256: Buffer.from(s.bound.sourceSha256).toString('hex') })
        return this.result(s, 'restore-verified', null, false, s.reply)
      } catch { return this.result(current, 'readback-failed', 'full-source-sha-readback-unconfirmed') }
    })
  }
}
