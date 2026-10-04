/**
 * Borrow the diarization worker from the machine that has the GPU.
 *
 * This client machine has an AMD card, so every `cuda:0` in the local worker
 * quietly runs on the CPU. The Model Host runs the SAME worker.py on the
 * gamestation and returns the same object, so nothing downstream can tell which
 * machine produced a result.
 *
 * Everything here is written so the host being off changes nothing. A host that
 * does not answer, is paused, is busy, or fails mid-job sends the recording
 * back to the local worker, which is what happens today when there is no host
 * at all.
 */

import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import type { AcousticWorkerResult } from './speaker-linking'
import type { JevQuestion, JevResponse, JevStructured } from './jev-client'
import type {
  ModelHostDiagnostics,
  ModelHostHealthReport,
  ModelHostSetupReport,
  ModelHostStepAside,
} from '../../../src/shared/model-host-status'

export type { ModelHostDiagnostics }

/** The host answers health in well under a second on a LAN. */
const HEALTH_TIMEOUT_MS = 2000

/**
 * A 15 s answer covers a burst of backlog jobs without making pause changes wait
 * through a diarization: cancellation is checked every second, while every job
 * has at least a 30 s budget. The job endpoint remains authoritative between
 * refreshes and returns its own pause/busy reason.
 */
export const MODEL_HOST_HEALTH_CACHE_MS = 15_000

type CachedHealth = {
  key: string
  expiresAt: number
  health: ModelHostHealth | null
}

let cachedHealth: CachedHealth | null = null
let pendingHealth: { key: string; result: Promise<ModelHostHealth | null> } | null = null

/** Clear the process-wide health answer after a host job proves it is stale. */
function invalidateModelHostHealthCache(): void {
  cachedHealth = null
}

/** Exported for tests, which must not retain a prior host's answer. */
export function resetModelHostHealthCache(): void {
  cachedHealth = null
  pendingHealth = null
}

export interface ModelHostSettings {
  /** Empty means there is no host and none of this runs. */
  url: string
  token: string
}

/**
 * What /health says. `gpu` null means the host looked and found no NVIDIA
 * driver; absent means this machine is not paired yet and was not told. Those
 * are different sentences to the person. From host 0.3.0, a paired client also
 * hears how setup is going, when it steps aside, and the pairing window.
 */
export type ModelHostHealth = ModelHostHealthReport

/** Why the recording is not going to the host. Always a sentence for a person. */
export class ModelHostUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelHostUnavailableError'
  }
}

function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Is the host there and willing?
 *
 * Returns null rather than throwing, because "no host" is the ordinary case on
 * a machine that never had one and must not read as an error.
 */
export async function checkModelHost(
  settings: ModelHostSettings,
  fetchFn: typeof fetch = fetch,
  options: { forceRefresh?: boolean } = {}
): Promise<ModelHostHealth | null> {
  const base = normalizeBase(settings.url)
  if (!base) return null

  const key = `${base}\n${settings.token}`
  const now = Date.now()
  if (!options.forceRefresh && cachedHealth?.key === key && cachedHealth.expiresAt > now) {
    return cachedHealth.health
  }
  if (!options.forceRefresh && pendingHealth?.key === key) return pendingHealth.result

  const result = (async () => {
    let health: ModelHostHealth | null = null
    try {
      const response = await fetchFn(`${base}/health`, {
        // A stranger gets only the version and the state. The GPU, its driver
        // and how many clients are paired are reconnaissance, so the host hands
        // them to a paired client and nobody else.
        headers: settings.token ? { authorization: `Bearer ${settings.token}` } : {},
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      if (response.ok) {
        const candidate = (await response.json()) as ModelHostHealth
        if (Array.isArray(candidate.capabilities)) health = candidate
      }
    } catch {
      // An unavailable host is an ordinary fallback condition.
    }
    cachedHealth = { key, health, expiresAt: Date.now() + MODEL_HOST_HEALTH_CACHE_MS }
    return health
  })()

  pendingHealth = { key, result }
  void result.finally(() => {
    if (pendingHealth?.result === result) pendingHealth = null
  })
  return result
}

/** Trade a code shown on the host for a token this machine keeps. */
export async function pairWithModelHost(
  url: string,
  code: string,
  fetchFn: typeof fetch = fetch
): Promise<{ token: string }> {
  const base = normalizeBase(url)
  if (!base) throw new Error('Enter the host address first.')
  const response = await fetchFn(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim() }),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 5),
  })
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!response.ok || !body.token) {
    throw new Error(body.error || `The host refused the code (HTTP ${response.status}).`)
  }
  return { token: body.token }
}

async function putToHost<T>(
  settings: ModelHostSettings,
  path: string,
  body: unknown,
  fetchFn: typeof fetch
): Promise<T> {
  const base = normalizeBase(settings.url)
  if (!base) throw new Error('No model host is configured.')
  const response = await fetchFn(`${base}${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 5),
  })
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(answer.error || `The model host refused it (HTTP ${response.status}).`)
  invalidateModelHostHealthCache()
  return answer
}

/**
 * Hand the host this computer's Hugging Face token. HiDock is in charge: the
 * person never looks for a token on the gamestation. The host keeps it, runs
 * the voice model once, and only then offers to diarize.
 */
export async function sendHfTokenToModelHost(
  settings: ModelHostSettings,
  hfToken: string,
  fetchFn: typeof fetch = fetch
): Promise<ModelHostSetupReport> {
  const answer = await putToHost<{ setup: ModelHostSetupReport }>(settings, '/secrets/hf-token', { token: hfToken }, fetchFn)
  return answer.setup
}

/** When the gamestation's tray icon stops the service: any use, games, or never. */
export async function setModelHostStepAside(
  settings: ModelHostSettings,
  value: ModelHostStepAside,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await putToHost(settings, '/settings/step-aside', { value }, fetchFn)
}

async function callHost<T>(
  settings: ModelHostSettings,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: BodyInit | undefined,
  fetchFn: typeof fetch,
  timeoutMs = HEALTH_TIMEOUT_MS * 30
): Promise<T> {
  const base = normalizeBase(settings.url)
  if (!base) throw new Error('No model host is configured.')
  const response = await fetchFn(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${settings.token}` },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (response.status === 404) {
    throw new Error('The host is older than 0.3.1 and cannot do this. Install 0.3.1 on it once; after that HiDock updates it.')
  }
  if (!response.ok) throw new Error(answer.error || `The model host refused it (HTTP ${response.status}).`)
  invalidateModelHostHealthCache()
  return answer
}

/** The host's logs and CUDA check, read over the paired connection. */
export async function getModelHostDiagnostics(
  settings: ModelHostSettings,
  fetchFn: typeof fetch = fetch
): Promise<ModelHostDiagnostics> {
  return callHost<ModelHostDiagnostics>(settings, 'GET', '/diagnostics', undefined, fetchFn)
}

/** Ask the host to reinstall the CUDA build of torch; it answers at once and tests the model after. */
export async function repairModelHostRuntime(
  settings: ModelHostSettings,
  fetchFn: typeof fetch = fetch
): Promise<ModelHostSetupReport> {
  const answer = await callHost<{ setup: ModelHostSetupReport }>(settings, 'POST', '/runtime/repair', undefined, fetchFn)
  return answer.setup
}

/**
 * Send the host a new version of itself. Only a Model Host installer: the host
 * runs what it receives, which is why only its paired HiDock may send it.
 */
export async function sendModelHostUpdate(
  settings: ModelHostSettings,
  installerPath: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (!/^HiDock-Model-Host-\d+\.\d+\.\d+-Setup\.exe$/.test(basename(installerPath))) {
    throw new Error('That is not a Model Host installer (HiDock-Model-Host-<version>-Setup.exe).')
  }
  const installer = await readFile(installerPath)
  await callHost(settings, 'PUT', '/update', installer, fetchFn, 5 * 60 * 1000)
}

/** The decision models the host can run: Cloudflare's Clef (27B, 4-bit) and Clef-Flash (9B). */
export type ModelHostDecisionModel = 'clef' | 'clef-flash'

export interface ModelHostDecisionRequest {
  model: ModelHostDecisionModel
  state: JevStructured
  questions: Record<string, JevQuestion>
}

/** A decision the host did not answer, with its HTTP status and, for 503, where each model is. */
export class ModelHostDecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly decide?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ModelHostDecisionError'
  }
}

/**
 * Ask Clef or Clef-Flash on the host. The body and the answer are Jev's (`/v1/systemone`), so a
 * caller can send the same questions to either. The first request for a model starts its
 * download on the host and comes back 503 with the progress; the first one after a download, or
 * after the host let the model go, waits while it loads, which is why the timeout is long.
 */
export async function decideOnModelHost(
  settings: ModelHostSettings,
  request: ModelHostDecisionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15 * 60 * 1000
): Promise<JevResponse> {
  const base = normalizeBase(settings.url)
  if (!base) throw new ModelHostDecisionError('No model host is configured.', 0)
  const response = await fetchFn(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const answer = (await response.json().catch(() => ({}))) as JevResponse & {
    error?: string
    decide?: Record<string, unknown>
  }
  if (response.status === 404) {
    throw new ModelHostDecisionError(
      'The host has no decision models: it is older than 0.4.0, or its setup did not install them (see its diagnostics).',
      404
    )
  }
  if (!response.ok) {
    throw new ModelHostDecisionError(
      answer.error || `The model host refused it (HTTP ${response.status}).`,
      response.status,
      answer.decide
    )
  }
  return answer
}

/**
 * Run diarization on the host.
 *
 * Throws ModelHostUnavailableError for every reason the caller should answer by
 * running locally, and a plain Error only for a result that came back and was
 * wrong, which is a bug worth seeing rather than hiding behind a fallback.
 */
export async function diarizeOnModelHost(
  audioPath: string,
  settings: ModelHostSettings,
  options: {
    timeoutMs: number
    shouldContinue?: () => boolean
    /** The voice model the library needs; the host runs this one, with no fallback. */
    model?: string
  },
  fetchFn: typeof fetch = fetch
): Promise<AcousticWorkerResult> {
  const base = normalizeBase(settings.url)
  if (!base) throw new ModelHostUnavailableError('No model host is configured.')
  if (!settings.token) {
    throw new ModelHostUnavailableError('This machine is not paired with the model host.')
  }

  const health = await checkModelHost(settings, fetchFn)
  if (!health) throw new ModelHostUnavailableError('The model host did not answer.')
  if (!health.capabilities.includes('diarize')) {
    throw new ModelHostUnavailableError('The model host cannot diarize; its setup has not finished.')
  }
  if (health.state !== 'ready') {
    throw new ModelHostUnavailableError(
      health.reason || `The model host is ${health.state}.`
    )
  }

  const audio = await readFile(audioPath)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  // An exclusion committed while the upload is in flight has to stop it: the
  // audio is leaving this machine, and "cancelled" must mean cancelled.
  const watch = options.shouldContinue
    ? setInterval(() => {
        if (!options.shouldContinue?.()) controller.abort()
      }, 1000)
    : null

  try {
    const response = await fetchFn(
      `${base}/jobs/diarize?ext=${encodeURIComponent(extname(audioPath) || '.wav')}` +
        (options.model ? `&model=${encodeURIComponent(options.model)}` : ''),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/octet-stream',
        },
        body: audio,
        signal: controller.signal,
      }
    )

    if (response.status === 401) {
      throw new ModelHostUnavailableError('The model host no longer recognises this machine. Pair it again.')
    }
    if (response.status === 429 || response.status === 503) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      throw new ModelHostUnavailableError(body.error || 'The model host is not free right now.')
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      // The host ran the worker and it failed. Locally it would most likely
      // fail the same way, but the local run costs nothing but time, so this
      // is still a reason to fall back rather than to fail the recording.
      throw new ModelHostUnavailableError(
        body.error || `The model host failed the job (HTTP ${response.status}).`
      )
    }

    const result = (await response.json()) as AcousticWorkerResult
    if (
      !result.model ||
      !result.modelVersion ||
      !Array.isArray(result.segments) ||
      !Array.isArray(result.speakers)
    ) {
      throw new Error('the model host returned an incomplete diarization result')
    }
    return result
  } catch (error) {
    // The job is the current authority on the host. Its failure can mean a pause,
    // a new busy worker, or a revoked token, so the next recording refreshes health.
    invalidateModelHostHealthCache()
    if (error instanceof ModelHostUnavailableError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelHostUnavailableError('The model host took too long, or the recording was cancelled.')
    }
    if (error instanceof Error && /incomplete diarization result/.test(error.message)) throw error
    throw new ModelHostUnavailableError(
      `The model host could not be reached: ${(error as Error).message}`
    )
  } finally {
    clearTimeout(timer)
    if (watch) clearInterval(watch)
  }
}
