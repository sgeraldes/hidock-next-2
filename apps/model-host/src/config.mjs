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

/**
 * Parse a JSON file that setup.ps1 may have written. Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` starts the file with a byte-order mark, which
 * JSON.parse rejects; the host then started unvalidated and without its token.
 */
function readJson(file) {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

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
  /** Empty: every interface. Tests use 127.0.0.1 so the firewall asks nothing. */
  bindAddress: '',
  /** Half the machine, the same share the client gives its own worker. */
  cpuPercent: 50,
  // 3.1 built the voice library; the client pins it on every job anyway.
  model: 'pyannote/speaker-diarization-3.1',
  fallbackModel: 'pyannote/speaker-diarization-3.1',
  minSpeechSeconds: 1.5,
  /** An hour: long enough for a long meeting on CPU, short enough to give up. */
  timeoutMs: 60 * 60 * 1000,
  hfToken: '',
  /**
   * True only after setup ran the model once on this machine. The host
   * advertises `diarize` only when this is set, so a setup that installed the
   * runtime and then failed validation does not leave a host claiming a
   * capability it never demonstrated.
   */
  validated: false,
  /**
   * When the tray icon stops the service: 'any-use' (keyboard or mouse in the
   * last 5 minutes, or a game), 'games' (a game or a full-screen app) or
   * 'never'. Set from HiDock; the gamestation has no settings of its own.
   */
  stepAside: 'games',
  pythonPath: '',
  workerPath: '',
  ffmpegPath: '',
}

/**
 * The Hugging Face token, kept out of config.json.
 *
 * config.json is written with default ACLs and is read by anything that can
 * read the folder. A token that grants repository access does not belong
 * there, so setup writes it to its own file with the ACL narrowed to the
 * installing account.
 */
export function loadSecrets(file = join(hostRoot(), 'secrets.json')) {
  if (!existsSync(file)) return { hfToken: '' }
  try {
    const parsed = readJson(file)
    return { hfToken: typeof parsed.hfToken === 'string' ? parsed.hfToken : '' }
  } catch {
    console.warn('[host] secrets.json could not be read')
    return { hfToken: '' }
  }
}

export function loadConfig(file = paths().config) {
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...readJson(file) }
  } catch {
    // A corrupt config must not stop the host from starting; it starts on the
    // defaults and says so in the log.
    console.warn('[host] config.json could not be read; using defaults')
    return { ...DEFAULTS }
  }
}

/**
 * Merge a few keys into config.json, keeping everything else in it: setup
 * wrote the runtime paths there, and the tray icon reads `stepAside` from it.
 */
export function updateConfigFile(patch, file = paths().config) {
  let current = {}
  if (existsSync(file)) {
    try {
      current = readJson(file)
    } catch {
      // Refuse rather than replace a config we cannot read with one that has
      // only this patch in it: that would lose the runtime paths.
      throw Object.assign(new Error('config.json could not be read, so it was not changed'), { status: 500 })
    }
  }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8')
}

/**
 * The Hugging Face token HiDock sent. Its own file, so config.json (which the
 * tray icon reads) never holds it; the folder is under the user's
 * %LOCALAPPDATA%, which only that account, SYSTEM and administrators can read.
 */
export function saveSecrets(hfToken, file = join(hostRoot(), 'secrets.json')) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ hfToken }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export function saveTokens(tokens, file = paths().tokens, meta = {}) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ tokens, ...meta }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export function loadTokens(file = paths().tokens) {
  if (!existsSync(file)) return { tokens: [] }
  try {
    const parsed = readJson(file)
    return {
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      autoPairingCancelled: parsed.autoPairingCancelled === true,
    }
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
