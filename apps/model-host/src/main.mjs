/**
 * Start the host.
 *
 * It starts STOPPED. Installing something is not permission to start processing
 * or to hold a GPU, so the person opens the control page and presses Start.
 */

import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHostServer, STEP_ASIDE } from './server.mjs'
import { HostState } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { DEFAULTS, detectGpu, loadConfig, loadSecrets, loadTokens, paths, saveSecrets, saveTokens, updateConfigFile } from './config.mjs'
import { HostSetup } from './host-setup.mjs'
import { runDiarization } from './diarize.mjs'
import { collectDiagnostics, repairRuntime, stageUpdate, UPDATE_EXIT_CODE } from './maintenance.mjs'

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

/**
 * The ffmpeg the worker decodes with. The installer ships one next to the
 * host because a GPU machine bought for games has no reason to have one on
 * PATH, and without it every job failed and went back to the client's CPU.
 * Empty means the worker searches PATH itself.
 */
export function resolveFfmpeg(
  configured,
  installDir = join(here, '..'),
  env = process.env,
  exists = existsSync
) {
  if (configured) return configured
  const bundled = join(installDir, 'ffmpeg.exe')
  if (exists(bundled)) return bundled
  return env.FFMPEG_PATH || ''
}

export async function start(options = {}) {
  const dirs = paths(options.root)
  for (const dir of [dirs.root, dirs.models, dirs.runtime, dirs.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  const secretsFile = join(dirs.root, 'secrets.json')

  const config = {
    ...DEFAULTS,
    ...loadConfig(dirs.config),
    ...loadSecrets(secretsFile),
    ...(options.overrides || {}),
  }
  const pythonPath = resolvePython(config.pythonPath, dirs)
  const workerPath = resolveWorker(config.workerPath)
  const ffmpegPath = resolveFfmpeg(config.ffmpegPath)
  const gpu = await detectGpu()

  const state = new HostState({
    onLeaveReady: async () => {
      // Stop has to mean something to a job already running.
      state.activeJob?.abort()
    },
  })
  const pairing = new PairingStore({
    persisted: loadTokens(dirs.tokens),
    save: (tokens, meta) => saveTokens(tokens, dirs.tokens, meta),
  })

  const jobOptions = () => ({
    pythonPath,
    workerPath,
    model: config.model,
    fallbackModel: config.fallbackModel,
    minSpeechSeconds: config.minSpeechSeconds,
    cpuPercent: config.cpuPercent,
    timeoutMs: config.timeoutMs,
    hfToken: setup.token() || process.env.HF_TOKEN,
    ffmpegPath,
  })
  // The last step of setup happens here, with the token HiDock sends.
  const setup = new HostSetup({
    validated: config.validated === true && existsSync(workerPath),
    hfToken: config.hfToken,
    diarize: options.diarize || runDiarization,
    jobOptions,
    saveToken: (token) => saveSecrets(token, secretsFile),
    saveValidated: (patch) => updateConfigFile(patch, dirs.config),
    // HiDock asks for this when the model ran on the CPU of a machine with a GPU.
    repair: () =>
      repairRuntime({
        pythonPath,
        constraintsPath: join(here, '..', 'constraints.txt'),
        logFile: join(dirs.logs, 'repair.log'),
      }),
    log: console.log,
  })
  const maintenance = {
    diagnostics: () => collectDiagnostics({ dirs, pythonPath }),
    stageUpdate: (body) => stageUpdate({ root: dirs.root }, body),
    // The tray icon sees this exit code, runs the staged installer, and the
    // installer starts it again.
    applyUpdate:
      options.applyUpdate ||
      (() => {
        console.log('[host] an update from HiDock is staged; handing over to the tray icon')
        process.exit(UPDATE_EXIT_CODE)
      }),
  }
  // HiDock's one setting; the tray icon reads it from config.json.
  let stepAside = STEP_ASIDE.has(config.stepAside) ? config.stepAside : 'games'
  const stepAsideStore = {
    get: () => stepAside,
    set: (value) => {
      updateConfigFile({ stepAside: value }, dirs.config)
      stepAside = value
      console.log(`[host] HiDock set when to step aside: ${value}`)
    },
  }

  const server = createHostServer({
    state,
    pairing,
    setup,
    stepAside: stepAsideStore,
    maintenance,
    capabilities: () => ({
      // `diarize` only after the model ran on this machine: a green light
      // that never ran the model is how a host refuses every job while
      // claiming it can do them.
      capabilities: setup.canDiarize() ? ['diarize'] : [],
      gpu,
      // Say it plainly rather than letting a green light imply acceleration
      // that is not there.
      acceleration: gpu ? 'cuda' : 'cpu',
      paired: pairing.tokens.size,
    }),
    jobOptions,
  })

  // Every interface by default, because HiDock is on another machine. Tests bind
  // to loopback: Windows Firewall asks nothing for a loopback-only listener.
  await new Promise((resolve) => server.listen(config.port, config.bindAddress || undefined, resolve))
  const address = server.address()
  console.log(`[host] listening on ${address.port}, state ${state.publicState()}`)
  if (!gpu) {
    console.log('[host] no NVIDIA driver answered; work would run on the CPU')
  }
  pairing.startAutomatic()
  if (pairing.automatic().open) console.log('[host] automatic pairing is open for 5 minutes')
  setup.start()
  if (options.startReady) await state.apply('start')
  return { server, state, pairing, setup, config, port: address.port }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  // The tray icon starts the service with --ready and stops it by ending its
  // Job Object; there is nothing to pause in here.
  start({ startReady: process.argv.includes('--ready') }).catch((error) => {
    console.error('[host] failed to start:', error.message)
    process.exitCode = 1
  })
}
