/**
 * Start the host.
 *
 * It starts STOPPED. Installing something is not permission to start processing
 * or to hold a GPU, so the person opens the control page and presses Start.
 */

import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHostServer } from './server.mjs'
import { HostState, READY } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { DEFAULTS, detectGpu, loadConfig, loadTokens, paths, saveTokens } from './config.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function resolvePython(configured, dirs) {
  if (configured) return configured
  const bundled = join(dirs.runtime, 'python', 'python.exe')
  if (existsSync(bundled)) return bundled
  return process.platform === 'win32' ? 'py' : 'python3'
}

/**
 * The diarization worker.
 *
 * Installed next to the host, and in a checkout the file does not exist there:
 * the installer copies it out of the client's resources at build time so there
 * is one worker.py in this repository rather than two that drift apart. In a
 * checkout the client's copy IS the file, so development uses it directly.
 */
function resolveWorker(configured) {
  if (configured) return configured
  const installed = join(here, '..', 'resources', 'speaker-linking', 'worker.py')
  if (existsSync(installed)) return installed
  return join(here, '..', '..', 'electron', 'resources', 'speaker-linking', 'worker.py')
}

export async function start(options = {}) {
  const dirs = paths(options.root)
  for (const dir of [dirs.root, dirs.models, dirs.runtime, dirs.logs]) {
    mkdirSync(dir, { recursive: true })
  }

  const config = { ...DEFAULTS, ...loadConfig(dirs.config), ...(options.overrides || {}) }
  const pythonPath = resolvePython(config.pythonPath, dirs)
  const workerPath = resolveWorker(config.workerPath)
  const gpu = await detectGpu()

  const state = new HostState({
    onLeaveReady: async () => {
      // Pause and Stop have to mean something to a job already running.
      state.activeJob?.abort()
    },
  })
  const pairing = new PairingStore({
    persisted: loadTokens(dirs.tokens),
    save: (tokens) => saveTokens(tokens, dirs.tokens),
  })

  const server = createHostServer({
    state,
    pairing,
    capabilities: () => ({
      capabilities: existsSync(workerPath) ? ['diarize'] : [],
      gpu,
      // Say it plainly rather than letting a green light imply acceleration
      // that is not there.
      acceleration: gpu ? 'cuda' : 'cpu',
      paired: pairing.tokens.size,
    }),
    jobOptions: () => ({
      pythonPath,
      workerPath,
      model: config.model,
      fallbackModel: config.fallbackModel,
      minSpeechSeconds: config.minSpeechSeconds,
      cpuPercent: config.cpuPercent,
      timeoutMs: config.timeoutMs,
      hfToken: config.hfToken || process.env.HF_TOKEN,
      ffmpegPath: config.ffmpegPath || process.env.FFMPEG_PATH,
    }),
  })

  await new Promise((resolve) => server.listen(config.port, resolve))
  const address = server.address()
  console.log(`[host] listening on ${address.port}, state ${state.publicState()}`)
  console.log(`[host] control page: http://localhost:${address.port}/`)
  if (!gpu) {
    console.log('[host] no NVIDIA driver answered; work would run on the CPU')
  }
  if (options.startReady) await state.apply('start')
  return { server, state, pairing, config, port: address.port }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  start({ startReady: process.argv.includes('--ready') }).catch((error) => {
    console.error('[host] failed to start:', error.message)
    process.exitCode = 1
  })
}
