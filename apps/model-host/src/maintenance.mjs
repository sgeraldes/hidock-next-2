/**
 * Looking after the host from HiDock, over the paired connection.
 *
 * The gamestation has no settings and the person is not at it, and Windows
 * does not let the main PC read its files (the account saved there is not the
 * one the host runs as). So the host answers these itself, to the HiDock it
 * paired with: what its logs say, whether torch sees CUDA, a reinstall of
 * torch, and a new version of itself.
 */

import { execFile } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** The service exits with this after staging an update; the tray icon then runs it. */
export const UPDATE_EXIT_CODE = 75

const LOG_TAIL_BYTES = 16 * 1024
const UPDATE_MAX_BYTES = 200 * 1024 * 1024

const TORCH_PROBE = [
  'import json, torch',
  'available = torch.cuda.is_available()',
  'print(json.dumps({"torch": torch.__version__, "cudaBuild": torch.version.cuda,',
  '  "cudaAvailable": available, "device": torch.cuda.get_device_name(0) if available else None}))',
].join('\n')

/** The last bytes of a file, or '' when it is not there. */
function tail(file, bytes = LOG_TAIL_BYTES) {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

async function probeTorch(pythonPath, run) {
  try {
    const { stdout } = await run(pythonPath, ['-c', TORCH_PROBE], { windowsHide: true, timeout: 120_000 })
    return JSON.parse(String(stdout).trim().split('\n').pop())
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 400) }
  }
}

/** Logs and CUDA, for HiDock to show and for whoever looks after the host. Never the token. */
export async function collectDiagnostics({ dirs, pythonPath, run = execFileAsync }) {
  return {
    setupLog: tail(join(dirs.logs, 'setup.log')),
    serviceLog: tail(join(dirs.logs, 'service.log')),
    repairLog: tail(join(dirs.logs, 'repair.log')),
    torch: await probeTorch(pythonPath, run),
  }
}

/**
 * Reinstall torch and torchaudio at the pinned versions from the CUDA index.
 * --no-deps keeps every other package as it is; only the CUDA build changes.
 */
export async function repairRuntime({ pythonPath, constraintsPath, logFile, run = execFileAsync, cudaTag = 'cu126' }) {
  const pins = readFileSync(constraintsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^(torch|torchaudio)==/.test(line.trim()))
    .map((line) => line.trim())
  if (pins.length !== 2) throw new Error('constraints.txt does not pin torch and torchaudio')
  const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  mkdirSync(join(logFile, '..'), { recursive: true })
  log(`reinstalling ${pins.join(' ')} from ${cudaTag}`)
  try {
    const { stdout } = await run(
      pythonPath,
      [
        '-m', 'pip', 'install', '--no-warn-script-location', '--force-reinstall', '--no-deps',
        '--index-url', `https://download.pytorch.org/whl/${cudaTag}`, ...pins,
      ],
      { windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
    )
    log(String(stdout ?? '').trim().split('\n').slice(-5).join(' | '))
  } catch (error) {
    log(`pip failed: ${String(error?.message || error).slice(0, 2000)}`)
    throw new Error(`reinstalling torch failed: ${String(error?.message || error).split('\n')[0]}`)
  }
  const torch = await probeTorch(pythonPath, run)
  log(`after repair: ${JSON.stringify(torch)} (cuda ${torch.cudaAvailable ? 'available' : 'NOT available'})`)
  return torch
}

/**
 * Keep the installer HiDock sent where the tray icon runs it from. A paired
 * HiDock is trusted with this on purpose: it is in charge of this machine's
 * host (Sebastián, 4-oct-2026). Only a Windows executable is kept.
 */
export function stageUpdate({ root }, body) {
  if (body.length > UPDATE_MAX_BYTES) throw Object.assign(new Error('the update is too large'), { status: 413 })
  if (body.length < 1024 || body[0] !== 0x4d || body[1] !== 0x5a) {
    throw Object.assign(new Error('the update is not a Windows program'), { status: 400 })
  }
  const dir = join(root, 'update')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'HiDock-Model-Host-Setup.exe')
  writeFileSync(path, body)
  return path
}
