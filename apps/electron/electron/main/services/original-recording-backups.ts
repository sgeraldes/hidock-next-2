import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isRecordingRestoreFilename } from '@hidock/jensen-protocol'
import { isOwnedResumedDownload } from './download-resume'
import type { ResumeSource } from './download-resume'
import type { StagedRecording } from './download-staging'

/**
 * Immutable receipts for the exact bytes a recording had when this host first
 * held them.
 *
 * What a receipt claims, and what it does not:
 * - `host-download-v1`: this main process received `sha256` over `totalBytes`
 *   bytes through a main-owned resumable transfer of the device file
 *   `originalFilename`. The digest is computed by the host over the complete
 *   received stream. It is host download evidence. It is not a native device
 *   manifest, not a native device digest and not an immutable device generation.
 * - `owned-upload-v1`: a main-process fixture registration for a file this
 *   application owns. It carries no device provenance at all.
 *
 * A recording row's `original_filename`, a split child, an import, a direct save
 * or a Buffer sent by the renderer never produce either kind.
 */
export type OriginalBackupOriginKind = 'host-download-v1' | 'owned-upload-v1'

export interface OriginalBackupReceipt {
  recordingId: string
  receiptVersion: number
  originKind: OriginalBackupOriginKind
  originalFilename: string
  canonicalPath: string
  totalBytes: number
  /** Host-computed SHA-256 of the complete received byte stream. */
  sha256: string
  /** Hashed device identity from the transfer snapshot; null for owned uploads. */
  deviceIdSha256: string | null
  model: string | null
  firmware: string | null
  /** MD5 of the device's first-1-KiB helper. A source observation, never proof of the full file. */
  catalogSignatureMd5: string | null
  acquiredAt: string
}

/** getDatabase()-compatible (sql.js facade) subset. */
export interface OriginalBackupDatabase {
  run(sql: string, params?: unknown[]): unknown
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
}

export interface OriginalBackupStoreOptions {
  db: OriginalBackupDatabase
  /** Pass the application's runInTransaction when one is available; otherwise the store opens its own BEGIN IMMEDIATE. */
  transaction?: <T>(fn: () => T) => T
  now?: () => Date
}

const SHA256 = /^[a-f0-9]{64}$/
const MAX_BYTES = 0x7fffffff
const TABLE = 'original_recording_backup_receipts'
const COLUMNS = 'recording_id, receipt_version, origin_kind, original_filename, canonical_path, total_bytes, sha256, ' +
  'device_id_sha256, model, firmware, catalog_signature_md5, acquired_at'

/** What a successful, main-owned transfer proved. Only claimHostDownloadTransfer can mint one. */
export interface HostDownloadTransfer {
  readonly originalFilename: string
  readonly totalBytes: number
  readonly sha256: string
  readonly deviceIdSha256: string
  readonly model: string
  readonly firmware: string
  readonly catalogSignatureMd5: string | null
}

const registered = new WeakMap<StagedRecording, HostDownloadTransfer>()
// Claims are single-use. 'open' until recordHostDownload sees them; then spent, bound to the one recording id that tried.
const claimed = new WeakMap<HostDownloadTransfer, { spentBy: string | null }>()

const shortText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256

/**
 * Main-only. Call with the StagedRecording returned by downloadWithResume and the
 * ResumeSource snapshot that call was made with, while its publication lease is
 * still held. The lease is the proof that this process, and no other owner, ran
 * the transfer; nothing a renderer sends can satisfy it. A transfer that is not
 * registered simply gets no receipt.
 */
export function registerHostDownloadTransfer(staged: StagedRecording, source: ResumeSource): boolean {
  // Never throws: a download must not fail because its evidence is unsupported.
  // false means no receipt will exist, and restore refuses such a recording.
  if (!staged || typeof staged !== 'object' || Buffer.isBuffer(staged) || !isOwnedResumedDownload(staged) || registered.has(staged)) return false
  if (!source || source.listingComplete !== true || source.completed !== true || !isRecordingRestoreFilename(source.filename) ||
      !Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_BYTES || source.size !== staged.length ||
      !SHA256.test(staged.sha256) || !SHA256.test(source.deviceId) || !shortText(source.model) || !shortText(source.firmware) ||
      typeof source.signature !== 'string') return false
  registered.set(staged, Object.freeze({
    originalFilename: source.filename, totalBytes: staged.length, sha256: staged.sha256, deviceIdSha256: source.deviceId,
    model: source.model, firmware: source.firmware,
    catalogSignatureMd5: /^[a-f0-9]{32}$/i.test(source.signature) ? source.signature.toLowerCase() : null
  }))
  return true
}

/**
 * Call once, before publishing. Consumes the registration. Null (no receipt) for a
 * Buffer, for any object that was not registered, for a lease already released,
 * and when the queue filename, length or digest differ from what was registered.
 */
export function claimHostDownloadTransfer(data: Buffer | StagedRecording, filename: string): HostDownloadTransfer | null {
  if (!data || typeof data !== 'object' || Buffer.isBuffer(data)) return null
  const transfer = registered.get(data)
  if (!transfer) return null
  registered.delete(data)
  if (!isOwnedResumedDownload(data) || transfer.originalFilename !== filename || transfer.totalBytes !== data.length || transfer.sha256 !== data.sha256) return null
  claimed.set(transfer, { spentBy: null })
  return transfer
}

function assertIdentity(recordingId: string, originalFilename: string): void {
  if (!shortText(recordingId)) throw new Error('Invalid recording identity')
  if (!isRecordingRestoreFilename(originalFilename)) throw new Error('Invalid original device filename')
}

/** Regular file, no symlink, the expected length. Returns the canonical path. */
function canonicalRegularFile(path: string, expectedBytes: number): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || !isAbsolute(path)) throw new Error('Invalid published path')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) throw new Error('The published file does not match the received transfer')
  return realpathSync.native(path)
}

export class OriginalRecordingBackupStore {
  private ready = false
  constructor(private readonly options: OriginalBackupStoreOptions) {}

  private schema(): void {
    if (this.ready) return
    const { db } = this.options
    db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      recording_id TEXT NOT NULL,
      receipt_version INTEGER NOT NULL CHECK (receipt_version >= 1),
      origin_kind TEXT NOT NULL CHECK (origin_kind IN ('host-download-v1', 'owned-upload-v1')),
      original_filename TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= ${MAX_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      device_id_sha256 TEXT,
      model TEXT,
      firmware TEXT,
      catalog_signature_md5 TEXT,
      acquired_at TEXT NOT NULL,
      PRIMARY KEY (recording_id, receipt_version),
      UNIQUE (recording_id, sha256),
      CHECK (
        (origin_kind = 'host-download-v1' AND device_id_sha256 IS NOT NULL AND model IS NOT NULL AND firmware IS NOT NULL) OR
        (origin_kind = 'owned-upload-v1' AND device_id_sha256 IS NULL AND model IS NULL AND firmware IS NULL AND catalog_signature_md5 IS NULL)
      )
    )`)
    // INSERT OR REPLACE resolves a key conflict by deleting the old row without firing the delete trigger.
    db.run(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_overwrite BEFORE INSERT ON ${TABLE}
      WHEN EXISTS (SELECT 1 FROM ${TABLE} WHERE recording_id = NEW.recording_id AND receipt_version = NEW.receipt_version)
      BEGIN SELECT RAISE(ABORT, 'original backup receipts are immutable'); END`)
    db.run(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_update BEFORE UPDATE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, 'original backup receipts are immutable'); END`)
    db.run(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_delete BEFORE DELETE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, 'original backup receipts are immutable'); END`)
    this.ready = true
  }

  private inTransaction<T>(fn: () => T): T {
    if (this.options.transaction) return this.options.transaction(fn)
    const { db } = this.options
    db.run('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.run('COMMIT')
      return result
    } catch (error) {
      try { db.run('ROLLBACK') } catch { /* the failed statement may already have ended the transaction */ }
      throw error
    }
  }

  private map(row: unknown[]): OriginalBackupReceipt {
    const [recordingId, receiptVersion, originKind, originalFilename, canonicalPath, totalBytes, sha256, deviceIdSha256, model, firmware, signature, acquiredAt] = row
    if (typeof recordingId !== 'string' || !Number.isSafeInteger(receiptVersion) || (originKind !== 'host-download-v1' && originKind !== 'owned-upload-v1') ||
        typeof originalFilename !== 'string' || typeof canonicalPath !== 'string' || !Number.isSafeInteger(totalBytes) ||
        typeof sha256 !== 'string' || !SHA256.test(sha256) || typeof acquiredAt !== 'string') throw new Error('Corrupt original backup receipt')
    return { recordingId, receiptVersion: receiptVersion as number, originKind, originalFilename, canonicalPath, totalBytes: totalBytes as number, sha256,
      deviceIdSha256: (deviceIdSha256 as string | null) ?? null, model: (model as string | null) ?? null, firmware: (firmware as string | null) ?? null,
      catalogSignatureMd5: (signature as string | null) ?? null, acquiredAt }
  }

  /** Every receipt for a recording, oldest first. */
  list(recordingId: string): OriginalBackupReceipt[] {
    if (!shortText(recordingId)) return []
    this.schema()
    const rows = this.options.db.exec(`SELECT ${COLUMNS} FROM ${TABLE} WHERE recording_id = ? ORDER BY receipt_version`, [recordingId])[0]?.values ?? []
    return rows.map(row => this.map(row))
  }

  /**
   * The newest immutable acquisition evidence for the recording, or null. It records
   * what the host received when it was stored. It does not assert that the file on disk
   * still holds those bytes: the restore service compares a fresh full SHA-256 to
   * `sha256` at BEGIN, which is where a later edit is caught.
   */
  latest(recordingId: string): OriginalBackupReceipt | null {
    if (!shortText(recordingId)) return null
    this.schema()
    const row = this.options.db.exec(`SELECT ${COLUMNS} FROM ${TABLE} WHERE recording_id = ? ORDER BY receipt_version DESC LIMIT 1`, [recordingId])[0]?.values[0]
    return row ? this.map(row) : null
  }

  private append(base: Omit<OriginalBackupReceipt, 'receiptVersion' | 'acquiredAt'>): OriginalBackupReceipt {
    this.schema()
    return this.inTransaction(() => {
      const latest = this.latest(base.recordingId)
      if (latest && latest.originKind === base.originKind && latest.originalFilename === base.originalFilename &&
          latest.canonicalPath === base.canonicalPath && latest.totalBytes === base.totalBytes && latest.sha256 === base.sha256) return latest
      const version = (latest?.receiptVersion ?? 0) + 1
      this.options.db.run(`INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [base.recordingId, version, base.originKind, base.originalFilename, base.canonicalPath, base.totalBytes, base.sha256,
          base.deviceIdSha256, base.model, base.firmware, base.catalogSignatureMd5, (this.options.now?.() ?? new Date()).toISOString()])
      const stored = this.latest(base.recordingId)
      if (!stored || stored.receiptVersion !== version) throw new Error('Original backup receipt was not stored')
      return stored
    })
  }

  /**
   * Persist the evidence of a claimed transfer. Call only after the file is published
   * and the recording row is resolved. Appends a new version and never touches an older one.
   *
   * One attempt per claim. The first call spends the claim and binds it to that recording
   * id, whether or not it succeeds; any later call, for the same or another id, is refused.
   * The stored digest is the one computed over the received stream. The published file is
   * only checked for kind, symlink and length (a bounded stat); it is never rehashed here,
   * so the receipt cannot silently redefine "original" as whatever is on disk now.
   */
  recordHostDownload(input: { recordingId: string; publishedPath: string; transfer: HostDownloadTransfer }): OriginalBackupReceipt {
    const { transfer } = input
    const state = transfer ? claimed.get(transfer) : undefined
    if (!transfer || !state) throw new Error('Host download evidence must come from a claimed main-owned transfer')
    if (state.spentBy !== null) throw new Error('This transfer claim was already used')
    state.spentBy = typeof input.recordingId === 'string' ? input.recordingId : ''
    assertIdentity(input.recordingId, transfer.originalFilename)
    return this.append({
      recordingId: input.recordingId, originKind: 'host-download-v1', originalFilename: transfer.originalFilename,
      canonicalPath: canonicalRegularFile(input.publishedPath, transfer.totalBytes), totalBytes: transfer.totalBytes, sha256: transfer.sha256,
      deviceIdSha256: transfer.deviceIdSha256, model: transfer.model, firmware: transfer.firmware, catalogSignatureMd5: transfer.catalogSignatureMd5
    })
  }

  /**
   * Main-only registration for a synthetic file this application owns, for test
   * fixtures. The host reads and hashes the file itself. No device provenance is
   * recorded or implied, and there is no renderer entry point to this method.
   */
  async registerOwnedUpload(input: { recordingId: string; originalFilename: string; path: string }): Promise<OriginalBackupReceipt> {
    assertIdentity(input.recordingId, input.originalFilename)
    if (typeof input.path !== 'string' || !input.path || input.path.length > 4096 || !isAbsolute(input.path)) throw new Error('Invalid owned upload path')
    const before = lstatSync(input.path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error('Invalid owned upload file')
    const file = await open(input.path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    try {
      for (let offset = 0; offset < before.size;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
        if (!bytesRead) throw new Error('Owned upload file was truncated while hashing')
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
      }
      const after = await file.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Owned upload file changed while hashing')
    } finally { await file.close() }
    return this.append({
      recordingId: input.recordingId, originKind: 'owned-upload-v1', originalFilename: input.originalFilename,
      canonicalPath: canonicalRegularFile(input.path, before.size), totalBytes: before.size, sha256: hash.digest('hex'),
      deviceIdSha256: null, model: null, firmware: null, catalogSignatureMd5: null
    })
  }
}
