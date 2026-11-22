import type { DatabaseBackupExecutor } from '@hidock/database'

/**
 * In-process replacement for the `sqlite-backup-host` module, for use as the
 * factory of an inline `vi.mock('../sqlite-backup-host', ...)` in a test:
 *
 *   vi.mock('../sqlite-backup-host', () => inProcessSqliteBackupHost())
 *
 * Why it is needed: the real host (sqlite-backup-host.ts) forks an Electron
 * utilityProcess and resolves its worker path from the startup `runtimeDir`,
 * which is only set during a real app boot. Under vitest `runtimeDir` is null,
 * so a backup request throws "SQLite backup worker requested before startup
 * initialization". Any test that boots a database at an older schema triggers
 * the mandatory pre-migration backup (engine `backupOnBoot` with `failClosed`),
 * so it hits that throw.
 *
 * This stand-in runs the worker's own copy routine (`runSqliteBackupTask`) in
 * process against a real better-sqlite3 handle, so a genuine, integrity- and
 * schema-verified backup is still written at the target path and the migration
 * path runs end to end — the engine's `verifyMigrationBackup` reads this copy.
 * The import is dynamic because this runs inside a hoisted `vi.mock` factory.
 */
export async function inProcessSqliteBackupHost(): Promise<{
  runDatabaseBackup: DatabaseBackupExecutor
  closeDatabaseBackupWorker: () => Promise<void>
  resolveSqliteBackupWorkerPath: () => string
}> {
  const [{ runSqliteBackupTask }, Database] = await Promise.all([
    import('../../sqlite-backup-worker-core'),
    import('better-sqlite3').then((m) => m.default),
  ])
  const runDatabaseBackup: DatabaseBackupExecutor = (request, options) =>
    runSqliteBackupTask(request, Database as never, options?.onProgress)
  return {
    runDatabaseBackup,
    closeDatabaseBackupWorker: () => Promise.resolve(),
    resolveSqliteBackupWorkerPath: () => 'sqlite-backup-worker.js',
  }
}
