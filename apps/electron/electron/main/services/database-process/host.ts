/**
 * Main's owner of the database process: forks it, opens the library through
 * it, sends requests and matches answers, restarts it after a crash, and
 * closes it with a TRUNCATE checkpoint on quit. Main never opens SQLite here.
 */
import type { BootProgress } from '@hidock/database'
import type { BackupWorkerProcess, DatabaseBackupExecutor } from '../sqlite-backup-executor'
import type { DatabaseProcessInit, MainToProcess, ProcessToMain, SerializedError } from './protocol'
import { deserializeError, serializeError } from './protocol'

/** A request that was in flight when the process exited: whether a write committed is unknown, so re-read. */
export class DatabaseProcessExitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseProcessExitedError'
  }
}

export interface DatabaseProcessHostDependencies {
  fork: () => BackupWorkerProcess
  /** Runs the copy the process asks for (the backup utility process). */
  backup: DatabaseBackupExecutor
  errorClasses?: Record<string, abstract new (...args: any[]) => Error>
  onBootProgress?: (progress: BootProgress) => void
  onEvent?: (event: unknown) => void
  /** Delays before each restart after a crash. */
  restartDelaysMs?: number[]
  /** More exits than this within restartWindowMs and the host gives up. */
  maxRestarts?: number
  restartWindowMs?: number
  /** How long close waits for the process to checkpoint and exit before killing it. */
  closeTimeoutMs?: number
}

interface Pending {
  op: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type State = 'idle' | 'starting' | 'ready' | 'restarting' | 'closing' | 'closed' | 'failed'

export interface DatabaseProcessHost {
  start(init: DatabaseProcessInit): Promise<number>
  call(op: string, args: unknown[]): Promise<unknown>
  sendConfig(config: unknown): void
  close(): Promise<void>
  state(): State
  pid(): number | undefined
  inFlight(): number
}

export function createDatabaseProcessHost(deps: DatabaseProcessHostDependencies): DatabaseProcessHost {
  const restartDelays = deps.restartDelaysMs ?? [1000, 2000, 5000]
  const maxRestarts = deps.maxRestarts ?? 5
  const restartWindowMs = deps.restartWindowMs ?? 60_000
  const closeTimeoutMs = deps.closeTimeoutMs ?? 15_000

  let state: State = 'idle'
  let child: BackupWorkerProcess | null = null
  let init: DatabaseProcessInit | null = null
  let nextId = 1
  let failure: Error | null = null
  const pending = new Map<number, Pending>()
  /** Requests made while the process starts or restarts: sent once it is ready. */
  const queued: Array<{ id: number; op: string; args: unknown[] }> = []
  const exits: number[] = []
  let readyWaiter: { resolve: (v: number) => void; reject: (e: Error) => void } | null = null
  /** After the first boot a restart opens the exact schema only: the migration already ran. */
  let booted = false
  /** A config saved while the process was booting: sent once it is ready. */
  let configPending = false
  let closeWaiter: (() => void) | null = null
  const backupControllers = new Map<number, AbortController>()

  const post = (message: MainToProcess) => {
    if (!child) throw new Error('The database process is not running')
    child.postMessage(message)
  }

  const rebuild = (error: SerializedError) => deserializeError(error, deps.errorClasses)

  const flushQueue = () => {
    while (queued.length > 0 && state === 'ready') {
      const item = queued.shift()!
      try {
        post({ type: 'call', id: item.id, op: item.op, args: item.args })
      } catch (error) {
        const p = pending.get(item.id)
        pending.delete(item.id)
        p?.reject(error as Error)
      }
    }
  }

  const rejectAll = (error: Error, includeQueued: boolean) => {
    const ids = [...pending.keys()].filter((id) => includeQueued || !queued.some((q) => q.id === id))
    for (const id of ids) {
      const p = pending.get(id)!
      pending.delete(id)
      p.reject(error)
    }
    if (includeQueued) queued.length = 0
  }

  const onMessage = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    const message = value as ProcessToMain
    switch (message.type) {
      case 'ready':
        if (state === 'closing' || state === 'closed') {
          readyWaiter?.reject(new DatabaseProcessExitedError('The database process was closed while it started'))
          readyWaiter = null
          return
        }
        booted = true
        state = 'ready'
        if (configPending && init) {
          configPending = false
          try { post({ type: 'config', config: init.config }) } catch (error) {
            console.warn('[DatabaseProcess] could not send the config:', error)
          }
        }
        readyWaiter?.resolve(message.schemaVersion)
        readyWaiter = null
        flushQueue()
        return
      case 'init-failed': {
        const error = rebuild(message.error)
        if (state === 'closing' || state === 'closed') {
          // The exit that follows resolves close().
          readyWaiter?.reject(error)
          readyWaiter = null
          rejectAll(error, true)
          return
        }
        failure = error
        state = 'failed'
        readyWaiter?.reject(error)
        readyWaiter = null
        rejectAll(error, true)
        try { child?.kill() } catch { /* already gone */ }
        return
      }
      case 'boot-progress':
        deps.onBootProgress?.(message.progress)
        return
      case 'result': {
        const p = pending.get(message.id)
        if (!p) return
        pending.delete(message.id)
        if (message.ok) p.resolve(message.value)
        else p.reject(rebuild(message.error))
        return
      }
      case 'event':
        try {
          deps.onEvent?.(message.event)
        } catch (error) {
          console.warn('[DatabaseProcess] event listener failed:', error)
        }
        return
      case 'backup-request': {
        const controller = new AbortController()
        backupControllers.set(message.id, controller)
        deps.backup(message.request, {
          signal: controller.signal,
          onProgress: (progress) => {
            try { post({ type: 'backup-progress', id: message.id, progress }) } catch { /* process gone */ }
          },
        }).then(
          () => { try { post({ type: 'backup-result', id: message.id, ok: true }) } catch { /* process gone */ } },
          (error: Error) => {
            try {
              post({ type: 'backup-result', id: message.id, ok: false, error: serializeError(error) })
            } catch { /* process gone */ }
          }
        ).finally(() => backupControllers.delete(message.id))
        return
      }
      case 'closed':
        return
    }
  }

  const spawn = () => {
    const current = deps.fork()
    child = current
    current.on('message', onMessage)
    current.on('error', (error: Error) => console.error('[DatabaseProcess] process error:', error))
    current.once('exit', (code: number | null) => onExit(current, code))
    const sendInit = () => {
      const message: DatabaseProcessInit = booted ? { ...init!, boot: 'existing-schema-only' } : init!
      try { current.postMessage({ type: 'init', init: message }) } catch (error) {
        console.error('[DatabaseProcess] could not send init:', error)
      }
    }
    if (current.pid) sendInit()
    else current.once('spawn', sendInit)
  }

  const onExit = (exited: BackupWorkerProcess, code: number | null) => {
    if (child !== exited) return
    child = null
    for (const controller of backupControllers.values()) controller.abort()
    backupControllers.clear()
    if (state === 'closing' || state === 'closed') {
      state = 'closed'
      rejectAll(new DatabaseProcessExitedError('The database process closed'), true)
      closeWaiter?.()
      closeWaiter = null
      return
    }
    if (state === 'failed') return
    const error = new DatabaseProcessExitedError(`The database process exited (code ${code}); the request's outcome is unknown`)
    rejectAll(error, false)
    const now = Date.now()
    exits.push(now)
    while (exits.length > 0 && now - exits[0] > restartWindowMs) exits.shift()
    if (exits.length > maxRestarts) {
      failure = new Error(`The database process exited ${exits.length} times within ${restartWindowMs / 1000} s; not restarting`)
      state = 'failed'
      readyWaiter?.reject(failure)
      readyWaiter = null
      rejectAll(failure, true)
      console.error('[DatabaseProcess]', failure.message)
      return
    }
    state = 'restarting'
    const delay = restartDelays[Math.min(exits.length - 1, restartDelays.length - 1)] ?? 1000
    console.warn(`[DatabaseProcess] exited (code ${code}); restarting in ${delay} ms`)
    const timer = setTimeout(() => {
      if (state !== 'restarting') return
      try {
        spawn()
      } catch (spawnError) {
        failure = spawnError as Error
        state = 'failed'
        rejectAll(failure, true)
      }
    }, delay)
    timer.unref?.()
  }

  return {
    state: () => state,
    pid: () => child?.pid,
    inFlight: () => pending.size,
    start(initMessage) {
      if (state !== 'idle') return Promise.reject(new Error(`The database process was already started (${state})`))
      init = initMessage
      state = 'starting'
      return new Promise<number>((resolve, reject) => {
        readyWaiter = { resolve, reject }
        try {
          spawn()
        } catch (error) {
          state = 'failed'
          failure = error as Error
          readyWaiter = null
          reject(error)
        }
      })
    },
    call(op, args) {
      if (state === 'failed') return Promise.reject(failure ?? new Error('The database process failed'))
      if (state === 'closing' || state === 'closed') return Promise.reject(new DatabaseProcessExitedError('The database process is closed'))
      if (state === 'idle') return Promise.reject(new Error(`The database process is not started; ${op} was not run`))
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { op, resolve, reject })
        if (state !== 'ready') {
          queued.push({ id, op, args })
          return
        }
        try {
          post({ type: 'call', id, op, args })
        } catch (error) {
          pending.delete(id)
          reject(error as Error)
        }
      })
    },
    sendConfig(config) {
      // A restart opens with the config main has now, not the one it started with.
      if (init) init = { ...init, config }
      if (!child || state !== 'ready') {
        // The init already sent may predate this save; the process gets it when ready.
        if (child) configPending = true
        return
      }
      try { post({ type: 'config', config }) } catch (error) {
        console.warn('[DatabaseProcess] could not send the config:', error)
      }
    },
    close() {
      if (state === 'closed' || state === 'idle') {
        state = 'closed'
        return Promise.resolve()
      }
      if (state === 'closing') return new Promise<void>((resolve) => {
        const previous = closeWaiter
        closeWaiter = () => { previous?.(); resolve() }
      })
      const running = child
      state = 'closing'
      readyWaiter?.reject(new DatabaseProcessExitedError('The database process was closed while it started'))
      readyWaiter = null
      if (!running) {
        state = 'closed'
        rejectAll(new DatabaseProcessExitedError('The database process is closed'), true)
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`[DatabaseProcess] did not exit within ${closeTimeoutMs} ms; killing it (the WAL is recovered on the next open)`)
          try { running.kill() } catch { /* already gone */ }
        }, closeTimeoutMs)
        closeWaiter = () => { clearTimeout(timer); resolve() }
        try { running.postMessage({ type: 'close' }) } catch { try { running.kill() } catch { /* gone */ } }
      })
    },
  }
}
