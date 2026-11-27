/**
 * The database process as the app runs it: a utility process forked from the
 * bundled `database-process.js`, its backups copied by the backup utility
 * process, its errors rebuilt as the app's own classes.
 */
import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { getStartupState } from '../../startup-state'
import { runDatabaseBackup } from '../sqlite-backup-host'
import { adaptUtilityProcess } from '../sqlite-backup-host-adapter'
import { createDatabaseProcessHost, type DatabaseProcessHost, type DatabaseProcessHostDependencies } from './host'
import { DATABASE_ERROR_CLASSES } from './operations'
import type { DatabaseProcessMode } from './protocol'

/** Launch flags the process must see too: recovery and validation launches contain automatic work. */
const INHERITED_FLAGS = ['--recovery-mode', '--device-validation', '--firmware-read-only', '--firmware-qualification']

export function resolveDatabaseProcessPath(): string {
  const runtimeDir = getStartupState().runtimeDir
  if (!runtimeDir) throw new Error('Database process requested before startup initialization')
  return join(runtimeDir, 'database-process.js')
}

/**
 * Where the database runs (HIDOCK_DATABASE_PROCESS): `off` (in main, the
 * default), `passes` (the process owns the boot and the background passes),
 * `all` (the process owns every call). Anything else is `off`, said once.
 */
export function resolveDatabaseProcessMode(value = process.env.HIDOCK_DATABASE_PROCESS): DatabaseProcessMode {
  if (value === undefined || value === '' || value === 'off') return 'off'
  if (value === 'passes' || value === 'all') return value
  console.warn(`[DatabaseProcess] HIDOCK_DATABASE_PROCESS=${value} is not off, passes or all; running in main`)
  return 'off'
}

export function createElectronDatabaseProcessHost(
  options: Pick<DatabaseProcessHostDependencies, 'onBootProgress' | 'onEvent'> = {}
): DatabaseProcessHost {
  return createDatabaseProcessHost({
    ...options,
    fork: () => adaptUtilityProcess(utilityProcess.fork(
      resolveDatabaseProcessPath(),
      process.argv.filter((arg) => INHERITED_FLAGS.includes(arg)),
      { serviceName: 'HiDock Database' }
    )),
    backup: runDatabaseBackup,
    errorClasses: DATABASE_ERROR_CLASSES,
  })
}
