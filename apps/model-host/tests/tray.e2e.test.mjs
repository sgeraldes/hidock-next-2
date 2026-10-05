/**
 * The real tray icon, the real service, a fake game. Windows only, and only
 * when build/HiDockModelHost.exe exists (npm run build:tray).
 *
 * --no-icon keeps it out of the taskbar of whoever runs the tests, and --no-foreground keeps
 * their desktop (a full-screen window, say) from deciding the result: the game here is\n * found at start and waited on by its process, which is the path being tested.
 */

import { describe, it, expect } from 'vitest'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, execFileSync } from 'child_process'

const packageRoot = join(import.meta.dirname, '..')
const trayExe = join(packageRoot, 'build', 'HiDockModelHost.exe')
const fakeUpdateExe = join(packageRoot, 'build', 'fake_update.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitFor(check, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await sleep(250)
  }
  return false
}

function processesUnder(dir) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir.replace(/'/g, "''")}', 'OrdinalIgnoreCase') }).Count`,
  ]).toString().trim()
  return Number(out)
}

function memoryOf(pid) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.TotalProcessorTime.TotalMilliseconds)"`,
  ]).toString().trim().split(' ').map(Number)
  return { workingSet: out[0], private: out[1], cpuMs: out[2] }
}

function stage(base, port) {
  const app = join(base, 'app')
  const root = join(base, 'root')
  mkdirSync(app, { recursive: true })
  mkdirSync(root, { recursive: true })
  copyFileSync(trayExe, join(app, 'HiDockModelHost.exe'))
  copyFileSync(process.execPath, join(app, 'node.exe'))
  cpSync(join(packageRoot, 'src'), join(app, 'src'), { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ port, bindAddress: '127.0.0.1', stepAside: 'games' }))
  return { app, root }
}

/** The service's node.exe: the copy inside this test's app folder. */
function serviceNodeOf(trayPid) {
  // Query the tray's child directly. Comparing ExecutablePath strings depends
  // on WMI's short/long path spelling and scans every Node process on the host.
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=${trayPid}" | Select-Object -First 1).ProcessId`,
  ]).toString().trim()
  return Number(out) || 0
}

describe.runIf(process.platform === 'win32' && existsSync(trayExe))('the tray icon keeps the service alive', () => {
  it('starts the service again after it dies on its own', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hidock-tray-restart-'))
    const port = 30000 + Math.floor(Math.random() * 9000)
    const { app, root } = stage(base, port)
    const tray = spawn(
      join(app, 'HiDockModelHost.exe'),
      // WMI startup on CI can consume most of a fixed 25-second tray lifetime.
      // Keep this supervisor alive until the test has observed its replacement.
      ['--no-icon', '--no-foreground', '--root', root, '--restart-seconds', '2'],
      { stdio: 'ignore' }
    )
    try {
      expect(await waitFor(() => healthy(port), 10_000)).toBe(true)
      // WMI can list a process a moment after it already answers on its port (CI, 4-oct).
      let node = 0
      await waitFor(() => (node = serviceNodeOf(tray.pid)) > 0, 5000)
      expect(node).toBeGreaterThan(0)
      process.kill(node)
      expect(await waitFor(async () => !(await healthy(port)), 5000)).toBe(true)
      expect(await waitFor(() => healthy(port), 12_000)).toBe(true)
      const replacement = serviceNodeOf(tray.pid)
      expect(replacement).toBeGreaterThan(0)
      expect(replacement).not.toBe(node)
      const exited = new Promise((r) => tray.once('exit', r))
      tray.kill()
      await exited
      expect(await waitFor(() => processesUnder(app) === 0, 5000)).toBe(true)
    } finally {
      if (tray.exitCode === null) tray.kill()
      await sleep(500)
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.runIf(process.platform === 'win32' && existsSync(trayExe))('the tray icon', () => {
  it('keeps the service down while a game runs, brings it up after, and leaves nothing behind', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hidock-tray-e2e-'))
    const port = 30000 + Math.floor(Math.random() * 9000)
    const { app, root } = stage(base, port)

    const gameDir = join(base, 'Library', 'steamapps', 'common', 'Fake Game')
    mkdirSync(gameDir, { recursive: true })
    copyFileSync('C:\\Windows\\System32\\PING.EXE', join(gameDir, 'fakegame.exe'))
    const game = spawn(join(gameDir, 'fakegame.exe'), ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })

    const tray = spawn(
      join(app, 'HiDockModelHost.exe'),
      // --track-pid stands in for the game coming to the front: a test must not take the screen.
      ['--no-icon', '--no-foreground', '--track-pid', String(game.pid), '--root', root, '--quiet-seconds', '3', '--exit-after', '25'],
      { stdio: 'ignore' }
    )
    try {
      // A game is running: the service stays down.
      await sleep(3000)
      expect(await healthy(port)).toBe(false)
      expect(processesUnder(app)).toBe(1) // the icon alone

      const idle = memoryOf(tray.pid)
      console.log(`tray while a game runs: working set ${Math.round(idle.workingSet / 1024)} KB, private ${Math.round(idle.private / 1024)} KB, CPU ${idle.cpuMs} ms`)
      expect(idle.workingSet).toBeLessThan(8 * 1024 * 1024)

      // The game ends; after the quiet period the service comes up.
      game.kill()
      expect(await waitFor(() => healthy(port), 12_000)).toBe(true)

      // Quitting the icon takes the whole service with it.
      await new Promise((r) => tray.once('exit', r))
      expect(await waitFor(async () => !(await healthy(port)), 5000)).toBe(true)
      expect(processesUnder(app)).toBe(0)
    } finally {
      if (tray.exitCode === null) tray.kill()
      if (game.exitCode === null) game.kill()
      await sleep(500)
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.runIf(process.platform === 'win32' && existsSync(trayExe) && existsSync(fakeUpdateExe))('an update from HiDock', () => {
  it('the service stages it and exits, the icon runs it outside its job and quits', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hidock-tray-update-'))
    const port = 30000 + Math.floor(Math.random() * 9000)
    const { app, root } = stage(base, port)
    const tray = spawn(join(app, 'HiDockModelHost.exe'), ['--no-icon', '--no-foreground', '--root', root, '--exit-after', '40'], {
      stdio: 'ignore',
    })
    try {
      expect(await waitFor(() => healthy(port), 10_000)).toBe(true)
      const { token } = await (await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      })).json()
      const put = await fetch(`http://127.0.0.1:${port}/update`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: readFileSync(fakeUpdateExe),
      })
      expect(put.status).toBe(202)
      // The icon quits after starting the "installer"; the fake writes ran.txt next to itself.
      await new Promise((r) => tray.once('exit', r))
      const marker = join(root, 'update', 'ran.txt')
      expect(await waitFor(async () => existsSync(marker), 5000)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toMatch(/\/S/)
      expect(processesUnder(app)).toBe(0)
    } finally {
      if (tray.exitCode === null) tray.kill()
      await sleep(500)
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})
