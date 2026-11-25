import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isRecordingRestoreFilename } from '@hidock/jensen-protocol'

/**
 * Read-only F11 whole-backup compatibility planning.  This module deliberately
 * has no device, IPC, renderer, journal, or restore-service import: the caller
 * supplies only main-process authorities whose provenance is explicit below.
 */
export const WHOLE_BACKUP_MAX_ENTRIES = 1024
export const WHOLE_BACKUP_MAX_SOURCE_BYTES = 0x7fffffff
const MIB = 1024 * 1024
const HASH_BUFFER_BYTES = 64 * 1024

export interface TrustedOriginalBinding {
  recordingId: string
  filename: string
  sourcePath: string
  byteLength: number
  sha256: string
}

/** These receipts are issued by a main-process authority, never renderer data. */
export interface TrustedOriginalReceipt extends TrustedOriginalBinding {
  provenance: 'independent-original-download' | 'owned-upload'
  immutable: true
}

/** A root explicitly allowed by a main-process authority. Never renderer input. */
export interface TrustedBackupRoot {
  name: string
  path: string
}

/** A main-process-owned inventory; exact set equality is required. */
export interface TrustedWholeBackupInventory {
  provenance: 'trusted-original-baseline' | 'trusted-local-backup'
  entries: readonly TrustedOriginalBinding[]
}

export interface DeviceRecordingRestorePlanDependencies {
  /** Explicit app-owned roots; may include separately named approved archives. */
  getTrustedBackupRoots(): Promise<readonly TrustedBackupRoot[]>
  /** Must fail closed for missing, corrupt, or unknown RSTR2 authority state. */
  remainingAuthorityCapacity(): Promise<number>
  /** Must enumerate the actual destination; it is not a renderer assertion. */
  listDestinationFilenames(): Promise<readonly string[]>
  /** Must report actual remaining storage in bytes; unknown is not zero. */
  remainingDestinationBytes(): Promise<number>
  /** Main-process receipt lookup, bound to original name, length, SHA-256 and path. */
  getTrustedOriginalReceipt(recordingId: string): Promise<TrustedOriginalReceipt | null>
}

export interface WholeBackupRestorePlanRequest {
  baseline: TrustedWholeBackupInventory | null | undefined
  localBackup: TrustedWholeBackupInventory | null | undefined
  /** Defaults to true. False permits structural compatibility only, never readiness. */
  rehashLocalFiles?: boolean
}

export type WholeBackupIncompatibility =
  | 'baseline-unavailable-or-invalid' | 'local-backup-unavailable-or-invalid'
  | 'duplicate-recording-id' | 'duplicate-filename' | 'unsupported-original-filename'
  | 'invalid-source-size' | 'inventory-mismatch' | 'receipt-unavailable-or-invalid'
  | 'receipt-binding-mismatch' | 'local-source-unavailable-or-changed'
  | 'source-root-unavailable-or-invalid' | 'local-source-outside-trusted-root' | 'local-bytes-not-verified'
  | 'authority-capacity-unavailable' | 'authority-capacity-exhausted'
  | 'destination-capacity-unavailable' | 'destination-capacity-exhausted'

export interface WholeBackupRestoreSummary {
  entryCount: number
  reservedBytes: number
  rehashPerformed: boolean
  /** Number of source files whose full SHA-256 was checked during this plan. */
  checkedSourceCount: number
}

export interface WholeBackupRestorePlan {
  compatibility: 'compatible' | 'incompatible'
  /** File/destination readiness only; firmware capability and erase consent are separate. */
  executionReadiness: 'ready-on-empty-destination' | 'blocked-destination-collision' | 'not-ready'
  /** Includes readiness blockers such as local-bytes-not-verified. */
  incompatibilities: readonly WholeBackupIncompatibility[]
  destinationCollisions: number
  summary: WholeBackupRestoreSummary
  /** Complete original bindings only after every source has passed whole-file verification. */
  compatibilityEntries: readonly Readonly<TrustedOriginalBinding>[]
}

const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const filename = (value: unknown): value is string => typeof value === 'string' && isRecordingRestoreFilename(value)
const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
const add = (reasons: Set<WholeBackupIncompatibility>, reason: WholeBackupIncompatibility) => reasons.add(reason)
const within = (root: string, file: string): boolean => {
  const rel = relative(key(root), key(file))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

interface CanonicalBackupRoot {
  name: string
  configuredPath: string
  canonicalPath: string
  dev: bigint
  ino: bigint
}

interface ContainedSource {
  root: CanonicalBackupRoot
  canonicalPath: string
  stat: BigIntStats
}

type SourceCheck = { status: 'contained'; source: ContainedSource } | { status: 'outside-root' | 'unavailable' }

function validBinding(entry: TrustedOriginalBinding): boolean {
  return !!entry && typeof entry.recordingId === 'string' && entry.recordingId.length > 0 && entry.recordingId.length <= 256 &&
    filename(entry.filename) && typeof entry.sourcePath === 'string' && isAbsolute(entry.sourcePath) && entry.sourcePath.length <= 4096 &&
    safeInteger(entry.byteLength) && entry.byteLength > 0 && entry.byteLength <= WHOLE_BACKUP_MAX_SOURCE_BYTES && sha256(entry.sha256)
}

function sameBinding(a: TrustedOriginalBinding, b: TrustedOriginalBinding): boolean {
  return a.recordingId === b.recordingId && a.filename === b.filename && resolve(a.sourcePath) === resolve(b.sourcePath) &&
    a.byteLength === b.byteLength && a.sha256.toLowerCase() === b.sha256.toLowerCase()
}

/** Firmware allocation headroom: 1 KiB descriptor + MiB alignment + 8 MiB control reserve. */
export function conservativeRestoreAllocation(byteLength: number): number | null {
  if (!safeInteger(byteLength) || byteLength < 1 || byteLength > WHOLE_BACKUP_MAX_SOURCE_BYTES) return null
  const allocated = Math.ceil((byteLength + 1024) / MIB) * MIB + (8 * MIB)
  return Number.isSafeInteger(allocated) ? allocated : null
}

async function loadTrustedBackupRoots(deps: DeviceRecordingRestorePlanDependencies): Promise<CanonicalBackupRoot[] | null> {
  try {
    const configured = await deps.getTrustedBackupRoots()
    if (!Array.isArray(configured) || configured.length === 0) return null
    const roots: CanonicalBackupRoot[] = [], names = new Set<string>()
    for (const entry of configured) {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 128 || entry.name !== entry.name.trim() ||
        names.has(entry.name) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || entry.path.length > 4096) return null
      const initial = await lstat(entry.path, { bigint: true })
      if (!initial.isDirectory() && !initial.isSymbolicLink()) return null
      const canonicalPath = await realpath(entry.path)
      const canonicalStat = await lstat(canonicalPath, { bigint: true })
      if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink() ||
        !initial.isSymbolicLink() && (canonicalStat.dev !== initial.dev || canonicalStat.ino !== initial.ino)) return null
      roots.push({ name: entry.name, configuredPath: entry.path, canonicalPath, dev: canonicalStat.dev, ino: canonicalStat.ino })
      names.add(entry.name)
    }
    return roots
  } catch { return null }
}

async function rootIsUnchanged(root: CanonicalBackupRoot): Promise<boolean> {
  try {
    if (key(await realpath(root.configuredPath)) !== key(root.canonicalPath)) return false
    const stat = await lstat(root.canonicalPath, { bigint: true })
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino
  } catch { return false }
}

async function inspectContainedSource(binding: TrustedOriginalBinding, roots: readonly CanonicalBackupRoot[]): Promise<SourceCheck> {
  try {
    const initial = await lstat(binding.sourcePath, { bigint: true })
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size !== BigInt(binding.byteLength)) return { status: 'unavailable' }
    const canonicalPath = await realpath(binding.sourcePath)
    const canonicalStat = await lstat(canonicalPath, { bigint: true })
    if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink() || canonicalStat.dev !== initial.dev || canonicalStat.ino !== initial.ino ||
      canonicalStat.size !== initial.size || canonicalStat.mtimeNs !== initial.mtimeNs || canonicalStat.ctimeNs !== initial.ctimeNs) return { status: 'unavailable' }
    const root = roots.find(candidate => within(candidate.canonicalPath, canonicalPath))
    if (!root) return { status: 'outside-root' }
    if (!await rootIsUnchanged(root)) return { status: 'unavailable' }
    return { status: 'contained', source: { root, canonicalPath, stat: canonicalStat } }
  } catch { return { status: 'unavailable' } }
}

async function hashUnchangedFile(binding: TrustedOriginalBinding, roots: readonly CanonicalBackupRoot[]): Promise<Exclude<SourceCheck['status'], 'contained'> | 'verified'> {
  const initialCheck = await inspectContainedSource(binding, roots)
  if (initialCheck.status !== 'contained') return initialCheck.status
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    file = await open(binding.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(binding.byteLength) || before.dev !== initialCheck.source.stat.dev || before.ino !== initialCheck.source.stat.ino ||
      before.mtimeNs !== initialCheck.source.stat.mtimeNs || before.ctimeNs !== initialCheck.source.stat.ctimeNs) return 'unavailable'
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    let offset = 0
    while (offset < binding.byteLength) {
      const wanted = Math.min(HASH_BUFFER_BYTES, binding.byteLength - offset)
      let read = 0
      while (read < wanted) {
        const result = await file.read(buffer, read, wanted - read, offset + read)
        if (!result.bytesRead) return 'unavailable'
        read += result.bytesRead
      }
      digest.update(buffer.subarray(0, read)); offset += read
    }
    const after = await file.stat({ bigint: true })
    const finalCheck = await inspectContainedSource(binding, roots)
    if (finalCheck.status !== 'contained') return finalCheck.status
    return after.isFile() && after.size === before.size && after.dev === before.dev && after.ino === before.ino &&
      after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs &&
      key(finalCheck.source.canonicalPath) === key(initialCheck.source.canonicalPath) &&
      finalCheck.source.stat.dev === before.dev && finalCheck.source.stat.ino === before.ino &&
      finalCheck.source.stat.mtimeNs === before.mtimeNs && finalCheck.source.stat.ctimeNs === before.ctimeNs &&
      digest.digest('hex').toLowerCase() === binding.sha256.toLowerCase() ? 'verified' : 'unavailable'
  } catch { return 'unavailable' }
  finally { await file?.close().catch(() => undefined) }
}

/**
 * Plans only. It never issues BEGIN, erases a destination, opens a device,
 * mutates a driver, or attests firmware generation/recovery.
 */
export async function planWholeDeviceRecordingRestore(
  deps: DeviceRecordingRestorePlanDependencies,
  request: WholeBackupRestorePlanRequest
): Promise<WholeBackupRestorePlan> {
  const reasons = new Set<WholeBackupIncompatibility>()
  const invalid = (reason: WholeBackupIncompatibility): WholeBackupRestorePlan => ({
    compatibility: 'incompatible', executionReadiness: 'not-ready', incompatibilities: [reason], destinationCollisions: 0,
    summary: { entryCount: 0, reservedBytes: 0, rehashPerformed: false, checkedSourceCount: 0 }, compatibilityEntries: []
  })
  if (!request?.baseline || request.baseline.provenance !== 'trusted-original-baseline' || !Array.isArray(request.baseline.entries)) return invalid('baseline-unavailable-or-invalid')
  if (!request.localBackup || request.localBackup.provenance !== 'trusted-local-backup' || !Array.isArray(request.localBackup.entries)) return invalid('local-backup-unavailable-or-invalid')
  const roots = await loadTrustedBackupRoots(deps)
  if (!roots) return invalid('source-root-unavailable-or-invalid')

  const baseline = request.baseline.entries, local = request.localBackup.entries
  const shouldRehash = request.rehashLocalFiles !== false
  const ids = new Set<string>(), names = new Set<string>(), localById = new Map<string, TrustedOriginalBinding>()
  let reservedBytes = 0
  for (const entry of baseline) {
    if (!validBinding(entry)) {
      add(reasons, !filename(entry?.filename) ? 'unsupported-original-filename' : 'invalid-source-size')
      continue
    }
    if (ids.has(entry.recordingId)) add(reasons, 'duplicate-recording-id'); else ids.add(entry.recordingId)
    const nameKey = key(entry.filename); if (names.has(nameKey)) add(reasons, 'duplicate-filename'); else names.add(nameKey)
    const allocation = conservativeRestoreAllocation(entry.byteLength)
    if (allocation == null || !Number.isSafeInteger(reservedBytes + allocation)) add(reasons, 'destination-capacity-exhausted')
    else reservedBytes += allocation
  }
  const localNames = new Set<string>()
  for (const entry of local) {
    if (!validBinding(entry)) { add(reasons, 'local-backup-unavailable-or-invalid'); continue }
    if (localById.has(entry.recordingId)) add(reasons, 'duplicate-recording-id'); else localById.set(entry.recordingId, entry)
    const nameKey = key(entry.filename); if (localNames.has(nameKey)) add(reasons, 'duplicate-filename'); else localNames.add(nameKey)
  }
  if (baseline.length > WHOLE_BACKUP_MAX_ENTRIES || local.length > WHOLE_BACKUP_MAX_ENTRIES) add(reasons, 'authority-capacity-exhausted')
  if (baseline.length !== local.length) add(reasons, 'inventory-mismatch')
  for (const entry of baseline) {
    if (!validBinding(entry)) continue
    if (!sameBinding(entry, localById.get(entry.recordingId) ?? {} as TrustedOriginalBinding)) add(reasons, 'inventory-mismatch')
  }
  for (const entry of local) if (!ids.has(entry.recordingId)) add(reasons, 'inventory-mismatch')

  let remainingAuthority: number | null = null, remainingStorage: number | null = null, existing: readonly string[] | null = null
  try {
    remainingAuthority = await deps.remainingAuthorityCapacity()
    if (!safeInteger(remainingAuthority) || remainingAuthority > WHOLE_BACKUP_MAX_ENTRIES) throw Error()
  } catch { add(reasons, 'authority-capacity-unavailable') }
  try { remainingStorage = await deps.remainingDestinationBytes(); if (!safeInteger(remainingStorage)) throw Error() } catch { add(reasons, 'destination-capacity-unavailable') }
  try { existing = await deps.listDestinationFilenames(); if (!Array.isArray(existing) || existing.some(name => typeof name !== 'string')) throw Error() }
  catch { existing = null; add(reasons, 'destination-capacity-unavailable') }
  if (remainingAuthority != null && remainingAuthority < baseline.length) add(reasons, 'authority-capacity-exhausted')
  if (remainingStorage != null && remainingStorage < reservedBytes) add(reasons, 'destination-capacity-exhausted')

  let checkedSourceCount = 0
  if (baseline.length <= WHOLE_BACKUP_MAX_ENTRIES && local.length <= WHOLE_BACKUP_MAX_ENTRIES) {
    for (const entry of baseline) {
      if (!validBinding(entry)) continue
      try {
        const receipt = await deps.getTrustedOriginalReceipt(entry.recordingId)
        if (!receipt || receipt.immutable !== true || !['independent-original-download', 'owned-upload'].includes(receipt.provenance) || !validBinding(receipt)) add(reasons, 'receipt-unavailable-or-invalid')
        else if (!sameBinding(entry, receipt)) add(reasons, 'receipt-binding-mismatch')
        else if (shouldRehash) {
          checkedSourceCount++
          const sourceStatus = await hashUnchangedFile(entry, roots)
          if (sourceStatus === 'outside-root') add(reasons, 'local-source-outside-trusted-root')
          else if (sourceStatus !== 'verified') add(reasons, 'local-source-unavailable-or-changed')
        } else {
          const sourceCheck = await inspectContainedSource(entry, roots)
          if (sourceCheck.status === 'outside-root') add(reasons, 'local-source-outside-trusted-root')
          else if (sourceCheck.status !== 'contained') add(reasons, 'local-source-unavailable-or-changed')
        }
      } catch { add(reasons, 'receipt-unavailable-or-invalid') }
    }
  }
  if (!shouldRehash) add(reasons, 'local-bytes-not-verified')

  const collisions = existing ? baseline.filter(entry => existing!.some(name => key(name) === key(entry.filename))).length : baseline.length
  const compatible = [...reasons].every(reason => reason === 'local-bytes-not-verified')
  return {
    compatibility: compatible ? 'compatible' : 'incompatible',
    executionReadiness: compatible && shouldRehash ? collisions === 0 ? 'ready-on-empty-destination' : 'blocked-destination-collision' : 'not-ready',
    incompatibilities: [...reasons], destinationCollisions: collisions,
    summary: { entryCount: baseline.length, reservedBytes, rehashPerformed: checkedSourceCount > 0, checkedSourceCount },
    compatibilityEntries: compatible && shouldRehash ? baseline.map(entry => ({ ...entry })) : []
  }
}
