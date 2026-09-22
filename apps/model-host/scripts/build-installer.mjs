/**
 * Build HiDock-Model-Host-<version>-Setup.exe.
 *
 * The payload is deliberately small: the host's own source, a copy of Node to
 * run it, and the diarization worker. Everything heavy — the CUDA build of
 * torch, pyannote, the model weights — arrives on first run, where the person
 * can see the size, cancel and retry.
 *
 * makensis comes from electron-builder's cache, which the client app already
 * populates when it builds its own installer. No second toolchain.
 */

import { execFileSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

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

export function stage(stageDir) {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  cpSync(join(packageRoot, 'src'), join(stageDir, 'src'), { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(stageDir, 'package.json'))
  cpSync(join(packageRoot, 'installer', 'setup.ps1'), join(stageDir, 'setup.ps1'))

  // One worker.py in this repository. The client owns it; the host ships a
  // copy of that exact file so a remote result and a local result match.
  const worker = join(repoRoot, 'apps', 'electron', 'resources', 'speaker-linking')
  mkdirSync(join(stageDir, 'resources', 'speaker-linking'), { recursive: true })
  for (const file of ['worker.py', 'requirements.txt']) {
    cpSync(join(worker, file), join(stageDir, 'resources', 'speaker-linking', file))
  }

  // The host is plain Node with no dependencies, so the runtime is one file.
  cpSync(process.execPath, join(stageDir, 'node.exe'))

  writeFileSync(
    join(stageDir, 'Start Model Host.cmd'),
    [
      '@echo off',
      'rem Starts the host and opens its control page. It starts STOPPED:',
      'rem nothing runs on the GPU until you press Start on that page.',
      'cd /d "%~dp0"',
      'start "" http://localhost:8765/',
      '"%~dp0node.exe" "%~dp0src\\main.mjs"',
      '',
    ].join('\r\n'),
    'utf8'
  )
  writeFileSync(
    join(stageDir, 'Set up Model Host.cmd'),
    [
      '@echo off',
      'rem First run: hardware check, private Python, torch, pyannote, and a',
      'rem synthetic clip to prove the chain works on THIS machine.',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"',
      'pause',
      '',
    ].join('\r\n'),
    'utf8'
  )
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
