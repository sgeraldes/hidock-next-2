/**
 * The app's side of the second brain: while HiDock is open, it answers.
 *
 * The owner's rule: when the app is open it is fully responsible, and a
 * headless brain started earlier by an agent has no reason to keep running.
 * So on start the app asks any running headless brain to step down, waits for
 * it to go, serves the same API itself and writes itself into the lock file —
 * which the headless process also watches, as a second path to the same
 * outcome. A watchdog re-asserts the claim, so a headless process that slipped
 * in during a race, or a lock file someone deleted, is corrected within seconds.
 *
 * The API runs in-process on the app's own database connection and calls the
 * same query functions; there is no HTTP between the app and its data.
 */

import { app } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import {
  brainLockPath,
  packagedExe,
  probeBrain,
  readBrainLock,
  removeBrainLockIfOwned,
  requestStepDown,
  writeBrainLock,
  type BrainLock,
} from './brain-lock'
import { startBrainServer, type RunningBrainServer } from './brain-server'
import * as brainQueries from './brain-queries'
import { getMeetings } from './database'
import { parseHiDockFilenameDate } from './hidock-filename'

/** How long to wait for a headless brain to finish and exit after asking. */
const STEP_DOWN_WAIT_MS = 5000
/** How often the app re-checks that the lock still names it. */
const WATCHDOG_MS = 10000

let server: RunningBrainServer | null = null
let watchdog: NodeJS.Timeout | null = null
let lock: BrainLock | null = null
let lockPath = ''

async function waitUntilGone(other: BrainLock, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probeBrain(other, 500))) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** Ask whatever else holds the lock to leave. Returns once it has, or has had its chance. */
async function displaceOthers(): Promise<void> {
  const other = readBrainLock(lockPath)
  if (!other || other.instanceId === lock?.instanceId) return
  if (other.kind !== 'service') return // another app instance cannot exist; the single-instance lock sees to that
  if (!(await probeBrain(other))) return
  await requestStepDown(other)
  if (!(await waitUntilGone(other, STEP_DOWN_WAIT_MS))) {
    console.warn(`[Brain] headless brain pid ${other.pid} did not step down within ${STEP_DOWN_WAIT_MS} ms`)
  }
}

/**
 * What the device is recording right now, from the state the app's recording
 * poll already keeps. Reads no USB: a scan here would compete with downloads.
 * Kept in the shape the old bridge's `recording-now` returned.
 */
function recordingNow(getLiveRecording: () => { known: boolean; recording: string | null }) {
  return () => {
    const state = getLiveRecording()
    if (!state.known) return { recording: false, reason: 'the device state is not known yet (not connected, or not polled since connecting)' }
    if (!state.recording) return { recording: false }
    const started = parseHiDockFilenameDate(state.recording)
    const now = Date.now()
    const out: Record<string, unknown> = {
      recording: true,
      file: state.recording,
      startedAt: started?.toISOString() ?? null,
      durationSeconds: started ? Math.max(0, Math.round((now - started.getTime()) / 1000)) : null,
    }
    if (!started) return out
    const s = started.getTime()
    const meeting = getMeetings()
      .filter((m) => !m.is_all_day && m.start_time && m.end_time)
      .find((m) => s >= new Date(m.start_time!).getTime() - 600_000 && s <= new Date(m.end_time!).getTime())
    if (meeting) {
      out.matchedMeeting = { subject: meeting.subject, start: meeting.start_time, end: meeting.end_time }
      const overrun = Math.max(0, Math.round((now - new Date(meeting.end_time!).getTime()) / 1000))
      out.overrunSeconds = overrun
      if (overrun > 600) {
        out.warning =
          `GRABANDO ${Math.round(overrun / 60)} min DESPUES de que termino '${meeting.subject ?? 'la reunion'}'. ` +
          'Probablemente quedo una llamada abierta. Cortala: cada minuto es audio vacio que despues se transcribe.'
      }
    }
    return out
  }
}

/** Write our lock; a failure is logged and left to the watchdog to retry. */
function claimLock(): void {
  if (!lock) return
  try {
    writeBrainLock(lockPath, lock)
  } catch (error) {
    console.warn('[Brain] could not write the lock file; the watchdog retries:', error)
  }
}

/**
 * Bumped by every start and every stop. A start that finds it changed after an
 * await knows the app began quitting meanwhile, and backs out instead of
 * serving after the database has closed.
 */
let generation = 0

export async function startAppBrain(options: {
  getLiveRecording: () => { known: boolean; recording: string | null }
}): Promise<void> {
  if (server) return
  const mine = ++generation
  lockPath = brainLockPath(app.getPath('userData'))
  const token = randomBytes(32).toString('hex')
  const instanceId = randomUUID()
  lock = null

  await displaceOthers()
  if (mine !== generation) return

  const started = await startBrainServer({
    kind: 'app',
    token,
    instanceId,
    queries: brainQueries,
    recordingNow: recordingNow(options.getLiveRecording),
  })
  if (mine !== generation) {
    await started.close()
    return
  }
  server = started
  lock = {
    kind: 'app',
    pid: process.pid,
    port: server.port,
    token,
    instanceId,
    startedAt: new Date().toISOString(),
    exe: packagedExe(app.isPackaged, process.execPath),
  }

  // The watchdog goes up before the first write, so a first write that Windows
  // refuses is retried in ten seconds instead of leaving the app unreachable
  // for the whole session.
  watchdog = setInterval(() => {
    void (async () => {
      if (!lock) return
      const current = readBrainLock(lockPath)
      if (current?.instanceId === lock.instanceId) return
      await displaceOthers()
      claimLock()
    })()
  }, WATCHDOG_MS)
  claimLock()
  console.log(`[Brain] serving on 127.0.0.1:${server.port}`)
}

export async function stopAppBrain(): Promise<void> {
  generation++
  if (watchdog) clearInterval(watchdog)
  watchdog = null
  if (lock) removeBrainLockIfOwned(lockPath, lock.instanceId)
  lock = null
  const running = server
  server = null
  if (running) await running.close()
}
