/**
 * Eyes for game mode: a long-lived PowerShell that reports the running programs
 * and the screen state, and nvidia-smi for programs holding a CUDA context.
 *
 * One PowerShell for the life of the host, not one per look: starting
 * PowerShell costs more than the look itself, on the machine someone is
 * playing on.
 */

import { spawn, execFile } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const PROBE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'probe.ps1')

/** One snapshot from one line of the script, or null for anything else. */
export function parseProbeLine(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed.processes)) return null
    return {
      notificationState: Number(parsed.notificationState) || 0,
      processes: parsed.processes.map((p) => ({ name: String(p?.name ?? ''), path: String(p?.path ?? '') })),
    }
  } catch {
    return null
  }
}

/** `pid, name` rows from nvidia-smi --query-compute-apps. */
export function parseComputeApps(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((row) => row.match(/^\s*(\d+)\s*,\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: m[2] }))
}

/** Programs with a CUDA context. No driver, no answer, no programs. */
export async function queryGpuProcesses(run = execFileAsync) {
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-compute-apps=pid,process_name', '--format=csv,noheader'],
      { windowsHide: true, timeout: 5000 }
    )
    return parseComputeApps(stdout)
  } catch {
    return []
  }
}

/**
 * Run the probe until stop(). It is started again if it dies, so one bad look
 * does not leave game mode blind for the rest of the evening.
 *
 * @param {object} options
 * @param {(snapshot: object) => void} options.onSnapshot
 * @param {number} [options.intervalMs]
 * @param {number} [options.restartDelayMs]
 * @param {(message: string) => void} [options.log]
 * @param {typeof spawn} [options.spawnFn] injected for tests
 */
export function startProbe(options) {
  const spawnFn = options.spawnFn || spawn
  const intervalMs = options.intervalMs ?? 2000
  const restartDelayMs = options.restartDelayMs ?? 10_000
  const log = options.log || (() => {})
  let child = null
  let stopped = false
  let restartTimer = null

  const launch = () => {
    let buffer = ''
    const current = spawnFn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PROBE_SCRIPT,
        '-IntervalMs', String(intervalMs),
        '-ParentPid', String(process.pid),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child = current
    current.stdout.setEncoding('utf8')
    current.stderr.setEncoding('utf8')
    current.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const snapshot = parseProbeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (snapshot) options.onSnapshot(snapshot)
      }
    })
    current.stderr.on('data', (chunk) => log(`[game mode] probe: ${String(chunk).trim().slice(0, 300)}`))
    current.on('error', (error) => log(`[game mode] probe could not start: ${error.message}`))
    current.on('exit', (code) => {
      if (child === current) child = null
      if (stopped) return
      log(`[game mode] probe exited (${code}); starting it again in ${Math.round(restartDelayMs / 1000)} s`)
      restartTimer = setTimeout(launch, restartDelayMs)
    })
  }

  launch()
  return {
    stop() {
      stopped = true
      clearTimeout(restartTimer)
      child?.kill()
    },
  }
}
