import { constants, setPriority } from 'node:os'
import Database from 'better-sqlite3'
import { runSqliteBackupTask } from './services/sqlite-backup-worker-core.js'
import type { SqliteBackupRequest, SqliteBackupProgress } from './services/sqlite-backup-executor.js'

type MessagePortLike = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
}
type UtilityProcessLike = NodeJS.Process & {
  parentPort?: MessagePortLike
  send?: (message: unknown) => void
}

const workerProcess = process as UtilityProcessLike
const port = workerProcess.parentPort
try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* best effort on supported platforms */ }

function send(message: unknown): void {
  if (port) port.postMessage(message)
  else workerProcess.send?.(message)
}

async function handle(message: unknown): Promise<void> {
  if (typeof message !== 'object' || message === null) return
  const item = message as { type?: string; request?: SqliteBackupRequest }
  if (item.type === 'shutdown') {
    process.exit(0)
    return
  }
  if (item.type !== 'run' || !item.request) return
  try {
    await runSqliteBackupTask(item.request, Database, (progress: SqliteBackupProgress) => {
      send({ type: 'progress', ...progress })
    })
    send({ type: 'done' })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

if (port) {
  port.on('message', (event) => { void handle(event.data) })
} else {
  process.on('message', (message) => { void handle(message) })
}
