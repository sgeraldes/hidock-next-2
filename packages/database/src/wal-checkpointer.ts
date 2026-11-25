/**
 * WAL checkpoints on a worker thread.
 *
 * A checkpoint copies the WAL into the main database file and syncs that file.
 * On the owner's PC one checkpoint took 46 to 720 ms, and with SQLite's
 * automatic checkpoint it ran inside whichever COMMIT crossed 1000 pages, on
 * Electron's main thread, so the window froze for that long (measured while
 * finishing PR #175).
 *
 * Here a worker thread owns a second connection to the same file and runs
 * PASSIVE checkpoints every 100 ms while writes arrive. PASSIVE never takes
 * the writer lock and never waits for readers, so the app connection keeps
 * reading and writing while the worker copies and syncs. When commits pause
 * longer than a checkpoint takes, the worker has copied everything and the
 * next commit starts the WAL over: the app connection never checkpoints.
 *
 * The app connection keeps its automatic checkpoint as the backstop
 * (config.walBackstopPages, SQLite's 1000 pages by default). Under commits
 * that never pause, the worker's copy always ends a few commits behind, the
 * WAL cannot start over, and only the backstop bounds it; when it fires, the
 * worker has already copied and synced nearly all of the WAL. Two ways to
 * avoid the backstop were tried on 25-nov and dropped. A RESTART step on the
 * worker holds the writer lock across a file sync (a commit waited 935 ms on
 * the Samsung 980 disk). Making yielding passes wait for the worker did not
 * reliably start the WAL over and left the worst hold unchanged.
 *
 * Control runs through a SharedArrayBuffer, not messages: the worker loop is
 * synchronous (Atomics.wait between polls), and the app can stop it and wait
 * for its connection to close from a synchronous close path.
 *
 * This file must stay erasable TypeScript (no enums, namespaces or parameter
 * properties) with only Node built-in imports: the package tests load it in a
 * worker thread straight from source.
 */

import { statSync } from 'node:fs'
import { Worker, parentPort, workerData } from 'node:worker_threads'

/** Slots of the shared control array. */
const STOP = 0
const SEQUENCE = 1
const STATE = 2
const STATE_RUNNING = 1
const STATE_STOPPED = 2

/** When the worker checkpoints. Every field is optional; defaults below. */
export interface WalCheckpointTuning {
  /** How often the worker looks at the database, in ms. */
  pollMs?: number
  /** Checkpoint at most this often while writes keep arriving, in ms. */
  intervalMs?: number
  /** Checkpoint at the next poll, inside the interval, when the WAL file grew by this many bytes. */
  growthBytes?: number
  /** Report a pinned WAL when the file is at least this large and a reader keeps a checkpoint from finishing. */
  pinnedWarnBytes?: number
  /** Give up after this many checkpoints in a row throw; the engine then checkpoints on the app connection again. */
  maxConsecutiveErrors?: number
}

// Small and often: the more a checkpoint has to copy and sync, the longer the
// app's commits can wait on the disk meanwhile, and the more the backstop finds
// left. In the 25-nov benchmark (1 MB commits 20 ms apart, C: drive) the worst
// commit was 139 ms with a 1 s interval and 87 ms with 100 ms.
export const DEFAULT_WAL_CHECKPOINT_TUNING: Required<WalCheckpointTuning> = {
  pollMs: 50,
  intervalMs: 100,
  growthBytes: 4 * 1024 * 1024,
  pinnedWarnBytes: 256 * 1024 * 1024,
  maxConsecutiveErrors: 3,
}

/** One finished checkpoint, as the worker reports it. */
export interface WalCheckpointResult {
  /** Why it ran: the app asked, the WAL grew, the interval passed with new writes, or the last one was cut short by a reader. */
  reason: 'requested' | 'growth' | 'interval' | 'incomplete'
  durationMs: number
  /** Another connection was checkpointing; log and checkpointed are -1 then. */
  busy: boolean
  /** Frames in the WAL and frames copied into the database (PRAGMA wal_checkpoint). */
  log: number
  checkpointed: number
  walBytes: number
}

/** One row of PRAGMA wal_checkpoint. */
interface CheckpointRow {
  busy: number
  log: number
  checkpointed: number
}

/** Messages the worker posts to the thread that started it. */
export type WalCheckpointWorkerMessage =
  | { type: 'ready' }
  | { type: 'checkpoint'; result: WalCheckpointResult }
  | { type: 'pinned'; walBytes: number; log: number; checkpointed: number }
  | { type: 'error'; message: string; fatal: boolean }

/** What the engine hears from a checkpointer. */
export interface WalCheckpointerEvents {
  /** The worker's connection is open; the app connection may stop checkpointing. */
  onReady(): void
  /** The worker stopped on its own or never started; the app connection must checkpoint again. */
  onFailure(error: Error): void
  /** Each finished checkpoint (diagnostics and tests). */
  onCheckpoint?(result: WalCheckpointResult): void
}

/** A running checkpointer, as the engine drives it. */
export interface WalCheckpointer {
  /** Ask for a checkpoint at the worker's next wake-up. Never blocks. */
  request(): void
  /**
   * Stop the worker and wait, at most `timeoutMs`, until its connection is
   * closed. Synchronous so a synchronous close path can call it; it only ever
   * waits at shutdown. Returns false when the worker did not confirm in time.
   */
  stop(timeoutMs?: number): boolean
}

/**
 * Built by the host for one database file. Returns null when no worker can run
 * here (the engine keeps SQLite's automatic checkpoint then).
 */
export type WalCheckpointerFactory = (dbPath: string, events: WalCheckpointerEvents) => WalCheckpointer | null

/** Data handed to the worker thread. */
interface WalCheckpointWorkerData {
  dbPath: string
  control: SharedArrayBuffer
  tuning: Required<WalCheckpointTuning>
}

export interface WorkerThreadWalCheckpointerOptions {
  /** The worker entry file; it must call {@link runWalCheckpointWorker}. */
  workerPath: string | URL
  dbPath: string
  events: WalCheckpointerEvents
  tuning?: WalCheckpointTuning
  /** Where warnings go (a pinned WAL, a checkpoint that threw). Defaults to console.warn. */
  warn?: (message: string) => void
}

/**
 * Start a checkpoint worker thread for `dbPath`. The thread is unref'd, so it
 * never keeps a process alive on its own.
 */
export function createWorkerThreadWalCheckpointer(options: WorkerThreadWalCheckpointerOptions): WalCheckpointer {
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4)
  const slots = new Int32Array(control)
  const tuning: Required<WalCheckpointTuning> = { ...DEFAULT_WAL_CHECKPOINT_TUNING, ...(options.tuning ?? {}) }
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const data: WalCheckpointWorkerData = { dbPath: options.dbPath, control, tuning }
  const worker = new Worker(options.workerPath, { workerData: data })
  worker.unref()

  let stopping = false
  let finished = false
  const fail = (error: Error): void => {
    if (finished) return
    finished = true
    if (!stopping) options.events.onFailure(error)
  }

  worker.on('message', (message: WalCheckpointWorkerMessage) => {
    if (finished) return
    if (message.type === 'ready') options.events.onReady()
    else if (message.type === 'checkpoint') options.events.onCheckpoint?.(message.result)
    else if (message.type === 'pinned') {
      warn(
        `[Database] WAL checkpoint cannot finish: a reader holds the WAL (${(message.walBytes / 1048576).toFixed(0)} MB, ` +
          `${message.checkpointed} of ${message.log} frames copied). It finishes once that reader ends.`
      )
    } else if (message.type === 'error') {
      warn(`[Database] WAL checkpoint worker: ${message.message}`)
      if (message.fatal) fail(new Error(message.message))
    }
  })
  worker.on('error', (error: Error) => fail(error))
  worker.on('exit', (code: number) => fail(new Error(`WAL checkpoint worker exited with code ${code}`)))

  return {
    request(): void {
      Atomics.add(slots, SEQUENCE, 1)
      Atomics.notify(slots, SEQUENCE)
    },
    stop(timeoutMs = 5000): boolean {
      stopping = true
      Atomics.store(slots, STOP, 1)
      Atomics.add(slots, SEQUENCE, 1)
      Atomics.notify(slots, SEQUENCE)
      let confirmed = finished || Atomics.load(slots, STATE) === STATE_STOPPED
      const deadline = Date.now() + timeoutMs
      while (!confirmed) {
        const left = deadline - Date.now()
        if (left <= 0) break
        const state = Atomics.load(slots, STATE)
        if (state === STATE_STOPPED) {
          confirmed = true
          break
        }
        Atomics.wait(slots, STATE, state, left)
        confirmed = Atomics.load(slots, STATE) === STATE_STOPPED
      }
      finished = true
      void worker.terminate()
      return confirmed
    },
  }
}

/** The subset of a better-sqlite3 connection the worker uses. */
interface CheckpointConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown
  close(): void
}

type CheckpointConnectionConstructor = new (
  filename: string,
  options?: { fileMustExist?: boolean }
) => CheckpointConnection

function walSize(dbPath: string): number {
  try {
    return statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

/**
 * The worker thread's body. The entry file imports better-sqlite3 and calls
 * this; it returns when the app asks it to stop or after repeated errors.
 */
export function runWalCheckpointWorker(Database: CheckpointConnectionConstructor): void {
  const port = parentPort
  if (!port) throw new Error('runWalCheckpointWorker must run in a worker thread')
  const { dbPath, control, tuning } = workerData as WalCheckpointWorkerData
  const slots = new Int32Array(control)
  const post = (message: WalCheckpointWorkerMessage): void => port.postMessage(message)

  let db: CheckpointConnection | null = null
  try {
    if (Atomics.load(slots, STOP) === 1) return
    // The app connection owns the journal mode and every schema change; this
    // one only checkpoints and never writes a row.
    db = new Database(dbPath, { fileMustExist: true })
    db.pragma('busy_timeout = 1000')
    Atomics.store(slots, STATE, STATE_RUNNING)
    post({ type: 'ready' })

    let seenSequence = Atomics.load(slots, SEQUENCE)
    let seenVersion = Number(db.pragma('data_version', { simple: true }))
    let lastCheckpointAt = 0
    let walAtCheckpoint = walSize(dbPath)
    let incomplete = false
    let pinnedReported = false
    let errors = 0

    while (Atomics.load(slots, STOP) === 0) {
      Atomics.wait(slots, SEQUENCE, seenSequence, tuning.pollMs)
      if (Atomics.load(slots, STOP) !== 0) break
      const sequence = Atomics.load(slots, SEQUENCE)
      const requested = sequence !== seenSequence
      seenSequence = sequence
      try {
        const version = Number(db.pragma('data_version', { simple: true }))
        const changed = version !== seenVersion
        const now = Date.now()
        const walBytes = walSize(dbPath)
        let reason: WalCheckpointResult['reason'] | null = null
        if (requested) reason = 'requested'
        else if (changed && walBytes - walAtCheckpoint >= tuning.growthBytes) reason = 'growth'
        else if (changed && now - lastCheckpointAt >= tuning.intervalMs) reason = 'interval'
        // A reader stopped the last one part way: try again, new writes or
        // not, so the WAL is copied out soon after that reader ends.
        else if (incomplete && now - lastCheckpointAt >= tuning.intervalMs) reason = 'incomplete'
        if (!reason) continue

        const started = performance.now()
        const rows = db.pragma('wal_checkpoint(PASSIVE)') as CheckpointRow[]
        const durationMs = performance.now() - started
        // busy: another connection held the checkpoint lock (the app
        // connection's backstop); SQLite then reports -1 for both counts.
        const { busy, log, checkpointed } = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 }
        // The version read before the copy: commits that landed during it are
        // still new for the next poll.
        seenVersion = version
        lastCheckpointAt = Date.now()
        walAtCheckpoint = walSize(dbPath)
        incomplete = busy !== 0 || checkpointed < log
        errors = 0
        post({ type: 'checkpoint', result: { reason, durationMs, busy: busy !== 0, log, checkpointed, walBytes: walAtCheckpoint } })
        if (busy === 0 && incomplete && walAtCheckpoint >= tuning.pinnedWarnBytes) {
          if (!pinnedReported) post({ type: 'pinned', walBytes: walAtCheckpoint, log, checkpointed })
          pinnedReported = true
        } else if (!incomplete) {
          pinnedReported = false
        }
      } catch (error) {
        errors++
        const fatal = errors >= tuning.maxConsecutiveErrors
        post({ type: 'error', message: error instanceof Error ? error.message : String(error), fatal })
        if (fatal) break
      }
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error), fatal: true })
  } finally {
    try {
      db?.close()
    } finally {
      Atomics.store(slots, STATE, STATE_STOPPED)
      Atomics.notify(slots, STATE)
    }
  }
}
