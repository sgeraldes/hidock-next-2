/**
 * Entry of the database process (docs/superpowers/plans/2026-11-27-database-utility-process.md).
 *
 * Forked by main with utilityProcess.fork. It holds the better-sqlite3
 * connection to the library, so a checkpoint's file sync waits here and never
 * on the window's thread. In tests the same file runs as a Node child process
 * with 'advanced' IPC serialization.
 */
import { applyConfigSnapshot, type AppConfig } from './services/config'
import { closeDatabase, initializeDatabase, queryOne, setDatabaseBackupExecutor } from './services/database'
import { databaseOperations } from './services/database-process/operations'
import type { MainToProcess, ProcessToMain } from './services/database-process/protocol'
import { createDatabaseServer } from './services/database-process/server'
import { getEventBus } from './services/event-bus'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
}
const child = process as NodeJS.Process & { parentPort?: ParentPort }
const port = child.parentPort

function send(message: ProcessToMain): void {
  if (port) port.postMessage(message)
  else child.send?.(message)
}

const server = createDatabaseServer({
  send,
  operations: databaseOperations as unknown as () => Record<string, (...args: any[]) => unknown>,
  applyConfig: (config) => applyConfigSnapshot(config as AppConfig),
  open: async (init, hooks) => {
    setDatabaseBackupExecutor(hooks.backup)
    getEventBus().setForwarder((event) => send({ type: 'event', event }))
    await initializeDatabase({
      onProgress: hooks.onProgress,
      appVersion: init.appVersion,
      existingSchemaOnly: init.boot === 'existing-schema-only',
    })
    return Number(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0)
  },
  close: closeDatabase,
  exit: (code) => process.exit(code),
})

process.on('uncaughtException', (error) => {
  // Main sees the exit, rejects what was in flight and starts a new process.
  // Every committed transaction is in the WAL; nothing committed is lost.
  console.error('[DatabaseProcess] uncaught exception; exiting:', error)
  process.exit(1)
})

if (port) port.on('message', (event) => server.handle(event.data as MainToProcess))
else process.on('message', (message) => server.handle(message as MainToProcess))
