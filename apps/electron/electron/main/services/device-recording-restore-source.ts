import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isRecordingRestoreFilename } from '@hidock/jensen-protocol'
import type { Recording } from './database'
import type { OriginalBackupReceipt } from './original-recording-backups'

export type DeviceRecordingRestoreLibraryRow = Pick<Recording, 'id' | 'filename' | 'original_filename' | 'file_path' | 'on_local' | 'location' | 'deleted_at'>
export interface DeviceRecordingRestoreSourceDependencies {
  getRecordingById(id: string): DeviceRecordingRestoreLibraryRow | null | undefined | Promise<DeviceRecordingRestoreLibraryRow | null | undefined>
  getRecordingsPath(): string
  /**
   * Latest stored original-backup receipt for the recording. Absent, or returning
   * nothing, means the recording is unreceipted and is never restorable: there is no
   * fallback to original_filename, to the local basename or to a freshly computed hash.
   */
  getOriginalBackup?(recordingId: string): OriginalBackupReceipt | null | undefined | Promise<OriginalBackupReceipt | null | undefined>
}
/** The source a restore may use: the receipt's captured name and host-computed digest, bound to the file on disk. */
export interface TrustedRecordingRestoreSource { path: string; filename: string; sha256: string; totalBytes: number }

const SHA256 = /^[a-f0-9]{64}$/
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const inside = (root: string, file: string): boolean => {
  const rel = relative(key(root), key(file))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Main-only resolver: ID -> the exact original filename and bytes the host received,
 * bound to a contained regular downloaded file. Never accepts a renderer path or
 * storage basename. The file is not rehashed here; the restore service compares the
 * digest it computes at BEGIN with the receipt's, and pins its own proofs after that. */
export function createDeviceRecordingRestoreSourceResolver(deps: DeviceRecordingRestoreSourceDependencies):
  (id: string) => Promise<TrustedRecordingRestoreSource | null> {
  return async id => {
    if (typeof id !== 'string' || !id || id.length > 256) return null
    try {
      const row = await deps.getRecordingById(id)
      if (!row || row.id !== id || row.deleted_at || row.on_local !== 1 || !['local-only', 'both'].includes(row.location) ||
        typeof row.file_path !== 'string' || row.file_path.length > 4096 || !isAbsolute(row.file_path)) return null
      const receipt = await deps.getOriginalBackup?.(id)
      if (!receipt || receipt.recordingId !== id || typeof receipt.sha256 !== 'string' || !SHA256.test(receipt.sha256) ||
        !Number.isSafeInteger(receipt.totalBytes) || receipt.totalBytes < 0 || typeof receipt.canonicalPath !== 'string') return null
      // The receipt holds the name captured when the host received the bytes. A
      // populated original_filename that now says something else is a changed name.
      const filename = receipt.originalFilename
      if (!isRecordingRestoreFilename(filename)) return null
      if (row.original_filename != null && row.original_filename !== '' && row.original_filename !== filename) return null
      const configured = deps.getRecordingsPath()
      if (typeof configured !== 'string' || configured.length > 4096 || !isAbsolute(configured)) return null
      const root = resolve(configured), candidate = resolve(row.file_path)
      if (!inside(root, candidate)) return null
      const rootStat = await lstat(root), fileStat = await lstat(candidate)
      if (!rootStat.isDirectory() || !fileStat.isFile() || fileStat.isSymbolicLink()) return null
      const canonicalRoot = await realpath(root), canonicalFile = await realpath(candidate)
      if (!inside(canonicalRoot, canonicalFile)) return null
      const canonicalStat = await lstat(canonicalFile)
      if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink() || canonicalStat.dev !== fileStat.dev || canonicalStat.ino !== fileStat.ino) return null
      // Path and length must still be the ones the receipt captured.
      if (key(canonicalFile) !== key(receipt.canonicalPath) || canonicalStat.size !== receipt.totalBytes) return null
      // Recheck configuration and resolution after asynchronous filesystem reads.
      if (key(deps.getRecordingsPath()) !== key(configured) || key(await realpath(root)) !== key(canonicalRoot) ||
        key(await realpath(candidate)) !== key(canonicalFile)) return null
      return { path: canonicalFile, filename, sha256: receipt.sha256, totalBytes: receipt.totalBytes }
    } catch { return null } // No raw paths, filenames or filesystem details leave this resolver.
  }
}

export function getTrustedRecordingRestoreSource(id: string, deps: DeviceRecordingRestoreSourceDependencies): Promise<TrustedRecordingRestoreSource | null> {
  return createDeviceRecordingRestoreSourceResolver(deps)(id)
}
