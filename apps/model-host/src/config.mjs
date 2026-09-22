/**
 * Where the host keeps its things, and what it will admit about the machine.
 *
 * Binaries, model assets and credentials live in separate directories so an
 * uninstall can take the program without taking the models, and a reinstall
 * does not walk over a paired client's token.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const DEFAULT_PORT = 8765

export function hostRoot() {
  if (process.env.HIDOCK_HOST_ROOT) return process.env.HIDOCK_HOST_ROOT
  const base =
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'HiDock Model Host')
}

export function paths(root = hostRoot()) {
  return {
    root,
    config: join(root, 'config.json'),
    tokens: join(root, 'tokens.json'),
    models: join(root, 'models'),
    runtime: join(root, 'runtime'),
    logs: join(root, 'logs'),
  }
}

export const DEFAULTS = {
  port: DEFAULT_PORT,
  /** Half the machine, the same share the client gives its own worker. */
  cpuPercent: 50,
  model: 'pyannote/speaker-diarization-community-1',
  fallbackModel: 'pyannote/speaker-diarization-3.1',
  minSpeechSeconds: 1.5,
  /** An hour: long enough for a long meeting on CPU, short enough to give up. */
  timeoutMs: 60 * 60 * 1000,
  hfToken: '',
  pythonPath: '',
  workerPath: '',
  ffmpegPath: '',
}

export function loadConfig(file = paths().config) {
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    // A corrupt config must not stop the host from starting; it starts on the
    // defaults and says so in the log.
    console.warn('[host] config.json could not be read; using defaults')
    return { ...DEFAULTS }
  }
}

export function saveTokens(tokens, file = paths().tokens) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ tokens }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export function loadTokens(file = paths().tokens) {
  if (!existsSync(file)) return { tokens: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] }
  } catch {
    return { tokens: [] }
  }
}

/**
 * What GPU is actually here, asked of the driver rather than assumed.
 *
 * A vendor name is not a capability: the client machine has an AMD card and
 * every `cuda:0` in this codebase silently runs on its CPU. So the host reports
 * what nvidia-smi says, and reports nothing when nvidia-smi is not there.
 */
export async function detectGpu(run = execFileAsync) {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ])
    const [name, memoryMiB, driver] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim())
    return { name, vramMiB: Number(memoryMiB) || null, driver }
  } catch {
    return null
  }
}
