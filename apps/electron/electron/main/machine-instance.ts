import { unlinkSync } from 'fs'
import { createConnection, createServer, type Server } from 'net'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'

/**
 * One HiDock per user on this machine, whatever profile it runs with.
 *
 * Electron's single-instance lock is keyed to the userData folder, so a second
 * launch with a different profile (HIDOCK_DEV_USERDATA, a benchmark, a copied
 * install) got its own lock and opened a second window beside the first. This
 * lock is a named pipe (a Unix socket elsewhere) named after the OS user: the
 * first instance listens on it; a later one finds it taken, asks the first to
 * come forward, and quits before it opens any database.
 */

export function machineInstancePipePath(): string {
  const user = (() => {
    try {
      return userInfo().username
    } catch {
      return 'user'
    }
  })().replace(/[^a-zA-Z0-9_.-]/g, '_')
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\hidock-next-${user}`
    : join(tmpdir(), `hidock-next-${user}.sock`)
}

const SHOW = 'show\n'

export interface MachineInstanceOptions {
  /** Called in the running instance when another one tried to start. */
  onSecondLaunch: () => void
  pipePath?: string
}

let server: Server | null = null

/**
 * Resolves true when this process is the only HiDock for this user, false when
 * another one is running (it has been asked to show its window).
 *
 * Connect first, listen second: on Windows a second server can listen on the
 * same pipe name without an error, so "listen failed" cannot be the signal.
 * An answer on the pipe is.
 */
export async function acquireMachineInstanceLock(options: MachineInstanceOptions): Promise<boolean> {
  const path = options.pipePath ?? machineInstancePipePath()
  if (await askRunningInstanceToShow(path)) return false
  if (process.platform !== 'win32') {
    // Nobody answered, so a socket file left here belongs to a crashed run.
    try {
      unlinkSync(path)
    } catch {
      /* none */
    }
  }
  return new Promise((resolve) => {
    const candidate = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        if (String(chunk).includes('show')) options.onSecondLaunch()
      })
      socket.on('error', () => {})
    })
    candidate.once('error', (error: NodeJS.ErrnoException) => {
      // Refusing to start would lock the owner out of the app, so continue on
      // Electron's own per-profile lock and say why.
      console.warn(`[MachineInstance] Could not take the machine-wide lock (${error.code}); continuing.`)
      resolve(true)
    })
    candidate.listen(path, () => {
      server = candidate
      resolve(true)
    })
  })
}

/** True when a running instance answered on the pipe and was asked to show. */
function askRunningInstanceToShow(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(path)
    const timer = setTimeout(() => {
      client.destroy()
      resolve(false)
    }, 1500)
    client.once('connect', () => {
      clearTimeout(timer)
      client.end(SHOW)
      resolve(true)
    })
    client.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** Tests and shutdown: stop holding the lock. */
export function releaseMachineInstanceLock(): Promise<void> {
  const current = server
  server = null
  return new Promise((resolve) => (current ? current.close(() => resolve()) : resolve()))
}
