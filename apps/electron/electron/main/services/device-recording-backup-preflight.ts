import { isAbsolute, resolve } from 'node:path'
import { isRecordingRestoreFilename } from '@hidock/jensen-protocol'
import { planWholeDeviceRecordingRestore, WHOLE_BACKUP_MAX_ENTRIES, WHOLE_BACKUP_MAX_SOURCE_BYTES } from './device-recording-restore-plan'
import type {
  TrustedBackupRoot, TrustedOriginalBinding, TrustedOriginalReceipt, WholeBackupIncompatibility, WholeBackupRestorePlan
} from './device-recording-restore-plan'
import type { DeviceFsCatalog, DeviceFsFile } from './device-file-system'
import type { OriginalBackupReceipt } from './original-recording-backups'

/**
 * Main-only authority adapter between the observed device catalog, the local
 * recording rows, the host receipt store and the whole-backup restore planner.
 *
 * Evidence limits: a `host-download-v1` receipt is evidence that this host
 * downloaded and hashed those bytes under that device name. It is not a native
 * device manifest, generation or digest. A compatible result never authorizes
 * erasing, formatting or writing the device.
 *
 * Every input comes from the injected main-process callbacks. The public
 * operation takes no inventory, name, path, root, hash or provenance argument,
 * and this module makes no IPC, USB or native call.
 */

/** The subset of a recordings row this adapter reads. Supplied by a main-owned query. */
export interface DeviceBackupLocalRow {
  id: string
  original_filename: string | null
  file_path: string | null
  on_local: number | boolean | null
  location: string | null
  deleted_at: string | null
}

export interface DeviceRecordingBackupPreflightDependencies {
  /** One fresh, complete native catalog observation. Its deviceId is the SHA-256 of the serial. */
  getCompleteCatalog(): Promise<DeviceFsCatalog>
  /** Authoritative local rows from the main-owned database. */
  listLocalRows(): Promise<readonly DeviceBackupLocalRow[]>
  /** Newest receipt for a recording, as OriginalRecordingBackupStore.latest returns it. */
  getLatestReceipt(recordingId: string): Promise<OriginalBackupReceipt | null> | OriginalBackupReceipt | null
  /** Main-owned named roots, including explicitly approved archives. */
  getTrustedBackupRoots(): Promise<readonly TrustedBackupRoot[]>
  /** Remaining RSTR2 journal authority slots. */
  remainingAuthorityCapacity(): Promise<number>
  /** Free bytes on the destination. */
  remainingDestinationBytes(): Promise<number>
}

export interface DeviceRecordingBackupPreflightDiagnostics {
  catalogFileCount: number
  eligibleLocalRowCount: number
  provenFileCount: number
  filesWithoutLocalRow: number
  filesWithoutReceipt: number
  filesWithMismatchedReceipt: number
  filesWithAmbiguousCandidates: number
}

export interface DeviceRecordingBackupPreflight extends WholeBackupRestorePlan {
  baselineEvidence: 'host-download-v1-receipts'
  deviceMutationAuthorized: false
  /** Counts only. No names, paths or hashes. */
  diagnostics: DeviceRecordingBackupPreflightDiagnostics
}

const SHA256 = /^[a-f0-9]{64}$/
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const safeSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= WHOLE_BACKUP_MAX_SOURCE_BYTES

const isEligibleLocalRow = (row: DeviceBackupLocalRow): boolean =>
  !!row && text(row.id) && text(row.original_filename) && text(row.file_path, 4096) && isAbsolute(row.file_path) &&
  (row.deleted_at == null || row.deleted_at === '') &&
  (row.on_local === 1 || row.on_local === true) && (row.location === 'local-only' || row.location === 'both')

function catalogProblems(catalog: DeviceFsCatalog | null | undefined): Set<WholeBackupIncompatibility> {
  const problems = new Set<WholeBackupIncompatibility>()
  if (!catalog || catalog.complete !== true || typeof catalog.deviceId !== 'string' || !SHA256.test(catalog.deviceId) ||
    !text(catalog.sessionId) || !Array.isArray(catalog.files) || catalog.files.length === 0) {
    problems.add('baseline-unavailable-or-invalid')
    return problems
  }
  if (catalog.files.length > WHOLE_BACKUP_MAX_ENTRIES) problems.add('authority-capacity-exhausted')
  const names = new Set<string>()
  for (const file of catalog.files) {
    if (!file || typeof file.name !== 'string' || !isRecordingRestoreFilename(file.name)) { problems.add('unsupported-original-filename'); continue }
    if (!safeSize(file.size)) problems.add('invalid-source-size')
    const key = file.name.toLowerCase()
    if (names.has(key)) problems.add('duplicate-filename'); else names.add(key)
  }
  return problems
}

/** Every term of a host-download-v1 receipt must match the observed catalog file and the local row. */
function bindsHostDownload(receipt: OriginalBackupReceipt | null | undefined, row: DeviceBackupLocalRow, file: DeviceFsFile, deviceId: string): receipt is OriginalBackupReceipt {
  return !!receipt && receipt.originKind === 'host-download-v1' &&
    Number.isSafeInteger(receipt.receiptVersion) && receipt.receiptVersion >= 1 &&
    receipt.recordingId === row.id && receipt.originalFilename === file.name && receipt.totalBytes === file.size &&
    typeof receipt.deviceIdSha256 === 'string' && receipt.deviceIdSha256 === deviceId &&
    typeof receipt.sha256 === 'string' && SHA256.test(receipt.sha256) &&
    text(receipt.model) && text(receipt.firmware) &&
    text(receipt.canonicalPath, 4096) && isAbsolute(receipt.canonicalPath) && resolve(receipt.canonicalPath) === resolve(row.file_path as string)
}

async function lookup(deps: DeviceRecordingBackupPreflightDependencies, recordingId: string): Promise<OriginalBackupReceipt | null> {
  try { return (await deps.getLatestReceipt(recordingId)) ?? null } catch { return null }
}

interface ProvenFile { row: DeviceBackupLocalRow; file: DeviceFsFile; receipt: OriginalBackupReceipt }

/**
 * Builds the baseline and local inventories from main-owned callbacks, then lets
 * the existing planner hash every local source against its named trusted roots.
 * Any catalog file without exactly one proven candidate fails the whole batch.
 */
export async function planDeviceRecordingBackupPreflight(deps: DeviceRecordingBackupPreflightDependencies): Promise<DeviceRecordingBackupPreflight> {
  const diagnostics: DeviceRecordingBackupPreflightDiagnostics = {
    catalogFileCount: 0, eligibleLocalRowCount: 0, provenFileCount: 0,
    filesWithoutLocalRow: 0, filesWithoutReceipt: 0, filesWithMismatchedReceipt: 0, filesWithAmbiguousCandidates: 0
  }
  const refuse = (...reasons: WholeBackupIncompatibility[]): DeviceRecordingBackupPreflight => ({
    compatibility: 'incompatible', executionReadiness: 'not-ready', incompatibilities: [...new Set(reasons)], destinationCollisions: 0,
    summary: { entryCount: 0, reservedBytes: 0, rehashPerformed: false, checkedSourceCount: 0 }, compatibilityEntries: [],
    baselineEvidence: 'host-download-v1-receipts', deviceMutationAuthorized: false, diagnostics: { ...diagnostics }
  })

  let catalog: DeviceFsCatalog
  try { catalog = await deps.getCompleteCatalog() } catch { return refuse('baseline-unavailable-or-invalid') }
  const problems = catalogProblems(catalog)
  diagnostics.catalogFileCount = Array.isArray(catalog?.files) ? catalog.files.length : 0
  if (problems.size) return refuse(...problems)

  let rows: readonly DeviceBackupLocalRow[]
  try { rows = await deps.listLocalRows(); if (!Array.isArray(rows)) throw Error() } catch { return refuse('local-backup-unavailable-or-invalid') }
  const byName = new Map<string, DeviceBackupLocalRow[]>()
  for (const row of rows) {
    if (!isEligibleLocalRow(row)) continue
    diagnostics.eligibleLocalRowCount++
    const group = byName.get(row.original_filename as string)
    if (group) group.push(row); else byName.set(row.original_filename as string, [row])
  }

  const reasons = new Set<WholeBackupIncompatibility>()
  const proven: ProvenFile[] = []
  for (const file of catalog.files) {
    const candidates = byName.get(file.name) ?? []
    if (!candidates.length) { diagnostics.filesWithoutLocalRow++; reasons.add('local-backup-unavailable-or-invalid'); continue }
    const valid: ProvenFile[] = []
    // A candidate with no receipt falls through to "receipt-unavailable" below.
    let mismatched = 0
    for (const row of candidates) {
      const receipt = await lookup(deps, row.id)
      if (!receipt) continue
      if (bindsHostDownload(receipt, row, file, catalog.deviceId)) valid.push({ row, file, receipt: { ...receipt } })
      else mismatched++
    }
    if (valid.length === 1) proven.push(valid[0])
    else if (valid.length > 1) { diagnostics.filesWithAmbiguousCandidates++; reasons.add('duplicate-filename') }
    else if (mismatched) { diagnostics.filesWithMismatchedReceipt++; reasons.add('receipt-binding-mismatch') }
    else { diagnostics.filesWithoutReceipt++; reasons.add('receipt-unavailable-or-invalid') }
  }
  diagnostics.provenFileCount = proven.length
  if (reasons.size || proven.length !== catalog.files.length) return refuse(...reasons, ...(reasons.size ? [] : ['baseline-unavailable-or-invalid' as const]))

  const expected = new Map(proven.map(item => [item.row.id, item]))
  const entries = (path: (item: ProvenFile) => string): TrustedOriginalBinding[] => proven.map(item => ({
    recordingId: item.row.id, filename: item.file.name, sourcePath: path(item), byteLength: item.receipt.totalBytes, sha256: item.receipt.sha256
  }))
  const destinationNames = catalog.files.map(file => file.name)

  const plan = await planWholeDeviceRecordingRestore({
    getTrustedBackupRoots: () => deps.getTrustedBackupRoots(),
    remainingAuthorityCapacity: () => deps.remainingAuthorityCapacity(),
    remainingDestinationBytes: () => deps.remainingDestinationBytes(),
    listDestinationFilenames: async () => destinationNames,
    getTrustedOriginalReceipt: async (recordingId): Promise<TrustedOriginalReceipt | null> => {
      const item = expected.get(recordingId)
      if (!item) return null
      const fresh = await lookup(deps, recordingId)
      if (!bindsHostDownload(fresh, item.row, item.file, catalog.deviceId)) return null
      return {
        recordingId, filename: item.file.name, sourcePath: fresh.canonicalPath, byteLength: fresh.totalBytes, sha256: fresh.sha256,
        provenance: 'independent-original-download', immutable: true
      }
    }
  }, {
    baseline: { provenance: 'trusted-original-baseline', entries: entries(item => item.receipt.canonicalPath) },
    localBackup: { provenance: 'trusted-local-backup', entries: entries(item => item.row.file_path as string) }
  })

  return { ...plan, baselineEvidence: 'host-download-v1-receipts', deviceMutationAuthorized: false, diagnostics: { ...diagnostics } }
}
