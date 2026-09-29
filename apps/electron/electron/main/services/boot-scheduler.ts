/**
 * Boot Scheduler — sequential, idle-yielding runner for heavy, non-critical
 * startup work.
 *
 * ## Why this exists (root cause of the restart freeze)
 *
 * On a large database the app used to fire a *burst* of heavy main-process work
 * right after the window was shown:
 *
 *  - the transcription backlog drain (`startTranscriptionProcessor` → immediate
 *    `processQueue`, ~240 items), plus
 *  - five INDEPENDENT `setTimeout` backfills bunched at 8s/10s/12s/15s/20s:
 *    org-reconciler (which runs the ~1,521-row status self-heal),
 *    meeting-wiki backfill, knowledge-capture backfill, embeddings backfill,
 *    and failed-transcript reanalysis, plus
 *  - the living-graph ingest (rekey over ~43,700 nodes) that the drain triggers.
 *
 * All of that is synchronous sql.js work on the ONE main-process event loop, so
 * it overlapped and starved the renderer's IPC — the window went "not
 * responding" with high CPU for a while after every restart.
 *
 * ## What it does
 *
 * Runs registered tasks ONE AT A TIME (concurrency cap = 1). Each task is awaited
 * to completion before the next starts, and an idle gap is inserted BETWEEN tasks
 * so the event loop drains the renderer's queued IPC in the meantime.
 * Provider-backed corpus backfills are not eligible boot tasks: the drain must
 * reach a terminal state rather than merely hiding an open-ended repair pass
 * behind the window.
 *
 * The scheduler does NOT change what any task does or the order the user's data
 * is processed in — it only governs WHEN each boot task starts relative to the
 * others so the UI stays responsive.
 *
 * ## Per-task timing (F15)
 *
 * Sequencing alone was not enough: one task could still monopolize the event loop
 * for tens of seconds and freeze the window on its own. Every task is therefore
 * timed and the record kept in memory (`getBootTaskTimings()`), so a stall can be
 * attributed to a specific task instead of guessed at. The per-task lines are QA
 * logs (gated on the QA Logs toggle, see services/qa-logs.ts).
 *
 * What always warns is a FREEZE, not a long task: while a task runs the
 * scheduler measures how late the event loop's timer fires, and a task that
 * held the loop for `STALL_WARN_MS` or more is a defect. Total time is not the
 * signal. The database backup takes 11 s, but it copies 8 MB per step and
 * yields between steps, so the window never froze; warning on its wall time
 * would put a false alarm in the error log on every start (29-sep-2026).
 */

import { isQaLogsEnabled } from './qa-logs'

export interface BootTask {
  /** Human-readable label for logging. */
  name: string
  /**
   * The work to run. May be sync or async; the scheduler awaits it before
   * starting the next task. Tasks that kick off their own long-running loop
   * (e.g. starting an interval-based processor) should return promptly so they
   * do not block later tasks.
   */
  run: () => void | Promise<void>
}

export interface BootSchedulerOptions {
  /**
   * Idle delay (ms) before the FIRST task runs. Lets the renderer's first paint
   * and its initial data-load IPC settle before any heavy task competes.
   */
  startDelayMs?: number
  /**
   * Idle gap (ms) inserted BETWEEN consecutive tasks. This is the yield that
   * keeps the main-process event loop servicing renderer IPC between heavy
   * passes.
   */
  gapMs?: number
  /**
   * Optional logger override. Defaults to a QA-gated `[QA-MONITOR]` logger, so
   * per-task chatter only appears when the QA Logs toggle is on. Freeze
   * warnings and task failures bypass this and always print.
   */
  log?: (msg: string) => void
  /** Tests: how the longest event-loop freeze during a task is measured. */
  measureStall?: () => StallProbe
}

/**
 * Measures the longest event-loop freeze during each boot task: a 10 ms timer
 * that records how late each tick fires. One probe lives for the whole drain.
 */
export interface StallProbe {
  /** Starts a fresh measurement for the next task. */
  begin: () => void
  /** Ends it and returns the longest freeze since `begin`, in ms. */
  end: () => number | Promise<number>
  /** Stops the probe for good. */
  close: () => void
}

const STALL_TICK_MS = 10
/**
 * One gap between two ticks this long is the machine sleeping (lid closed,
 * hibernate), not the app freezing: a freeze of a minute would be an outage,
 * not a boot warning. Such a gap is ignored.
 */
const SUSPEND_GAP_MS = 60_000

/** How much of a gap between two probe ticks counts as a freeze. */
export function stallFromGap(gapMs: number): number {
  if (gapMs >= SUSPEND_GAP_MS) return 0
  return Math.max(0, gapMs - STALL_TICK_MS)
}

/**
 * The real probe. A task that never yields ends before the loop can fire the
 * late tick, so `end()` waits two ticks for the freeze to be recorded. (Node's
 * own monitorEventLoopDelay histogram was tried first: it ignores the first tick
 * after enable() and after reset(), which swallows exactly the freeze that
 * starts a task.)
 */
function createStallProbe(): StallProbe {
  let lastTick = performance.now()
  let maxLateMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxLateMs = Math.max(maxLateMs, stallFromGap(now - lastTick))
    lastTick = now
  }, STALL_TICK_MS)
  timer.unref()
  return {
    begin: () => {
      maxLateMs = 0
    },
    end: async () => {
      await new Promise((resolve) => setTimeout(resolve, STALL_TICK_MS * 2))
      return Math.max(0, Math.round(maxLateMs))
    },
    close: () => clearInterval(timer)
  }
}

/** One completed boot task's timing record. */
export interface BootTaskTiming {
  /** Task name as registered. */
  name: string
  /** Epoch ms when the task started. */
  startedAt: number
  /** Wall-clock ms the task held the scheduler (await included). */
  elapsedMs: number
  /** Longest event-loop freeze while the task ran: how long the window could not respond. */
  maxStallMs: number
  /** False when the task threw; the scheduler continues either way. */
  ok: boolean
  /** Error message when `ok` is false. */
  error?: string
}

const DEFAULT_START_DELAY_MS = 4000
const DEFAULT_GAP_MS = 1500

/**
 * A boot task that holds the main process this long without yielding blocks ALL
 * renderer IPC: the window stutters, and past a few seconds it is reported "Not
 * Responding". Surfaced regardless of the QA Logs toggle.
 */
const STALL_WARN_MS = 1000
/** A task that takes this long in total, freeze or not, is noted in the QA log. */
const SLOW_TASK_NOTE_MS = 3000

let queue: BootTask[] = []
let started = false
let settled = false
let settlePromise: Promise<void> | null = null
let timings: BootTaskTiming[] = []
let settleWaiters: Array<() => void> = []
let activeStallProbe: StallProbe | null = null

/** Wait `ms` while yielding the event loop (renderer IPC runs during the wait). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Register a heavy boot task. Tasks run in registration order. May be called
 * before OR during draining — a task registered while the scheduler is running
 * is still picked up (the drain loop re-checks the queue each iteration).
 */
export function registerBootTask(task: BootTask): void {
  queue.push(task)
}

/** Number of tasks still waiting to run (drops to 0 once the queue drains). */
export function pendingBootTaskCount(): number {
  return queue.length
}

/**
 * Timing record for every boot task that has finished so far, in completion
 * order. This is the evidence surface for "which boot task froze the app" — it
 * is captured unconditionally (a handful of numbers), independently of whether
 * the QA Logs toggle is on for the human-readable lines.
 */
export function getBootTaskTimings(): readonly BootTaskTiming[] {
  return timings
}

/** True while the drain loop is running (started and not yet settled). */
export function isBootDrainActive(): boolean {
  return started && !settled
}

/**
 * True once the boot tasks have finished. Distinct from `!isBootDrainActive()`,
 * which is also true BEFORE the scheduler starts — the window in which the
 * boot-time calendar syncs arrive, and precisely when a caller must still wait.
 */
export function areBootTasksSettled(): boolean {
  return settled
}

/**
 * Resolve once the boot tasks have finished — used to keep other heavy
 * main-process work (notably calendar sync) from overlapping the boot drain.
 *
 * Resolves immediately when the drain has already settled. When the scheduler
 * has not started yet the caller still waits, because in the real app the
 * scheduler is started very shortly after (on the renderer's `did-finish-load`,
 * with a fallback timer) and starting heavy work in that window is precisely the
 * overlap this guards against.
 *
 * Always bounded by `timeoutMs`: a scheduler that never starts, or a task that
 * hangs, must never permanently wedge the caller. On timeout the promise
 * resolves (not rejects) — the caller proceeds, accepting possible overlap
 * rather than dropping the work entirely.
 */
export function whenBootTasksSettled(timeoutMs = 120000): Promise<void> {
  if (settled) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, timeoutMs))
    // Do not hold the process open just to wait for the boot drain.
    if (typeof timer.unref === 'function') timer.unref()
    settleWaiters.push(finish)
  })
}

/**
 * Begin draining the registered tasks sequentially. Idempotent: the first call
 * owns the drain; later calls return the same settle promise without starting a
 * second drain (so wiring it to both `did-finish-load` and a fallback timeout is
 * safe). Resolves when the queue is empty.
 */
export function startBootScheduler(options: BootSchedulerOptions = {}): Promise<void> {
  if (started) return settlePromise ?? Promise.resolve()
  started = true

  const startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS
  // Per-task chatter is a QA log; it stays silent unless the toggle is on.
  const log =
    options.log ?? ((m: string) => { if (isQaLogsEnabled()) console.log(`[QA-MONITOR][BootScheduler] ${m}`) })

  const stallProbe = (options.measureStall ?? createStallProbe)()
  activeStallProbe = stallProbe

  settlePromise = (async () => {
    try {
      await delay(startDelayMs)

      while (queue.length > 0) {
        const task = queue.shift() as BootTask
        const startedAt = Date.now()
        stallProbe.begin()
        let ok = true
        let error: string | undefined
        try {
          // ALWAYS printed, not QA-gated. `timings` below is the evidence surface
          // for a task that merely runs SLOW, but it lives in memory: a task that
          // aborts the process outright (V8 OOM, a native crash) takes the whole
          // record with it and leaves no trace of which task was running. That is
          // not hypothetical — an OOM abort in this drain went unattributed for
          // seven days because the last durable line came from the previous task,
          // making the NEXT task look innocent. One line per boot task (there are
          // ~8) is the price of every future startup crash naming its own culprit.
          console.log(`[BootScheduler] starting "${task.name}"`)
          await task.run()
        } catch (e) {
          // Best-effort: one failing task must never abort the rest (this matches
          // the pre-existing per-task try/catch each backfill had on its own).
          ok = false
          error = e instanceof Error ? e.message : String(e)
        }

        const elapsedMs = Date.now() - startedAt
        const maxStallMs = await stallProbe.end()
        timings.push({ name: task.name, startedAt, elapsedMs, maxStallMs, ok, ...(error ? { error } : {}) })
        if (process.env.HIDOCK_BENCH_OUTPUT) {
          console.info('[BootTiming] ' + JSON.stringify({ name: task.name, elapsedMs, maxStallMs, ok }))
        }

        if (ok) {
          log(`"${task.name}" done in ${elapsedMs}ms`)
        } else {
          // A failing boot task is a real defect, not QA chatter — always surface it.
          console.error(`[BootScheduler] "${task.name}" failed after ${elapsedMs}ms:`, error)
        }

        // A task that held the main process (and therefore every renderer IPC
        // round-trip) froze the window — report it regardless of the QA toggle so
        // the next stall is attributable without a repro session.
        if (maxStallMs >= STALL_WARN_MS) {
          console.warn(
            `[BootScheduler] boot task "${task.name}" froze the window for up to ${maxStallMs}ms ` +
              `(${elapsedMs}ms in total); it needs to yield between steps.`
          )
        } else if (elapsedMs >= SLOW_TASK_NOTE_MS) {
          log(`"${task.name}" took ${elapsedMs}ms in total but never froze the window for more than ${maxStallMs}ms`)
        }

        // Yield between tasks so the renderer's queued IPC is serviced before the
        // next heavy pass grabs the event loop.
        if (queue.length > 0) await delay(gapMs)
      }
    } catch (e) {
      // Nothing in the loop should throw (a task's own error is caught above), but if
      // something does, the drain still has to end: waiters must be released.
      console.error('[BootScheduler] drain stopped by an unexpected error:', e)
    } finally {
      stallProbe.close()
    }

    const totalMs = timings.reduce((sum, t) => sum + t.elapsedMs, 0)
    // Completion is operational state, not QA chatter. Keep this visible even
    // when QA logs are disabled so a startup report can prove that the drain
    // actually terminated instead of merely moving work behind the window.
    console.log(`[BootScheduler] Complete (${timings.length} tasks, ${totalMs}ms of task time)`)

    // Release anything that deferred itself until boot work finished (e.g. the
    // startup/periodic calendar sync) BEFORE resolving, so a waiter never starts
    // while the drain is still marked active.
    settled = true
    const waiters = settleWaiters
    settleWaiters = []
    for (const w of waiters) w()
  })()

  return settlePromise
}

/**
 * Test-only reset: clears the queue and the started/settled state so each test
 * observes a fresh scheduler. Not used by the app.
 */
export function _resetBootSchedulerForTests(): void {
  activeStallProbe?.close()
  activeStallProbe = null
  queue = []
  started = false
  settled = false
  settlePromise = null
  timings = []
  // Release any pending waiter so a test that awaited whenBootTasksSettled()
  // cannot hang past the reset.
  const waiters = settleWaiters
  settleWaiters = []
  for (const w of waiters) w()
}
