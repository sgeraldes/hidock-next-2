import { promises as fsPromises } from 'node:fs'

export interface SqliteBackupRequest {
  sourcePath: string
  partialPath: string
  targetPath: string
  pagesPerStep: number
  checkFreeSpace: boolean
  expectedSchemaVersion?: number
}

export interface SqliteBackupProgress { copiedBytes: number; totalBytes: number }
export interface SqliteBackupExecutorOptions {
  onProgress?: (progress: SqliteBackupProgress) => void
  signal?: AbortSignal
}
export type DatabaseBackupExecutor = (
  request: SqliteBackupRequest,
  options?: SqliteBackupExecutorOptions
) => Promise<void>
export interface BackupWorkerProcess {
  pid?: number
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener?(event: string, listener: (...args: any[]) => void): unknown
  postMessage(message: unknown): void
  kill(): void
}

export interface SqliteBackupExecutorDependencies {
  workerPath: () => string
  fork: (workerPath: string) => BackupWorkerProcess
  timeoutMs?: number
}

interface ActiveTask {
  controller: AbortController
  promise: Promise<void>
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** Parent-side process owner. It never opens SQLite or performs file sync work. */
export function createSqliteBackupExecutor(dependencies: SqliteBackupExecutorDependencies): {
  execute: DatabaseBackupExecutor
  close: () => Promise<void>
  activeCount: () => number
} {
  const active = new Set<ActiveTask>()
  const timeoutMs = dependencies.timeoutMs ?? 60 * 60 * 1000
  let closed = false

  const execute: DatabaseBackupExecutor = (request, options = {}) => {
    if (closed) return Promise.reject(new Error('SQLite backup executor is closed'))
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(abortError('SQLite backup cancelled'))
    if (options.signal?.aborted) controller.abort(abortError('SQLite backup cancelled'))
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    const task: ActiveTask = { controller, promise: Promise.resolve() }
    active.add(task)
    task.promise = runWorker(request, controller.signal, options.onProgress, dependencies, timeoutMs)
      .finally(() => {
        options.signal?.removeEventListener('abort', abortFromCaller)
        active.delete(task)
      })
    return task.promise
  }

  const close = async (): Promise<void> => {
    if (closed && active.size === 0) return
    closed = true
    const tasks = [...active]
    for (const task of tasks) task.controller.abort(abortError('SQLite backup executor closed'))
    await Promise.allSettled(tasks.map(task => task.promise))
  }

  return { execute, close, activeCount: () => active.size }
}

function runWorker(
  request: SqliteBackupRequest,
  signal: AbortSignal,
  onProgress: ((progress: { copiedBytes: number; totalBytes: number }) => void) | undefined,
  dependencies: SqliteBackupExecutorDependencies,
  timeoutMs: number
): Promise<void> {
  if (signal.aborted) {
    return fsPromises.rm(request.partialPath, { force: true }).then(() => {
      throw signal.reason ?? abortError('SQLite backup cancelled')
    })
  }

  let worker: BackupWorkerProcess
  try {
    worker = dependencies.fork(dependencies.workerPath())
  } catch (error) {
    return fsPromises.rm(request.partialPath, { force: true }).then(() => { throw error })
  }

  return new Promise<void>((resolve, reject) => {
    let result: { type: 'done' } | { type: 'error'; message: string } | null = null
    let stopReason: Error | null = null
    let started = false
    let exiting = false
    const timeout = setTimeout(() => {
      stop(abortError('SQLite backup worker timed out after ' + timeoutMs + ' ms'))
    }, timeoutMs)
    timeout.unref?.()

    const clear = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }

    const stop = (error: Error) => {
      if (stopReason || exiting || result?.type === 'done') return
      stopReason = error
      clearTimeout(timeout)
      try { worker.kill() } catch {}
    }

    const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : abortError('SQLite backup cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })

    const sendRequest = () => {
      if (started || stopReason || exiting) return
      started = true
      try { worker.postMessage({ type: 'run', request }) } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const onMessage = (value: unknown) => {
      if (typeof value !== 'object' || value === null) return
      const message = value as { type?: string; copiedBytes?: number; totalBytes?: number; message?: string }
      if (message.type === 'progress') {
        try {
          onProgress?.({ copiedBytes: Number(message.copiedBytes) || 0, totalBytes: Number(message.totalBytes) || 0 })
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
      if (message.type !== 'done' && message.type !== 'error') return
      if (result || stopReason) return
      result = message.type === 'done'
        ? { type: 'done' }
        : { type: 'error', message: message.message || 'SQLite backup worker failed' }
      clearTimeout(timeout)
      try { worker.postMessage({ type: 'shutdown' }) } catch { try { worker.kill() } catch {} }
    }

    const onError = (error: Error) => stop(error)
    const onExit = (code: number | null) => {
      if (exiting) return
      exiting = true
      clear()
      const failure = stopReason
        ?? (result?.type === 'error' ? new Error(result.message)
          : result?.type !== 'done'
            ? new Error('SQLite backup worker exited before successful publication (code ' + code + ')')
            : null)
      if (!failure) {
        resolve()
        return
      }
      void fsPromises.rm(request.partialPath, { force: true }).then(
        () => reject(failure),
        cleanupError => reject(new Error(failure.message + '; partial cleanup failed: ' + String(cleanupError)))
      )
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.once('exit', onExit)
    if (worker.pid) sendRequest()
    else worker.once('spawn', sendRequest)
    if (signal.aborted) onAbort()
  })
}
