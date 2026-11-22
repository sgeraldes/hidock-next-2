import { freemem, totalmem } from 'os'
/**
 * Start the host.
 *
 * It starts STOPPED. Installing something is not permission to start processing
 * or to hold a GPU, so the person opens the control page and presses Start.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { createHostServer, STEP_ASIDE } from './server.mjs'
import { WorkerJobs } from './jobs.mjs'
import { HostState } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { DEFAULTS, detectGpu, loadConfig, loadSecrets, loadTokens, paths, saveSecrets, saveTokens, updateConfigFile } from './config.mjs'
import { HostSetup } from './host-setup.mjs'
import { runDiarization, threadEnv } from './diarize.mjs'
import { runVad } from './vad.mjs'
import { runAsr } from './asr.mjs'
import { NATIVE_DIARIZATION_MODEL, readyNativeDiarization, runNativeDiarization } from './native-diarization.mjs'
import { readyAsrModels, asrRuntimeFingerprint } from './asr-readiness.mjs'
import { DecideModels } from './decide.mjs'
import { nativeRealtimeRuntime } from './realtime-native-runtime.mjs'
import { readyRealtime } from './realtime-readiness.mjs'
import { REALTIME_MODEL } from './realtime-gateway.mjs'
import { SEMANTIC_MODEL, readySemanticEmbeddings, runSemanticEmbeddings } from './semantic-embeddings.mjs'
import { generationReadiness, runGeneration } from './generation.mjs'
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
  const assertNoPreparation = () => {
    if (['asr-preparing.lock', 'semantic-preparing.lock', 'generation-preparing.lock'].some(file => existsSync(join(dirs.root, file)))) {
      throw new Error('ASR preparation is in progress. Start the host after preparation finishes.')
    }
  }
  assertNoPreparation()
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
  const asrModels = readyAsrModels(config, pythonPath, (python, model) => asrRuntimeFingerprint(python, model, dirs.root))
  const nativeDiarizationModels = readyNativeDiarization(config, pythonPath, dirs.root) ? [NATIVE_DIARIZATION_MODEL] : []
  const semanticOptions = { pythonPath, workerPath,
    modelDir: join(dirs.models, 'nemotron-3-embed-1b'),
    siteDir: join(dirs.runtime, 'semantic-embeddings', 'site') }
  const semanticProfile = () => readySemanticEmbeddings(config.semanticEmbeddingValidation, semanticOptions)
    ? { ready: true, model: SEMANTIC_MODEL, dimensions: 2048, spaceId: config.semanticEmbeddingValidation.spaceId }
    : { ready: false }
  const realtimeAvailable = () => Boolean(gpu &&
    !existsSync(join(dirs.root, 'asr-preparing.lock')) && !existsSync(join(dirs.root, 'semantic-preparing.lock')) &&
    readyRealtime(config.realtimeAsrValidation, pythonPath, dirs.root))
  const startRealtime = nativeRealtimeRuntime({ pythonPath, workerPath, root: dirs.root })
  let generationCapability = await generationReadiness(dirs.root)
  const generationProfile = async () => {
    generationCapability = await generationReadiness(dirs.root)
    return generationCapability
  }

  // Clef and Clef-Flash, when setup installed their runtime (transformers, bitsandbytes).
  const decide = config.decideRuntime === true
    ? new DecideModels({
        pythonPath,
        workerPath: config.decideWorkerPath || join(here, 'decide_worker.py'),
        modelsDir: dirs.models,
        env: {
          ...threadEnv(config.cpuPercent),
          // Everything Hugging Face keeps stays under the host's folder, and the weights are
          // not stored twice: the models folder is the copy.
          HF_HOME: join(dirs.models, 'hf-home'),
          HF_XET_CHUNK_CACHE_SIZE_BYTES: '0',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
        log: console.log,
      })
    : null

  const state = new HostState({
    onLeaveReady: async () => {
      // Stop has to mean something to a job already running.
      state.activeJob?.abort()
      await decide?.stop()
    },
  })
  const pairing = new PairingStore({
    persisted: loadTokens(dirs.tokens),
    save: (tokens, meta) => saveTokens(tokens, dirs.tokens, meta),
  })

  const jobOptions = () => {
    assertNoPreparation()
    return ({
    pythonPath,
    hostRoot: dirs.root,
    workerPath,
    model: config.model,
    fallbackModel: config.fallbackModel,
    minSpeechSeconds: config.minSpeechSeconds,
    cpuPercent: config.cpuPercent,
    timeoutMs: config.timeoutMs,
    hfToken: setup.token() || process.env.HF_TOKEN,
    ffmpegPath,
  }) }
  // The last step of setup happens here, with the token HiDock sends.
  const setup = new HostSetup({
    validated: config.validated === true && existsSync(workerPath),
    validatedDevice: config.validatedDevice === 'cuda' && !gpu ? '' : config.validatedDevice,
    hfToken: config.hfToken,
    diarize: (audio, opts) => decide
      ? decide.withAudio(() => (options.diarize || runDiarization)(audio, opts), opts)
      : (options.diarize || runDiarization)(audio, opts),
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
    prepareSemantic: () => process.exit(86),
    prepareRealtime: () => process.exit(87),
    prepareGeneration: () => process.exit(88),
    prepareAsr: (model) => {
      // Fixed tray operations, never a caller-provided executable or command.
      const codes = { 'microsoft/VibeVoice-ASR': 77, 'nvidia/parakeet-tdt-0.6b-v3': 78, 'Qwen/Qwen3-ASR-0.6B': 79,
        'moondream/parakeet-ultra': 80, 'Qwen/Qwen3-ASR-1.7B': 81, 'nvidia/nemotron-3.5-asr-streaming-0.6b': 82,
        'OpenMOSS-Team/MOSS-Transcribe-Diarize': 83, [NATIVE_DIARIZATION_MODEL]: 84, 'Edge0/Audio8-ASR-Infinite': 85 }
      process.exit(codes[model] || 76)
    },
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

  const jobs = new WorkerJobs({ directory: join(dirs.root, 'jobs'), state,
    execute: (audio, options) => {
      const action = () => options.stage === 'vad' ? runVad(audio, options)
        : options.stage === 'transcription' ? runAsr(audio, options)
        : options.model === NATIVE_DIARIZATION_MODEL ? runNativeDiarization(audio, options) : runDiarization(audio, options)
      return decide ? decide.withAudio(action, options) : action()
    },
    options: jobOptions })
  let server
  let controlServer
  try {
  await jobs.initialize()
  const tls = config.tlsCertPath && config.tlsKeyPath
    ? { cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath), minVersion: 'TLSv1.2' }
    : undefined
  server = createHostServer({
    jobs, tls,
    generation: { profile: generationProfile, run: (request, options) => {
      const action = () => runGeneration(request, { ...jobOptions(), root: dirs.root, pythonPath, workerPath, ...options })
      return decide ? decide.withAudio(action, options) : action()
    } },
    realtime: { available: realtimeAvailable,
      startRuntime: options => decide ? decide.withAudio(() => startRealtime(options), options) : startRealtime(options) },
    semantic: { profile: semanticProfile,
      run: (request, options) => {
        const action = () => runSemanticEmbeddings(request, { ...jobOptions(), ...semanticOptions, ...options })
        return decide ? decide.withAudio(action, options) : action()
      } },
    state,
    pairing,
    setup,
    stepAside: stepAsideStore,
    maintenance,
    ...(decide ? { decide } : {}),
    capabilities: () => ({
      // `diarize` only after the model ran on this machine: a green light
      // that never ran the model is how a host refuses every job while
      // claiming it can do them. `decide` means the runtime is installed; /health
      // says which model is on disk.
      capabilities: [...(setup.canDiarize() ? ['diarize'] : []),
        ...(ffmpegPath && existsSync(ffmpegPath) ? ['vad'] : []), ...(decide ? ['decide'] : []),
        ...(semanticProfile().ready ? ['embed'] : []), ...(generationCapability.ready ? ['generate', 'chat'] : [])],
      semanticEmbedding: semanticProfile(),
      textGeneration: generationCapability,
      realtimeAsrModels: realtimeAvailable() ? [REALTIME_MODEL] : [],
      asrModels,
      audioChannels: { version: 1, separate: true, maxChannels: 2, activeChannelSelection: true, sourceRolesRequireEvidence: true },
      diarizationModels: [...(setup.canDiarize() ? ['pyannote/speaker-diarization-3.1', 'pyannote/speaker-diarization-community-1'] : []), ...nativeDiarizationModels],
      engines: asrModels.map(model => ({ model, version: config.asrValidation[model].modelVersion,
        lastValidatedDevice: config.asrValidation[model].device, testedAt: config.asrValidation[model].testedAt })),
      memory: { availableBytes: freemem(), totalBytes: totalmem() },
      gpu,
      // Say it plainly rather than letting a green light imply acceleration
      // that is not there.
      acceleration: setup.report().device || 'unverified',
      paired: pairing.tokens.size,
    }),
    jobOptions,
  })

  // Every interface by default, because HiDock is on another machine. Tests bind
  // to loopback: Windows Firewall asks nothing for a loopback-only listener.
  controlServer = tls ? createServer((req, res) => server.emit('request', req, res)) : null
  // The tray's HTTP control channel never leaves loopback. Remote clients use TLS.
  if (controlServer) {
    await new Promise((resolve, reject) => {
      controlServer.once('error', reject)
      controlServer.listen(config.port, '127.0.0.1', resolve)
    })
    server.once('close', () => controlServer.close())
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(tls ? (config.tlsPort || config.port + 1) : config.port, config.bindAddress || undefined, resolve)
  })
  const address = server.address()
  console.log(`[host] listening on ${address.port}, state ${state.publicState()}`)
  if (!gpu) {
    console.log('[host] no NVIDIA driver answered; work would run on the CPU')
  }
  pairing.startAutomatic()
  if (pairing.automatic().open) console.log('[host] automatic pairing is open for 5 minutes')
  setup.start()
  if (options.startReady) await state.apply('start')
  return { server, state, pairing, setup, decide, config, port: address.port }
  } catch (error) {
    jobs.close()
    decide?.stop()
    await Promise.all([server, controlServer].filter(Boolean).map(listener => new Promise(resolve => {
      listener.close(() => resolve())
      listener.closeAllConnections?.()
    })))
    throw error
  }
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
