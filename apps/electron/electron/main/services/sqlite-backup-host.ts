import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { DatabaseBackupExecutor } from '@hidock/database'
import { getStartupState } from '../startup-state'
import { createSqliteBackupExecutor } from './sqlite-backup-executor'
import { adaptUtilityProcess } from './sqlite-backup-host-adapter'

export function resolveSqliteBackupWorkerPath(): string {
  const runtimeDir = getStartupState().runtimeDir
  if (!runtimeDir) throw new Error('SQLite backup worker requested before startup initialization')
  return join(runtimeDir, 'sqlite-backup-worker.js')
}

const manager = createSqliteBackupExecutor({
  workerPath: resolveSqliteBackupWorkerPath,
  fork: (path) => adaptUtilityProcess(utilityProcess.fork(path, [], { serviceName: 'HiDock SQLite backup' })),
  timeoutMs: 60 * 60 * 1000,
})

export const runDatabaseBackup: DatabaseBackupExecutor = manager.execute
export const closeDatabaseBackupWorker = manager.close
