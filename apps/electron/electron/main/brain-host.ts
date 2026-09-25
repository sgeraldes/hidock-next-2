/**
 * The headless second brain: the app's own code, with no window, reading the
 * database and answering the brain API until nobody asks for a while.
 *
 * Launched as `HiDock Next.exe --brain-only` by an agent's bridge when the app
 * is closed. It is the same binary on purpose. The answers an agent gets pass
 * through the app's eligibility gate — the rule that keeps recordings the owner
 * marked personal, deleted or value-excluded away from assistants — and a
 * second implementation of that rule in a separate service would drift.
 *
 * What it does not do, so it stays light: no window, no GPU, no boot tasks, no
 * embedder, no vector store, no device, no calendar sync. The database is
 * opened read-only, so it can run beside the app without either one blocking
 * the other. The one write it ever makes is the schema upgrade a new build
 * needs, and only while it holds the lock that proves no app is running or
 * starting (see brain-upgrade.ts); then it reopens the file read-only.
 *
 * Its lifetime is the owner's rule, "if the app is not needed, it does not
 * run": it exits after BRAIN_IDLE_MS without a request, and it exits the moment
 * the app takes over, which the app asks for on start and which this process
 * also notices on its own by watching the lock file.
 */

import { app } from 'electron'
import { spawn } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { initializeConfig } from './services/config'
import {
  closeDatabase,
  initializeDatabase,
  initializeDatabaseReadOnly,
  SchemaBehindError,
} from './services/database'
import { requestSharedInstanceLock } from './single-instance'
import { upgradeDatabaseWhenAlone } from './brain-upgrade'
import {
  brainLockPath,
  probeBrain,
  readBrainLock,
  packagedExe,
  removeBrainLockIfOwned,
  writeBrainLock,
  type BrainLock,
} from './services/brain-lock'
import { startBrainServer, type RunningBrainServer } from './services/brain-server'
import * as brainQueries from './services/brain-queries'

/**
 * How long without a request before the headless brain goes away. Ten minutes
 * covers a morning pull that makes a few calls in a row. HIDOCK_BRAIN_IDLE_MS
 * overrides it, which is how the exit is verified without waiting ten minutes.
 */
export const BRAIN_IDLE_MS = Number(process.env.HIDOCK_BRAIN_IDLE_MS) > 0 ? Number(process.env.HIDOCK_BRAIN_IDLE_MS) : 10 * 60 * 1000

/** How often to look at the lock file for a new owner. */
const LOCK_WATCH_MS = 3000

/** One line of JSON on stdout, so a launcher can read what happened. */
function report(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ brain: 'service', ...event })}\n`)
}

/**
 * Open the file read-only. When it is a schema behind this build, upgrade it
 * first if no other HiDock has it, then open it read-only like any other start.
 */
async function openDatabaseForReading(): Promise<void> {
  try {
    initializeDatabaseReadOnly()
    return
  } catch (error) {
    if (!(error instanceof SchemaBehindError)) throw error
    await upgradeDatabaseWhenAlone(error, {
      takeLock: requestSharedInstanceLock,
      releaseLock: () => app.releaseSingleInstanceLock(),
      onAppLaunchRefused: (listener) => {
        app.on('second-instance', listener)
        return () => app.removeListener('second-instance', listener)
      },
      upgrade: async (onProgress) => {
        try {
          await initializeDatabase({ onProgress })
        } finally {
          closeDatabase()
        }
      },
      openApp,
      report,
    })
  }
  initializeDatabaseReadOnly()
}

/**
 * Start the app the owner clicked while the upgrade held the lock. Only an
 * installed build: a dev run's executable is electron.exe, which needs the
 * project path and must not be pointed at the owner's data by accident.
 */
function openApp(): void {
  if (!app.isPackaged) {
    report({ event: 'open-app-skipped', reason: 'not an installed build' })
    return
  }
  spawn(process.execPath, [], { detached: true, stdio: 'ignore' }).unref()
}

export async function runBrainOnly(): Promise<void> {
  const lockPath = brainLockPath(app.getPath('userData'))

  // Never two. If something already answers, point at it and leave.
  const existing = readBrainLock(lockPath)
  if (existing && (await probeBrain(existing))) {
    report({ event: 'already-running', kind: existing.kind, port: existing.port })
    app.exit(0)
    return
  }

  try {
    await initializeConfig({ persist: false })
    await openDatabaseForReading()
  } catch (error) {
    report({ event: 'failed', error: error instanceof Error ? error.message : String(error) })
    app.exit(1)
    return
  }

  const token = randomBytes(32).toString('hex')
  const instanceId = randomUUID()
  let server: RunningBrainServer | null = null
  let idleTimer: NodeJS.Timeout | null = null
  let lockWatch: NodeJS.Timeout | null = null
  let leaving = false

  const stepDown = async (reason: string): Promise<void> => {
    if (leaving) return
    leaving = true
    if (idleTimer) clearTimeout(idleTimer)
    if (lockWatch) clearInterval(lockWatch)
    // Let go of the lock while the server still answers. The app waits for this
    // server to stop answering before it writes its own lock, so removing ours
    // first means the app's new lock can never land between our read and our
    // delete. Requests already in flight still finish before the server closes.
    removeBrainLockIfOwned(lockPath, instanceId)
    if (server) await server.close()
    try {
      closeDatabase()
    } catch {
      // Exiting either way.
    }
    report({ event: 'stopped', reason })
    app.exit(0)
  }

  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => void stepDown('idle'), BRAIN_IDLE_MS)
  }

  server = await startBrainServer({
    kind: 'service',
    token,
    instanceId,
    queries: brainQueries,
    onRequest: touch,
    onStepDown: () => void stepDown('the app took over'),
  })

  const lock: BrainLock = {
    kind: 'service',
    pid: process.pid,
    port: server.port,
    token,
    instanceId,
    startedAt: new Date().toISOString(),
    exe: packagedExe(app.isPackaged, process.execPath),
  }

  // Claim, then confirm the claim stuck. Two launchers racing both write; the
  // one whose lock is on disk afterwards keeps running and the other leaves.
  const winner = readBrainLock(lockPath)
  if (winner && winner.instanceId !== instanceId && (await probeBrain(winner))) {
    await server.close()
    closeDatabase()
    report({ event: 'already-running', kind: winner.kind, port: winner.port })
    app.exit(0)
    return
  }
  writeBrainLock(lockPath, lock)
  if (readBrainLock(lockPath)?.instanceId !== instanceId) {
    await stepDown('lost the race for the lock')
    return
  }

  touch()
  lockWatch = setInterval(() => {
    const current = readBrainLock(lockPath)
    // The app writes itself into the lock when it opens. So does a rival that
    // won a race we did not see. Either way this process is no longer the brain.
    if (current?.instanceId !== instanceId) void stepDown(current ? `${current.kind} owns the lock` : 'lock removed')
  }, LOCK_WATCH_MS)

  report({ event: 'started', port: server.port, pid: process.pid, idleMinutes: BRAIN_IDLE_MS / 60000 })
}
