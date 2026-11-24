import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isRecordingRestoreDescriptor } from '@hidock/jensen-protocol'
import type { RecordingRestoreSession } from '@hidock/jensen-protocol'
import type { DeviceScratchSealedStorage } from './device-scratch-journal'

export interface RecordingRestoreSourceFingerprint {
  path: string; filename: string; size: number; dev: string; ino: string; mtimeNs: string; ctimeNs: string
}
export interface RecordingRestoreOwnershipRecord {
  schema: 'RSTR2'; id: string; createdAt: string; processId: string; ownerId: number; recordingId: string
  source: RecordingRestoreSourceFingerprint; session: RecordingRestoreSession
}
export type RecordingRestoreResolutionEvidence = { kind: 'begin-not-dispatched' } |
  { kind: 'native-absent'; operation: 'abort' | 'status'; serialNumber: string; versionNumber: 393988; connectionSessionId: number } |
  { kind: 'full-sha256-readback'; serialNumber: string; versionNumber: 393988; connectionSessionId: number; totalBytes: number; sha256: string }
interface ResolutionReceipt {
  schema: 'RSTR2-resolution'; id: string; resolvedAt: string; ownershipSha256: string; evidence: RecordingRestoreResolutionEvidence
}
export const RESTORE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_BYTES = 16384
// Reserve one receipt per immutable ownership. Exhaustion blocks new BEGINs;
// unknown records are never deleted to recover capacity.
export const RESTORE_JOURNAL_MAX_OWNERSHIP = 1024
const keys = (value: object, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const sessionKeys = ['restoreId', 'ownerToken', 'totalBytes', 'wholeCrc32', 'sourceSha256', 'filename', 'serialNumber', 'connectionSessionId', 'versionNumber']

/** Main-only immutable OS-sealed RSTR2 records. No plaintext or native IO. */
export class DeviceRecordingRestoreJournal {
  readonly directory: string
  constructor(directory: string, private readonly sealed: DeviceScratchSealedStorage) { this.directory = resolve(directory) }
  isAvailable(): boolean { try { return this.sealed.isEncryptionAvailable() === true } catch { return false } }
  private path(id: string): string {
    if (typeof id !== 'string' || !RESTORE_UUID.test(id)) throw Error('Invalid restore reference')
    return join(this.directory, `${id.toLowerCase()}.rstr2.sealed`)
  }
  private validate(r: RecordingRestoreOwnershipRecord): boolean {
    const s = r?.session, source = r?.source
    return !!r && keys(r, ['schema', 'id', 'createdAt', 'processId', 'ownerId', 'recordingId', 'source', 'session']) &&
      r.schema === 'RSTR2' && typeof r.id === 'string' && RESTORE_UUID.test(r.id) && r.id === r.id.toLowerCase() &&
      typeof r.processId === 'string' && RESTORE_UUID.test(r.processId) && Number.isSafeInteger(r.ownerId) && r.ownerId > 0 &&
      typeof r.recordingId === 'string' && r.recordingId.length > 0 && r.recordingId.length <= 256 &&
      typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) &&
      !!s && keys(s, sessionKeys) && isRecordingRestoreDescriptor(s) && s.versionNumber === 393988 &&
      typeof s.serialNumber === 'string' && !!s.serialNumber.trim() && s.serialNumber.length <= 256 &&
      Number.isSafeInteger(s.connectionSessionId) && s.connectionSessionId >= 0 &&
      !!source && keys(source, ['path', 'filename', 'size', 'dev', 'ino', 'mtimeNs', 'ctimeNs']) &&
      typeof source.path === 'string' && source.path.length <= 4096 && isAbsolute(source.path) &&
      source.filename === s.filename && source.size === s.totalBytes &&
      [source.dev, source.ino, source.mtimeNs, source.ctimeNs].every(value => typeof value === 'string' && /^-?\d{1,40}$/.test(value))
  }
  private async directoryReady(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Restore journal unavailable')
  }
  private encoded(record: RecordingRestoreOwnershipRecord): string {
    // Fixed field order binds receipts to every authoritative ownership field,
    // including the original process/owner, source fingerprint and private token.
    const s = record.session, f = record.source
    return JSON.stringify({ schema: record.schema, id: record.id, createdAt: record.createdAt, processId: record.processId,
      ownerId: record.ownerId, recordingId: record.recordingId,
      source: { path: f.path, filename: f.filename, size: f.size, dev: f.dev, ino: f.ino, mtimeNs: f.mtimeNs, ctimeNs: f.ctimeNs },
      session: { restoreId: s.restoreId, ownerToken: hex(s.ownerToken), totalBytes: s.totalBytes, wholeCrc32: s.wholeCrc32,
        sourceSha256: hex(s.sourceSha256), filename: s.filename, serialNumber: s.serialNumber, connectionSessionId: s.connectionSessionId, versionNumber: s.versionNumber } })
  }
  private binding(record: RecordingRestoreOwnershipRecord): string { return createHash('sha256').update(this.encoded(record)).digest('hex') }
  private receiptPath(id: string): string { this.path(id); return join(this.directory, `${id.toLowerCase()}.rstr2.resolved.sealed`) }
  private async entries(): Promise<{ ownership: Set<string>; receipts: Set<string> }> {
    if (!this.isAvailable()) throw Error('Sealed restore ownership unavailable')
    try { await this.directoryReady(false) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ownership: new Set(), receipts: new Set() }
      throw error
    }
    const ownership = new Set<string>(), receipts = new Set<string>(), directory = await opendir(this.directory)
    let count = 0
    for await (const entry of directory) {
      if (++count > RESTORE_JOURNAL_MAX_OWNERSHIP * 2 || !entry.isFile() || entry.isSymbolicLink()) throw Error('Restore journal enumeration unavailable')
      const match = /^([a-f0-9-]+)\.rstr2\.(?:(resolved)\.)?sealed$/.exec(entry.name)
      if (!match || !RESTORE_UUID.test(match[1])) throw Error('Unknown restore journal entry')
      const ids = match[2] ? receipts : ownership
      if (ids.has(match[1])) throw Error('Duplicate restore journal entry')
      ids.add(match[1])
    }
    if (ownership.size > RESTORE_JOURNAL_MAX_OWNERSHIP || [...receipts].some(id => !ownership.has(id))) throw Error('Restore journal ownership unavailable')
    return { ownership, receipts }
  }
  private async writeSealed(path: string, plaintext: string): Promise<void> {
    if (!this.isAvailable()) throw Error('Sealed restore ownership unavailable')
    const bytes = this.sealed.encryptString(plaintext)
    if (!this.isAvailable() || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw Error('Sealed restore ownership unavailable')
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    // Windows does not support directory fsync via Node. File fsync remains
    // mandatory; POSIX additionally persists the new directory entry.
    if (process.platform !== 'win32') { const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync() } finally { await directory.close() } }
  }
  private validEvidence(record: RecordingRestoreOwnershipRecord, evidence: RecordingRestoreResolutionEvidence): boolean {
    if (!evidence || typeof evidence !== 'object') return false
    if (evidence.kind === 'begin-not-dispatched') return keys(evidence, ['kind'])
    if (!['native-absent', 'full-sha256-readback'].includes(evidence.kind) ||
      evidence.serialNumber !== record.session.serialNumber || evidence.versionNumber !== record.session.versionNumber ||
      !Number.isSafeInteger(evidence.connectionSessionId) || evidence.connectionSessionId < 0) return false
    return evidence.kind === 'native-absent' ? keys(evidence, ['kind', 'operation', 'serialNumber', 'versionNumber', 'connectionSessionId']) && ['abort', 'status'].includes(evidence.operation) :
      keys(evidence, ['kind', 'serialNumber', 'versionNumber', 'connectionSessionId', 'totalBytes', 'sha256']) &&
      evidence.totalBytes === record.session.totalBytes && evidence.sha256 === hex(record.session.sourceSha256)
  }
  private async readSealed(path: string): Promise<string> {
    if (!this.isAvailable()) throw Error('Sealed restore ownership unavailable')
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_BYTES) throw Error('Invalid sealed restore ownership')
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw Error('Invalid sealed restore ownership')
      while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead }
    } finally { await file.close() }
    if (!length || length > MAX_BYTES || !this.isAvailable()) throw Error('Invalid sealed restore ownership')
    return this.sealed.decryptString(buffer.subarray(0, length))
  }
  private async receipt(record: RecordingRestoreOwnershipRecord): Promise<ResolutionReceipt> {
    const value = JSON.parse(await this.readSealed(this.receiptPath(record.id))) as ResolutionReceipt
    if (!value || !keys(value, ['schema', 'id', 'resolvedAt', 'ownershipSha256', 'evidence']) || value.schema !== 'RSTR2-resolution' ||
      value.id !== record.id || typeof value.resolvedAt !== 'string' || !Number.isFinite(Date.parse(value.resolvedAt)) ||
      value.ownershipSha256 !== this.binding(record) || !this.validEvidence(record, value.evidence)) throw Error('Invalid sealed restore resolution')
    return value
  }
  private async inventory(): Promise<{ unresolved: RecordingRestoreOwnershipRecord[]; authorityCount: number }> {
    const entries = await this.entries(), unresolved: RecordingRestoreOwnershipRecord[] = []
    for (const id of entries.ownership) {
      const record = await this.load(id)
      if (entries.receipts.has(id)) await this.receipt(record)
      else unresolved.push(record)
    }
    return { unresolved, authorityCount: entries.ownership.size }
  }
  /** Bounded filesystem-only enumeration; validates resolved authorities too. */
  async list(): Promise<RecordingRestoreOwnershipRecord[]> { return (await this.inventory()).unresolved }
  /** Planning snapshot only; each BEGIN re-enforces the ceiling. Corruption,
   * unknown history or unavailable sealing throws rather than reports space. */
  async remainingAuthorityCapacity(): Promise<number> {
    return RESTORE_JOURNAL_MAX_OWNERSHIP - (await this.inventory()).authorityCount
  }
  async isResolved(id: string): Promise<boolean> {
    const record = await this.load(id)
    try { await lstat(this.receiptPath(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    await this.receipt(record); return true
  }
  /** Main-only evidence sink. No native replay, abort, STATUS or deletion. */
  async resolve(record: RecordingRestoreOwnershipRecord, evidence: RecordingRestoreResolutionEvidence): Promise<void> {
    if (!this.validate(record) || !this.validEvidence(record, evidence)) throw Error('Invalid restore resolution evidence')
    const authority = await this.load(record.id)
    if (this.binding(authority) !== this.binding(record)) throw Error('Restore ownership binding changed')
    if (await this.isResolved(record.id)) return // Existing receipt must validate before idempotence.
    const value: ResolutionReceipt = { schema: 'RSTR2-resolution', id: record.id, resolvedAt: new Date().toISOString(), ownershipSha256: this.binding(authority), evidence }
    await this.writeSealed(this.receiptPath(record.id), JSON.stringify(value))
    await this.receipt(authority)
  }
  async create(record: RecordingRestoreOwnershipRecord): Promise<void> {
    const path = this.path(record.id)
    if (!this.isAvailable() || !this.validate(record)) throw Error('Sealed restore ownership unavailable')
    const plaintext = this.encoded(record) // Snapshot private fields before asynchronous directory IO.
    const entries = await this.entries()
    if (entries.ownership.size >= RESTORE_JOURNAL_MAX_OWNERSHIP) throw Error('Restore journal capacity exhausted')
    await this.list() // A corrupt/unknown authority prevents new mutations.
    await this.directoryReady(true)
    await this.writeSealed(path, plaintext)
  }
  async load(id: string): Promise<RecordingRestoreOwnershipRecord> {
    const path = this.path(id)
    if (!this.isAvailable()) throw Error('Sealed restore ownership unavailable')
    await this.directoryReady(false)
    try {
      const value = JSON.parse(await this.readSealed(path))
      if (!value?.session || typeof value.session.ownerToken !== 'string' || !/^[a-f0-9]{32}$/.test(value.session.ownerToken) ||
        typeof value.session.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.session.sourceSha256)) throw Error()
      value.session.ownerToken = Uint8Array.from(Buffer.from(value.session.ownerToken, 'hex'))
      value.session.sourceSha256 = Uint8Array.from(Buffer.from(value.session.sourceSha256, 'hex'))
      if (value.id !== id.toLowerCase() || !this.validate(value)) throw Error()
      return value
    } catch { throw Error('Invalid sealed restore ownership') }
  }
}
