/**
 * Build the tray icon (build/HiDockModelHost.exe) and run its decision tests.
 *
 * C against the Win32 API, compiled with zig for x86_64-windows-gnu: no MSVC,
 * no .NET, no runtime to ship. `zig` comes from PATH or ZIG_PATH.
 */

import { execFileSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const trayDir = join(packageRoot, 'tray')
const outDir = join(packageRoot, 'build')

const zig = process.env.ZIG_PATH || 'zig'
const common = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-target', 'x86_64-windows-gnu']

export function buildTray({ test = true } = {}) {
  mkdirSync(outDir, { recursive: true })
  if (test) {
    const testExe = join(outDir, 'decide_test.exe')
    execFileSync(zig, [...common, join(trayDir, 'decide.c'), join(trayDir, 'decide_test.c'), '-o', testExe], {
      stdio: 'inherit',
    })
    execFileSync(testExe, [], { stdio: 'inherit' })
  }
  const exe = join(outDir, 'HiDockModelHost.exe')
  execFileSync(
    zig,
    [
      ...common, '-O2', '-s',
      join(trayDir, 'tray.c'), join(trayDir, 'decide.c'),
      '-o', exe,
      '-luser32', '-lshell32', '-lgdi32', '-lwinhttp',
      '-Wl,--subsystem,windows',
    ],
    { stdio: 'inherit' }
  )
  return exe
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  console.log(`Built ${buildTray()}`)
}
