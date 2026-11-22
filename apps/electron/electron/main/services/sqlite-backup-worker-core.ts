import { promises as fsPromises, renameSync, rmSync, statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SqliteBackupProgress, SqliteBackupRequest } from './sqlite-backup-executor.js'

interface BackupStatement {
  get(...params: unknown[]): unknown
}

interface BackupDatabase {
  pragma(sql: string, options?: { simple?: boolean }): unknown
  prepare(sql: string): BackupStatement
  backup(
    destination: string,
    options: { progress: (progress: { totalPages: number; remainingPages: number }) => number }
  ): Promise<unknown>
  close(): void
}

export type BackupDatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => BackupDatabase

function schemaVersion(database: BackupDatabase): number {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get()
  if (!table) return 0
  const row = database
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as { version?: number | null } | undefined
  return Number(row?.version ?? 0)
}

/**
 * Owns the complete copy lifecycle inside the worker: read-only source open,
 * incremental backup, destination durability, standalone verification, and
 * same-directory atomic publication. A failed task removes only its partial.
 */
export async function runSqliteBackupTask(
  request: SqliteBackupRequest,
  Database: BackupDatabaseConstructor,
  reportProgress: (progress: SqliteBackupProgress) => void = () => undefined
): Promise<void> {
  let source: BackupDatabase | null = null
  let snapshot: BackupDatabase | null = null
  try {
    rmSync(request.partialPath, { force: true })
    source = new Database(request.sourcePath, { readonly: true, fileMustExist: true })
    source.pragma('busy_timeout = 5000')

    const pageSize = Number(source.pragma('page_size', { simple: true })) || 4096
    const pageCount = Number(source.pragma('page_count', { simple: true }))
    if (request.checkFreeSpace) {
      const needed = Math.max(statSync(request.sourcePath).size, pageCount * pageSize)
      const space = statfsSync(dirname(request.partialPath), { bigint: true })
      const available = space.bavail * space.bsize
      if (available < BigInt(needed)) {
        throw new Error('Insufficient free space for pre-migration backup: need ' + needed +
          ' bytes, available ' + available + ' bytes')
      }
    }

    await source.backup(request.partialPath, {
      progress: ({ totalPages, remainingPages }) => {
        reportProgress({
          copiedBytes: (totalPages - remainingPages) * pageSize,
          totalBytes: totalPages * pageSize,
        })
        return Math.max(1, Math.floor(request.pagesPerStep))
      },
    })
    source.close()
    source = null

    snapshot = new Database(request.partialPath, { fileMustExist: true })
    snapshot.pragma('journal_mode = DELETE')
    const integrity = snapshot.pragma('quick_check', { simple: true })
    if (integrity !== 'ok') throw new Error('Backup integrity verification failed: ' + request.partialPath)
    const actualVersion = schemaVersion(snapshot)
    if (request.expectedSchemaVersion !== undefined && actualVersion !== request.expectedSchemaVersion) {
      throw new Error('Backup schema mismatch: ' + request.partialPath + ' (v' + actualVersion +
        ', expected v' + request.expectedSchemaVersion + ')')
    }
    snapshot.close()
    snapshot = null

    const partialFile = await fsPromises.open(request.partialPath, 'r+')
    try {
      await partialFile.sync()
    } finally {
      await partialFile.close()
    }

    const total = statSync(request.partialPath).size
    reportProgress({ copiedBytes: total, totalBytes: total })
    renameSync(request.partialPath, request.targetPath)
  } catch (error) {
    try { source?.close() } catch {}
    try { snapshot?.close() } catch {}
    rmSync(request.partialPath, { force: true })
    throw error
  }
}
