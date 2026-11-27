/**
 * The database process's side of the protocol. It owns the connection: it
 * opens the library on `init`, answers `call`s one message at a time, and
 * checkpoints with TRUNCATE and exits on `close`.
 *
 * Synchronous operations run to completion as each message arrives, so a
 * transaction never interleaves with another request. An async operation (a
 * background pass) yields between its committed units, and requests that
 * arrive meanwhile are answered in those gaps.
 */
import type { BootProgress, DatabaseBackupExecutor } from '@hidock/database'
import type { DatabaseProcessInit, MainToProcess, ProcessToMain, SerializedError } from './protocol'
import { deserializeError, serializeError } from './protocol'

export interface DatabaseServerDependencies {
  send: (message: ProcessToMain) => void
  operations: () => Record<string, (...args: any[]) => unknown>
  /** Open the library (initializeDatabase); returns the schema version it is on. */
  open: (init: DatabaseProcessInit, hooks: { onProgress: (progress: BootProgress) => void; backup: DatabaseBackupExecutor }) => Promise<number>
  applyConfig: (config: unknown) => void
  /** closeDatabase(): TRUNCATE checkpoint, then the handle closes. */
  close: () => void
  exit: (code: number) => void
  /** How long `close` waits for running operations before it closes under them. */
  closeGraceMs?: number
}

export interface DatabaseServer {
  handle(message: MainToProcess): void
  /** Requests still running (async operations). */
  pending(): number
}

export function createDatabaseServer(deps: DatabaseServerDependencies): DatabaseServer {
  let state: 'new' | 'opening' | 'ready' | 'failed' | 'closing' = 'new'
  let running = 0
  let nextBackupId = 1
  const backups = new Map<number, { resolve: () => void; reject: (error: Error) => void; onProgress?: (p: { copiedBytes: number; totalBytes: number }) => void }>()

  const reply = (id: number, ok: true, value: unknown) => deps.send({ type: 'result', id, ok, value })
  const fail = (id: number, error: SerializedError) => deps.send({ type: 'result', id, ok: false, error })

  /** The engine's backup executor in this process: main runs the copy in the backup utility process. */
  const backup: DatabaseBackupExecutor = (request, options = {}) => new Promise<void>((resolve, reject) => {
    const id = nextBackupId++
    backups.set(id, { resolve, reject, onProgress: options.onProgress })
    deps.send({ type: 'backup-request', id, request })
  })

  let closed = false
  const finishClose = () => {
    if (closed) return
    closed = true
    try {
      deps.close()
    } catch (error) {
      // No 'closed' and a nonzero exit: main logs that the checkpoint did not
      // finish. The WAL is recovered on the next open; nothing committed is lost.
      console.error('[DatabaseProcess] close failed:', error)
      deps.exit(1)
      return
    }
    deps.send({ type: 'closed' })
    deps.exit(0)
  }

  const call = (id: number, op: string, args: unknown[]) => {
    if (state !== 'ready') {
      fail(id, { name: 'DatabaseProcessNotReadyError', message: `The database process is ${state}; ${op} was not run` })
      return
    }
    const operations = deps.operations()
    const fn = Object.prototype.hasOwnProperty.call(operations, op) ? operations[op] : undefined
    if (typeof fn !== 'function') {
      fail(id, { name: 'UnknownDatabaseOperationError', message: `No database operation named ${op}` })
      return
    }
    let result: unknown
    try {
      result = fn(...(Array.isArray(args) ? args : []))
    } catch (error) {
      fail(id, serializeError(error))
      return
    }
    if (!(result instanceof Promise)) {
      send(id, result)
      return
    }
    running++
    result.then(
      (value) => send(id, value),
      (error) => fail(id, serializeError(error))
    ).finally(() => {
      running--
      if (state === 'closing' && running === 0) finishClose()
    })
  }

  const send = (id: number, value: unknown) => {
    try {
      reply(id, true, value)
    } catch (error) {
      // A result that cannot be cloned (a function, a native handle) is a defect of the operation.
      fail(id, { name: 'DatabaseResultNotCloneableError', message: `The result could not be sent to main: ${(error as Error).message}` })
    }
  }

  return {
    pending: () => running,
    handle(message) {
      switch (message.type) {
        case 'init': {
          if (state !== 'new') return
          state = 'opening'
          try {
            deps.applyConfig(message.init.config)
          } catch (error) {
            state = 'failed'
            deps.send({ type: 'init-failed', error: serializeError(error) })
            return
          }
          deps.open(message.init, { onProgress: (progress) => deps.send({ type: 'boot-progress', progress }), backup }).then(
            (schemaVersion) => {
              // A close that came during the boot waited for it: close now, never report ready.
              if (state === 'closing') return finishClose()
              state = 'ready'
              deps.send({ type: 'ready', schemaVersion })
            },
            (error) => {
              if (state === 'closing') return finishClose()
              state = 'failed'
              deps.send({ type: 'init-failed', error: serializeError(error) })
            }
          )
          return
        }
        case 'call':
          call(message.id, message.op, message.args)
          return
        case 'config':
          try {
            deps.applyConfig(message.config)
          } catch (error) {
            console.error('[DatabaseProcess] config update failed:', error)
          }
          return
        case 'backup-progress':
          backups.get(message.id)?.onProgress?.(message.progress)
          return
        case 'backup-result': {
          const pending = backups.get(message.id)
          if (!pending) return
          backups.delete(message.id)
          if (message.ok) pending.resolve()
          else pending.reject(deserializeError(message.error))
          return
        }
        case 'close': {
          if (state === 'closing') return
          const wasOpening = state === 'opening'
          state = 'closing'
          // The boot is a migration and a snapshot: closing the connection under
          // it would fail it halfway. It finishes, then the open's handler closes.
          if (wasOpening) return
          // Nothing new starts. A running pass gets a moment to finish its
          // unit; after that the connection closes under it, its next call
          // fails, and every unit it committed stays committed.
          if (running === 0) finishClose()
          else setTimeout(finishClose, deps.closeGraceMs ?? 3000)
          return
        }
      }
    },
  }
}
