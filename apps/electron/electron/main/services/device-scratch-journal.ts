import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isOwnedScratchUploadDescriptor } from '@hidock/jensen-protocol'
import type { OwnedScratchUploadSession } from '@hidock/jensen-protocol'

export interface DeviceScratchSealedStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}
export interface DeviceScratchOwnershipRecord {
  schemaVersion: 1
  id: string
  createdAt: string
  session: OwnedScratchUploadSession
}
export type DeviceScratchResolutionEvidence = { kind: 'begin-not-dispatched' } |
  { kind: 'native-absent'; operation: 'abort'; serialNumber: string; versionNumber: 393986 | 393988; connectionSessionId: number } |
  { kind: 'native-finished'; operation: 'commit' | 'status'; serialNumber: string; versionNumber: 393986 | 393988; connectionSessionId: number; progressBytes: number }
interface ScratchResolutionReceipt {
  schemaVersion: 1; kind: 'scratch-resolution'; id: string; resolvedAt: string; ownershipSha256: string; evidence: DeviceScratchResolutionEvidence
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_RECORD_BYTES = 16384
export const SCRATCH_JOURNAL_MAX_OWNERSHIP = 512
const exactKeys = (value: object, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
const sessionKeys = ['uploadId', 'ownerToken', 'totalBytes', 'wholeCrc32', 'serialNumber', 'connectionSessionId', 'versionNumber']

/** Main-only, OS-sealed immutable ownership. No plaintext fallback or native IO. */
export class DeviceScratchJournal {
  readonly directory: string
  constructor(directory: string, private readonly sealed: DeviceScratchSealedStorage) { this.directory = resolve(directory) }
  isAvailable(): boolean {
    try { return this.sealed.isEncryptionAvailable() === true } catch { return false }
  }
  private path(id: string): string {
    if (typeof id !== 'string' || !UUID.test(id)) throw Error('Invalid scratch journal reference')
    return join(this.directory, `${id.toLowerCase()}.sealed`)
  }
  private validSession(session: OwnedScratchUploadSession): boolean {
    return !!session && Object.keys(session).every(key => sessionKeys.includes(key)) && sessionKeys.every(key => Object.hasOwn(session, key)) &&
      isOwnedScratchUploadDescriptor(session) && (session.versionNumber === 393986 || session.versionNumber === 393988) &&
      typeof session.serialNumber === 'string' && !!session.serialNumber.trim() && session.serialNumber.length <= 256 &&
      Number.isSafeInteger(session.connectionSessionId) && session.connectionSessionId >= 0
  }
  private async checkedDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Scratch journal directory is unavailable')
  }
  private binding(record: DeviceScratchOwnershipRecord): string {
    const s = record.session
    return createHash('sha256').update(JSON.stringify({ schemaVersion: record.schemaVersion, id: record.id, createdAt: record.createdAt,
      session: { uploadId: s.uploadId, ownerToken: s.ownerToken, totalBytes: s.totalBytes, wholeCrc32: s.wholeCrc32,
        serialNumber: s.serialNumber, connectionSessionId: s.connectionSessionId, versionNumber: s.versionNumber } })).digest('hex')
  }
  private receiptPath(id: string): string { this.path(id); return join(this.directory, `${id.toLowerCase()}.resolved.sealed`) }
  private async entries(): Promise<{ ownership: Set<string>; receipts: Set<string> }> {
    if (!this.isAvailable()) throw Error('Sealed scratch ownership is unavailable')
    try { await this.checkedDirectory(false) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ownership: new Set(), receipts: new Set() }
      throw error
    }
    const ownership = new Set<string>(), receipts = new Set<string>(), directory = await opendir(this.directory)
    let count = 0
    for await (const entry of directory) {
      if (++count > SCRATCH_JOURNAL_MAX_OWNERSHIP * 2 || !entry.isFile() || entry.isSymbolicLink()) throw Error('Scratch journal enumeration unavailable')
      const match = /^([a-f0-9-]+)\.(?:(resolved)\.)?sealed$/.exec(entry.name)
      if (!match || !UUID.test(match[1])) throw Error('Unknown scratch journal entry')
      const ids = match[2] ? receipts : ownership
      if (ids.has(match[1])) throw Error('Duplicate scratch journal entry')
      ids.add(match[1])
    }
    if (ownership.size > SCRATCH_JOURNAL_MAX_OWNERSHIP || [...receipts].some(id => !ownership.has(id))) throw Error('Scratch journal ownership unavailable')
    return { ownership, receipts }
  }
  private async writeSealed(path: string, plaintext: string): Promise<void> {
    if (!this.isAvailable()) throw Error('Sealed scratch ownership is unavailable')
    const bytes = this.sealed.encryptString(plaintext)
    if (!this.isAvailable() || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RECORD_BYTES) throw Error('Sealed scratch ownership is unavailable')
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    if (process.platform !== 'win32') { const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync() } finally { await directory.close() } }
  }
  private async readSealed(path: string): Promise<string> {
    if (!this.isAvailable()) throw Error('Sealed scratch ownership is unavailable')
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_RECORD_BYTES) throw Error('Invalid sealed scratch ownership')
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
    let length = 0
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw Error('Invalid sealed scratch ownership')
      while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead }
    } finally { await file.close() }
    if (!length || length > MAX_RECORD_BYTES || !this.isAvailable()) throw Error('Invalid sealed scratch ownership')
    return this.sealed.decryptString(buffer.subarray(0, length))
  }
  private validEvidence(record: DeviceScratchOwnershipRecord, evidence: DeviceScratchResolutionEvidence): boolean {
    if (!evidence || typeof evidence !== 'object') return false
    if (evidence.kind === 'begin-not-dispatched') return exactKeys(evidence, ['kind'])
    if (!['native-absent', 'native-finished'].includes(evidence.kind) || evidence.serialNumber !== record.session.serialNumber ||
      evidence.versionNumber !== record.session.versionNumber || !Number.isSafeInteger(evidence.connectionSessionId) || evidence.connectionSessionId < 0) return false
    return evidence.kind === 'native-absent' ? exactKeys(evidence, ['kind', 'operation', 'serialNumber', 'versionNumber', 'connectionSessionId']) && evidence.operation === 'abort' :
      exactKeys(evidence, ['kind', 'operation', 'serialNumber', 'versionNumber', 'connectionSessionId', 'progressBytes']) &&
      ['commit', 'status'].includes(evidence.operation) && evidence.progressBytes === record.session.totalBytes
  }
  private async receipt(record: DeviceScratchOwnershipRecord): Promise<ScratchResolutionReceipt> {
    const value = JSON.parse(await this.readSealed(this.receiptPath(record.id))) as ScratchResolutionReceipt
    if (!value || !exactKeys(value, ['schemaVersion', 'kind', 'id', 'resolvedAt', 'ownershipSha256', 'evidence']) || value.schemaVersion !== 1 ||
      value.kind !== 'scratch-resolution' || value.id !== record.id || typeof value.resolvedAt !== 'string' || !Number.isFinite(Date.parse(value.resolvedAt)) ||
      value.ownershipSha256 !== this.binding(record) || !this.validEvidence(record, value.evidence)) throw Error('Invalid sealed scratch resolution')
    return value
  }
  /** Filesystem-only and bounded. Resolved authorities are still validated. */
  async list(): Promise<DeviceScratchOwnershipRecord[]> {
    const entries = await this.entries(), unresolved: DeviceScratchOwnershipRecord[] = []
    for (const id of entries.ownership) { const record = await this.load(id); if (entries.receipts.has(id)) await this.receipt(record); else unresolved.push(record) }
    return unresolved
  }
  async isResolved(id: string): Promise<boolean> {
    const record = await this.load(id)
    try { await lstat(this.receiptPath(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    await this.receipt(record); return true
  }
  async resolve(record: DeviceScratchOwnershipRecord, evidence: DeviceScratchResolutionEvidence): Promise<void> {
    const authority = await this.load(record.id)
    if (this.binding(authority) !== this.binding(record) || !this.validEvidence(authority, evidence)) throw Error('Invalid scratch resolution evidence or binding')
    if (await this.isResolved(record.id)) return
    const receipt: ScratchResolutionReceipt = { schemaVersion: 1, kind: 'scratch-resolution', id: record.id, resolvedAt: new Date().toISOString(), ownershipSha256: this.binding(authority), evidence }
    await this.writeSealed(this.receiptPath(record.id), JSON.stringify(receipt)); await this.receipt(authority)
  }
  async create(id: string, session: OwnedScratchUploadSession): Promise<DeviceScratchOwnershipRecord> {
    const destination = this.path(id)
    if (!this.isAvailable() || !this.validSession(session)) throw Error('Sealed scratch ownership is unavailable')
    const record: DeviceScratchOwnershipRecord = { schemaVersion: 1, id: id.toLowerCase(), createdAt: new Date().toISOString(), session: { ...session } }
    let ciphertext: Buffer
    try { ciphertext = this.sealed.encryptString(JSON.stringify(record)) }
    catch { throw Error('Sealed scratch ownership is unavailable') }
    if (!this.isAvailable() || !Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_RECORD_BYTES) throw Error('Sealed scratch ownership is unavailable')
    const entries = await this.entries()
    if (entries.ownership.size >= SCRATCH_JOURNAL_MAX_OWNERSHIP) throw Error('Scratch journal capacity exhausted')
    await this.list()
    await this.checkedDirectory(true)
    // wx forbids replacement, including an existing symlink. A crash during this
    // write fails closed on decryption; BEGIN cannot run until fsync succeeds.
    const file = await open(destination, 'wx', 0o600)
    try { await file.writeFile(ciphertext); await file.sync() } finally { await file.close() }
    if (process.platform !== 'win32') { const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync() } finally { await directory.close() } }
    return record
  }
  async load(id: string): Promise<DeviceScratchOwnershipRecord> {
    const path = this.path(id)
    if (!this.isAvailable()) throw Error('Sealed scratch ownership is unavailable')
    await this.checkedDirectory(false)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_RECORD_BYTES) throw Error('Invalid sealed scratch ownership')
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
    let length = 0
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw Error('Invalid sealed scratch ownership')
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
    } finally { await file.close() }
    if (!length || length > MAX_RECORD_BYTES || !this.isAvailable()) throw Error('Invalid sealed scratch ownership')
    let value: DeviceScratchOwnershipRecord
    try { value = JSON.parse(this.sealed.decryptString(buffer.subarray(0, length))) }
    catch { throw Error('Invalid sealed scratch ownership') }
    if (!value || Object.keys(value).some(key => !['schemaVersion', 'id', 'createdAt', 'session'].includes(key)) || value.schemaVersion !== 1 ||
      value.id !== id.toLowerCase() || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !this.validSession(value.session)) {
      throw Error('Invalid sealed scratch ownership')
    }
    return { ...value, session: Object.freeze({ ...value.session }) }
  }
}
