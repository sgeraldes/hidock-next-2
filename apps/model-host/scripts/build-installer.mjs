/**
 * Build HiDock-Model-Host-<version>-Setup.exe.
 *
 * The payload is deliberately small: the host's own source, a copy of Node to
 * run it, ffmpeg, and the diarization worker. Everything heavy — the CUDA build of
 * torch, pyannote, the model weights — arrives on first run, where the person
 * can see the size, cancel and retry.
 *
 * makensis comes from electron-builder's cache, which the client app already
 * populates when it builds its own installer. No second toolchain.
 */

import { execFileSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createRequire } from 'module'
import { buildTray } from './build-tray.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const repoRoot = join(packageRoot, '..', '..')
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version

/** Where electron-builder keeps the NSIS it downloaded. */
function findMakensis() {
  const fromEnv = process.env.MAKENSIS_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const cache = join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'electron-builder', 'Cache', 'nsis'
  )
  if (!existsSync(cache)) return null
  for (const entry of readdirSync(cache)) {
    const candidate = join(cache, entry, 'makensis.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The ffmpeg the client ships (ffmpeg-static).
 *
 * The worker decodes every recording with ffmpeg, WAV included, and a gaming PC
 * has no reason to have one on PATH. Without this copy every job failed on the
 * host and quietly went back to the client's CPU.
 */
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH
  try {
    const require = createRequire(join(repoRoot, 'apps', 'electron', 'package.json'))
    return require('ffmpeg-static')
  } catch {
    return ''
  }
}

/**
 * Compile native/process-sampler.c to build/process-sampler.exe with the same zig and flags as the tray icon:
 * no MSVC, no SDK install, no runtime to ship. Warnings are errors.
 */
export function buildSampler() {
  const zig = process.env.ZIG_PATH || 'zig'
  const out = join(packageRoot, 'build', 'process-sampler.exe')
  mkdirSync(join(packageRoot, 'build'), { recursive: true })
  execFileSync(zig, ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-target', 'x86_64-windows-gnu', '-O2', '-s',
    join(packageRoot, 'native', 'process-sampler.c'), '-o', out, '-lpsapi'], { stdio: 'inherit' })
  return out
}

/**
 * @param {string} stageDir
 * @param {object} [sources] injected for tests; the real build copies the
 *   running Node and the client's ffmpeg-static
 */
export function stage(stageDir, sources = {}) {
  const nodePath = sources.nodePath || process.execPath
  const trayPath = sources.trayPath || join(packageRoot, 'build', 'HiDockModelHost.exe')
  if (!existsSync(trayPath)) {
    throw new Error(`the tray icon was not built (${trayPath}). Run npm run build:tray, which needs zig.`)
  }
  const ffmpegPath = sources.ffmpegPath ?? findFfmpeg()
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error(
      `ffmpeg was not found (${ffmpegPath || 'ffmpeg-static is not installed'}). ` +
        'Install the client once (npm ci in apps/electron) or set FFMPEG_PATH.'
    )
  }

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  cpSync(join(packageRoot, 'src'), join(stageDir, 'src'), { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(stageDir, 'package.json'))
  // The gateway needs ws at runtime. Copy only this pinned pure-JS dependency,
  // never the development dependency tree or optional native accelerators.
  cpSync(join(packageRoot, 'node_modules', 'ws'), join(stageDir, 'node_modules', 'ws'), { recursive: true })
  cpSync(join(packageRoot, 'installer', 'setup.ps1'), join(stageDir, 'setup.ps1'))
  cpSync(join(packageRoot, 'installer', 'Prepare-ASR.ps1'), join(stageDir, 'Prepare-ASR.ps1'))
  cpSync(join(packageRoot, 'installer', 'Prepare-SemanticEmbeddings.ps1'), join(stageDir, 'Prepare-SemanticEmbeddings.ps1'))
  cpSync(join(packageRoot, 'installer', 'Prepare-Realtime.ps1'), join(stageDir, 'Prepare-Realtime.ps1'))
  cpSync(join(packageRoot, 'installer', 'Prepare-Generation.ps1'), join(stageDir, 'Prepare-Generation.ps1'))
  cpSync(join(packageRoot, 'installer', 'constraints.txt'), join(stageDir, 'constraints.txt'))
  cpSync(join(packageRoot, 'installer', 'decide-requirements.txt'), join(stageDir, 'decide-requirements.txt'))
  cpSync(ffmpegPath, join(stageDir, 'ffmpeg.exe'))
  // The native process-family sampler sits next to node.exe, where src/windows-process-sampler.mjs looks for it.
  // Left out when it was not built (the unit tests stage without it): the host then reports its
  // process-family figures as unavailable with the reason, rather than failing to start. A real build
  // compiles it first (see main), so an installer built here always carries it.
  const samplerPath = sources.samplerPath ?? join(packageRoot, 'build', 'process-sampler.exe')
  if (existsSync(samplerPath)) cpSync(samplerPath, join(stageDir, 'process-sampler.exe'))

  // One worker.py in this repository. The client owns it; the host ships a
  // copy of that exact file so a remote result and a local result match.
  const worker = join(repoRoot, 'apps', 'electron', 'resources', 'speaker-linking')
  mkdirSync(join(stageDir, 'resources', 'speaker-linking'), { recursive: true })
  for (const file of ['worker.py', 'resource_policy.py', 'requirements.txt']) {
    cpSync(join(worker, file), join(stageDir, 'resources', 'speaker-linking', file))
  }

  // The service is plain Node with no dependencies, so the runtime is one file.
  cpSync(nodePath, join(stageDir, 'node.exe'))
  // The tray icon: the only thing that stays running on the gamestation.
  cpSync(trayPath, join(stageDir, 'HiDockModelHost.exe'))
  return stageDir
}

function main() {
  const makensis = findMakensis()
  if (!makensis) {
    console.error(
      'makensis was not found. Build the client installer once (npm run build:win in\n' +
      'apps/electron), which downloads NSIS, or set MAKENSIS_PATH.'
    )
    process.exitCode = 1
    return
  }

  const stageDir = join(packageRoot, 'build', 'stage')
  const outDir = join(packageRoot, 'build')
  const outFile = join(outDir, `HiDock-Model-Host-${version}-Setup.exe`)
  buildTray()
  buildSampler()
  stage(stageDir)
  mkdirSync(outDir, { recursive: true })

  execFileSync(
    makensis,
    [
      `/DVERSION=${version}`,
      `/DSTAGE=${stageDir}`,
      `/DOUTFILE=${outFile}`,
      join(packageRoot, 'installer', 'model-host.nsi'),
    ],
    { stdio: 'inherit' }
  )
  console.log(`\nBuilt ${outFile}`)
  console.log('It is NOT code-signed, so SmartScreen will warn on first run.')
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) main()
