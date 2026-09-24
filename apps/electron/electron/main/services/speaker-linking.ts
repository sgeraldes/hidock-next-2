import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import { availableParallelism } from 'os'
import ffmpegPath from 'ffmpeg-static'
import { getConfig, getDataPath } from './config'
import { queryAll, queryOne, runInTransaction, runNoSave } from './database'
import { diarizeOnModelHost, ModelHostUnavailableError } from './model-host-client'
import { CANONICAL_VOICE_MODEL, resolveSpeakerEngine } from './speaker-engines'
import { detectHardware } from './hardware-profile'

/** Default share of logical CPUs when the config does not say. */
const DEFAULT_DIARIZATION_CPU_PERCENT = 40

/**
 * Thread-count environment for the diarization worker.
 *
 * pyannote/torch size their thread pools from the machine's CPU count, so one
 * recording on a 24-thread box takes ~12 threads and the desktop stutters for
 * the whole run — with a backlog, for hours. Every one of these variables is
 * read by a different layer of the stack (OpenMP, Intel MKL, OpenBLAS, NumExpr,
 * and the worker's own torch.set_num_threads), and missing one is enough for
 * that layer to go back to using every core.
 *
 * Exported for tests: the arithmetic matters (a 0 or negative thread count
 * makes OpenMP fall back to "all cores", the exact thing this prevents).
 */
export function diarizationThreadEnv(cpuPercent?: number): Record<string, string> {
  // availableParallelism, not cpus().length: it honours the process's CPU
  // affinity, so a host pinned to a subset of cores (the perf harness does
  // exactly that) budgets against what it can actually run on. Same call the
  // embedder worker uses.
  const total = Math.max(1, availableParallelism())
  const pct = Number.isFinite(cpuPercent) && (cpuPercent as number) > 0
    ? Math.min(100, cpuPercent as number)
    : DEFAULT_DIARIZATION_CPU_PERCENT
  const threads = String(Math.max(1, Math.min(total, Math.round((total * pct) / 100))))
  return {
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    TORCH_NUM_THREADS: threads,
    HIDOCK_DIARIZATION_THREADS: threads
  }
}

export interface AcousticSegment {
  start: number
  end: number
  speaker: string
}

export interface AcousticSpeaker {
  label: string
  embedding: number[]
  speechSeconds: number
  qualityScore?: number
}

export interface AcousticWorkerResult {
  model: string
  modelVersion: string
  device: string
  segments: AcousticSegment[]
  speakers: AcousticSpeaker[]
}

interface VoiceClusterRow {
  id: string
  model: string
  model_version: string
  embedding_dimension: number
  centroid_json: string
  observation_count: number
  total_speech_seconds: number
  contact_id: string | null
  contact_name: string | null
}

export interface VoiceMatch {
  localSpeakerLabel: string
  voiceClusterId: string
  stableLabel: string
  status: 'matched' | 'new' | 'needs_review'
  similarity: number | null
  runnerUpMargin: number | null
  contactId: string | null
  contactName: string | null
  speechSeconds: number
}

export interface SpeakerLinkingResult {
  available: boolean
  model: string
  modelVersion: string | null
  device: string | null
  segments: AcousticSegment[]
  matches: VoiceMatch[]
  reason?: string
}

export interface MatchDecision {
  clusterId: string | null
  similarity: number | null
  runnerUpMargin: number | null
  status: 'matched' | 'new' | 'needs_review'
}

export interface VoiceMatchCandidate {
  id: string
  centroid: number[]
  /** Present only after independent manual/self-identification evidence. */
  contactId?: string | null
}

/**
 * An independently confirmed person anchor needs a deliberately stricter
 * absolute gate than an anonymous-cluster match. Anonymous near-duplicates of
 * that same person must not erase the identity by consuming the raw runner-up
 * margin, but a competing DIFFERENT anchored person still must.
 */
export const ANCHORED_VOICE_MATCH_THRESHOLD = 0.9

export class SpeakerLinkingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpeakerLinkingUnavailableError'
  }
}

/**
 * Wall-clock budget for the acoustic worker. pyannote runs roughly 3-4x realtime on this
 * class of machine, so a flat cap silently fails every recording longer than about
 * cap/3.5: on 2026-09-15 a device backlog of 30 recordings was imported at once and the
 * 19 longer than ~34 minutes all died with "timed out after 600 seconds" (the 600 s
 * default) while every shorter one completed. The budget is therefore the configured
 * floor or 1.5x the audio length, whichever is larger; a recording with unknown length
 * keeps the floor.
 */
export function speakerLinkingTimeoutMs(
  configuredSeconds: number,
  audioDurationSeconds?: number | null
): number {
  const floor = Math.max(30, configuredSeconds || 0)
  const scaled = audioDurationSeconds && audioDurationSeconds > 0
    ? Math.ceil(audioDurationSeconds * 1.5)
    : 0
  return Math.max(floor, scaled) * 1000
}

/**
 * Local speaker linking is an optional enrichment stage. Environment/setup
 * failures must degrade to provider-managed diarization instead of preventing
 * the configured transcription provider from running.
 */
export function isSpeakerLinkingUnavailableDetail(detail: string): boolean {
  const unavailablePatterns = [
    /ModuleNotFoundError|No module named/i,
    /ImportError:|is required for a normal functioning/i,
    /FFmpeg is required .* not found/i,
    /GatedRepo|401|403|not authorized|cannot access gated/i
  ]
  return unavailablePatterns.some((pattern) => pattern.test(detail))
}

export function resolveSpeakerLinkingFfmpegPath(path: string | null): string | undefined {
  if (!path) return undefined
  // electron-builder unpacks native executables beside app.asar. Development
  // paths do not contain app.asar, so the replacement is harmless there.
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export function normalizeEmbedding(values: number[]): number[] {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return []
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) return []
  return values.map((value) => value / magnitude)
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1
  const a = normalizeEmbedding(left)
  const b = normalizeEmbedding(right)
  if (!a.length || !b.length) return -1
  return a.reduce((sum, value, index) => sum + value * b[index], 0)
}

export function decideVoiceMatch(
  embedding: number[],
  candidates: VoiceMatchCandidate[],
  threshold: number,
  requiredMargin: number,
  excludedClusterIds: ReadonlySet<string> = new Set()
): MatchDecision {
  const ranked = candidates
    .filter((candidate) => !excludedClusterIds.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, similarity: cosineSimilarity(embedding, candidate.centroid) }))
    .filter((candidate) => candidate.similarity >= -0.5)
    .sort((a, b) => b.similarity - a.similarity)
  if (!ranked.length) {
    return { clusterId: null, similarity: null, runnerUpMargin: null, status: 'new' }
  }
  const best = ranked[0]
  const margin = best.similarity - (ranked[1]?.similarity ?? -1)
  if (best.similarity >= threshold && margin >= requiredMargin) {
    return { clusterId: best.id, similarity: best.similarity, runnerUpMargin: margin, status: 'matched' }
  }

  // Once a voice has independent person evidence, compare its ambiguity
  // against OTHER known people rather than anonymous fragments. The previous
  // policy compared every near-duplicate UUID, so one false split made all
  // later observations ambiguous and minted another UUID on every call.
  const contactByCluster = new Map(candidates.map((candidate) => [candidate.id, candidate.contactId ?? null]))
  const bestByContact = new Map<string, { id: string; similarity: number }>()
  for (const candidate of ranked) {
    const contactId = contactByCluster.get(candidate.id)
    if (!contactId || bestByContact.has(contactId)) continue
    bestByContact.set(contactId, candidate)
  }
  const anchored = [...bestByContact.values()].sort((a, b) => b.similarity - a.similarity)
  const anchoredBest = anchored[0]
  if (anchoredBest) {
    const anchoredMargin = anchoredBest.similarity - (anchored[1]?.similarity ?? -1)
    if (
      anchoredBest.similarity >= Math.max(threshold, ANCHORED_VOICE_MATCH_THRESHOLD) &&
      anchoredMargin >= requiredMargin
    ) {
      return {
        clusterId: anchoredBest.id,
        similarity: anchoredBest.similarity,
        runnerUpMargin: anchoredMargin,
        status: 'matched'
      }
    }
  }
  return {
    clusterId: null,
    similarity: best.similarity,
    runnerUpMargin: margin,
    status: best.similarity >= threshold ? 'needs_review' : 'new'
  }
}

export function updateCentroid(
  previous: number[],
  previousWeight: number,
  observation: number[],
  observationWeight: number
): number[] {
  const a = normalizeEmbedding(previous)
  const b = normalizeEmbedding(observation)
  if (!a.length) return b
  if (!b.length || a.length !== b.length) return a
  const oldWeight = Math.max(0, previousWeight)
  const newWeight = Math.max(0.001, observationWeight)
  return normalizeEmbedding(a.map((value, index) =>
    ((value * oldWeight) + (b[index] * newWeight)) / (oldWeight + newWeight)
  ))
}

function resolveWorkerPath(configured: string): string {
  if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'speaker-linking', 'worker.py')
    if (existsSync(packaged)) return packaged
  }
  return join(process.cwd(), 'resources', 'speaker-linking', 'worker.py')
}

/**
 * Say the host is unavailable once, not once per recording.
 *
 * A backlog of two hundred recordings draining against a host that is switched
 * off would otherwise print two hundred identical lines and bury everything
 * else in the log.
 */
let lastModelHostComplaint = ''
/**
 * How many recordings are trying the host right now.
 *
 * Without this, one recording succeeding clears the complaint while another is
 * still failing, and the next failure prints the same line again. Two
 * recordings draining a backlog in parallel is the normal case, so the counter
 * is what makes "say it once" true rather than true-when-sequential.
 */
let remoteAttemptsInFlight = 0

/** Exported so a test can watch the same recording twice in one run. */
/** The model (and version) the library's voices were built with. */
export interface LibraryVoiceSpace {
  model: string
  modelVersion: string | null
  clusters: number
  anchored: number
  /** Voices from other models or versions: kept, but not matched until transferred. */
  otherModelClusters: number
  otherModelAnchored: number
}

/**
 * The embedding space of the existing voices: the model with the most
 * contact-anchored clusters, then the most clusters. Null for an empty library.
 *
 * Voice IDs match only within one model. Changing GPU or moving to the Model
 * Host does not change them (measured 24-sep: 35 voices matched across the
 * RTX 4090 and the CPU); changing the model does, silently. So the model that
 * writes voice evidence is pinned to this space.
 */
export function libraryVoiceSpace(): LibraryVoiceSpace | null {
  const row = queryOne<{ model: string; model_version: string | null; clusters: number; anchored: number }>(
    `SELECT model, model_version, COUNT(*) AS clusters,
            SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END) AS anchored
       FROM voice_clusters
      GROUP BY model, model_version
      ORDER BY anchored DESC, clusters DESC
      LIMIT 1`
  )
  if (!row) return null
  // Voices from any other model or version cannot match new recordings until a
  // model transfer brings them over (spec: canonical voice IDs). Counted so the
  // setup can say so instead of losing them silently.
  const other = queryOne<{ clusters: number; anchored: number }>(
    `SELECT COUNT(*) AS clusters, SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END) AS anchored
       FROM voice_clusters
      WHERE NOT (model = ? AND COALESCE(model_version, '') = COALESCE(?, ''))`,
    [row.model, row.model_version]
  )
  return {
    model: row.model,
    modelVersion: row.model_version,
    clusters: row.clusters,
    anchored: row.anchored ?? 0,
    otherModelClusters: other?.clusters ?? 0,
    otherModelAnchored: other?.anchored ?? 0
  }
}

/**
 * A result from a different model would start every voice from zero. Refuse it
 * rather than write it: the recording degrades to the transcriber's labels and
 * says why, and the library keeps its voices.
 */
export function assertInLibraryVoiceSpace(result: AcousticWorkerResult, space: LibraryVoiceSpace | null): void {
  if (!space) return
  if (result.model !== space.model) {
    throw new SpeakerLinkingUnavailableError(
      `voice model mismatch: this result came from ${result.model}, but the library's voices were built with ` +
        `${space.model}. Not writing it, so known voices keep matching.`
    )
  }
  if (space.modelVersion && result.modelVersion && result.modelVersion !== space.modelVersion) {
    console.warn(
      `[SpeakerLinking] voice model version changed: ${space.modelVersion} -> ${result.modelVersion}. ` +
        'New voices will not match voices from the old version until they are migrated.'
    )
  }
}

/** The model every engine must answer in: the library's, or the canonical default when it is empty. */
export function pinnedVoiceModel(): string {
  return libraryVoiceSpace()?.model ?? CANONICAL_VOICE_MODEL
}

export function resetModelHostComplaint(): void {
  lastModelHostComplaint = ''
  remoteAttemptsInFlight = 0
}

/**
 * Diarize on the model host when there is one, and here when there is not.
 *
 * Every reason the host does not produce a result — no host, not paired, off,
 * paused, busy, unreachable, the worker failed there — comes back as
 * ModelHostUnavailableError and ends in the local worker. The recording is
 * never failed because of the host.
 */
export async function diarize(
  audioPath: string,
  shouldContinue: () => boolean,
  audioDurationSeconds?: number | null,
  deps: {
    local?: typeof runWorker
    remote?: typeof diarizeOnModelHost
    /** Never ask the Model Host, even if one is paired (engine pyannote-local). */
    localOnly?: boolean
  } = {}
): Promise<AcousticWorkerResult> {
  const local = deps.local || runWorker
  const remote = deps.remote || diarizeOnModelHost
  const config = getConfig().transcription
  const url = config.modelHostUrl?.trim()
  if (!url || deps.localOnly) return local(audioPath, shouldContinue, audioDurationSeconds)

  remoteAttemptsInFlight += 1
  try {
    const result = await remote(
      audioPath,
      { url, token: config.modelHostToken || '' },
      {
        timeoutMs: speakerLinkingTimeoutMs(config.speakerLinkingTimeoutSeconds, audioDurationSeconds),
        shouldContinue,
        model: pinnedVoiceModel()
      }
    )
    // Only the last one out clears it. Clearing while another recording is
    // still failing would make the next failure repeat a line already said.
    if (remoteAttemptsInFlight === 1) lastModelHostComplaint = ''
    const pinned = pinnedVoiceModel()
    if (result.model !== pinned) {
      // A host from before model pinning ignores the request and runs its own model.
      console.warn(
        `[SpeakerLinking] the Model Host used ${result.model}, not ${pinned} like the library's voices. Diarizing here instead.`
      )
      return local(audioPath, shouldContinue, audioDurationSeconds)
    }
    console.log(`[SpeakerLinking] diarized on the model host (${result.device})`)
    return result
  } catch (error) {
    if (!(error instanceof ModelHostUnavailableError)) throw error
    if (lastModelHostComplaint !== error.message) {
      lastModelHostComplaint = error.message
      console.warn(`[SpeakerLinking] ${error.message} Diarizing here instead.`)
    }
    return local(audioPath, shouldContinue, audioDurationSeconds)
  } finally {
    remoteAttemptsInFlight -= 1
  }
}

function resolveVoicePython(): string {
  const configuredPython = getConfig().transcription.speakerLinkingPythonPath || (process.platform === 'win32' ? 'py' : 'python3')
  const localRuntime = process.platform === 'win32'
    ? join(process.cwd(), '.venv-speaker-linking', 'Scripts', 'python.exe')
    : join(process.cwd(), '.venv-speaker-linking', 'bin', 'python')
  return /^(py|python|python3)(\.exe)?$/i.test(configuredPython) && existsSync(localRuntime)
    ? localRuntime
    : configuredPython
}

/** Where the ONNX exports of the voice models live, next to the other local models. */
export function voiceOnnxDir(): string {
  return join(getDataPath(), 'models', 'voice-onnx-pyannote-3.1')
}

const VOICE_ONNX_FILES = ['wespeaker-resnet34-lm-masked.onnx', 'segmentation-3.0.onnx']

let voiceOnnxExport: Promise<void> | null = null

/**
 * Export the voice models to ONNX once, with the same Python environment that
 * already holds the pyannote weights (resources/speaker-linking/export_voice_onnx.py
 * checks each export against PyTorch before it is used). Later runs reuse the files.
 */
export function ensureVoiceOnnxModels(): Promise<void> {
  const dir = voiceOnnxDir()
  if (VOICE_ONNX_FILES.every((f) => existsSync(join(dir, f)))) return Promise.resolve()
  if (voiceOnnxExport) return voiceOnnxExport
  const exporter = join(dirname(resolveWorkerPath(getConfig().transcription.speakerLinkingWorkerPath)), 'export_voice_onnx.py')
  if (!existsSync(exporter)) {
    return Promise.reject(new SpeakerLinkingUnavailableError(`voice model exporter not found: ${exporter}`))
  }
  mkdirSync(dir, { recursive: true })
  const python = resolveVoicePython()
  console.log(`[SpeakerLinking] Exporting the voice models to ONNX in ${dir} (once)`)
  voiceOnnxExport = new Promise<void>((resolve, reject) => {
    const child = spawn(python, [exporter, dir], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', HF_TOKEN: getConfig().transcription.localAsrHfToken || process.env.HF_TOKEN }
    })
    let tail = ''
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new SpeakerLinkingUnavailableError(`voice model export could not start: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && VOICE_ONNX_FILES.every((f) => existsSync(join(dir, f)))) {
        console.log(`[SpeakerLinking] Voice models exported:\n${tail.trim()}`)
        resolve()
      } else {
        reject(new SpeakerLinkingUnavailableError(`voice model export failed (exit ${code}): ${tail.trim().slice(-600)}`))
      }
    })
  }).finally(() => {
    voiceOnnxExport = null
  })
  return voiceOnnxExport
}

let gpuPresent: Promise<boolean> | null = null

/** DirectML when this computer has any GPU; otherwise ONNX Runtime on the CPU. */
async function onnxProvider(): Promise<'dml' | 'cpu'> {
  gpuPresent ??= detectHardware()
    .then((h) => !h.detectionFailed && h.gpus.length > 0)
    .catch(() => false)
  return (await gpuPresent) ? 'dml' : 'cpu'
}

async function runOnnxWorker(
  audioPath: string,
  shouldContinue: () => boolean,
  audioDurationSeconds?: number | null
): Promise<AcousticWorkerResult> {
  await ensureVoiceOnnxModels()
  const provider = await onnxProvider()
  return runWorker(audioPath, shouldContinue, audioDurationSeconds, ['--engine', 'onnx', '--onnx-dir', voiceOnnxDir(), '--onnx-provider', provider])
}

function runWorker(
  audioPath: string,
  shouldContinue: () => boolean,
  audioDurationSeconds?: number | null,
  engineArgs: string[] = []
): Promise<AcousticWorkerResult> {
  const config = getConfig().transcription
  const workerPath = resolveWorkerPath(config.speakerLinkingWorkerPath)
  if (!existsSync(workerPath)) {
    return Promise.reject(new SpeakerLinkingUnavailableError(`speaker-linking worker not found: ${workerPath}`))
  }
  const python = resolveVoicePython()
  // The library's model, alone: a fallback to another model would not match its voices.
  const model = pinnedVoiceModel()
  const fallbackModel = model
  const args = [
    ...(process.platform === 'win32' && /(^|[\\/])py(?:\.exe)?$/i.test(python) ? ['-3.11'] : []),
    workerPath,
    '--audio', audioPath,
    '--model', model,
    '--fallback-model', fallbackModel,
    '--min-speech-seconds', String(config.speakerLinkingMinSpeechSeconds),
    ...engineArgs
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FFMPEG_PATH: resolveSpeakerLinkingFfmpegPath(ffmpegPath) || process.env.FFMPEG_PATH,
        HF_TOKEN: config.localAsrHfToken || process.env.HF_TOKEN,
        HUGGINGFACE_HUB_TOKEN: config.localAsrHfToken || process.env.HUGGINGFACE_HUB_TOKEN,
        ...diarizationThreadEnv(config.speakerLinkingCpuPercent)
      }
    })
    let stdout = ''
    let stderr = ''
    const cap = 25 * 1024 * 1024
    const timeoutMs = speakerLinkingTimeoutMs(config.speakerLinkingTimeoutSeconds, audioDurationSeconds)
    const timeout = setTimeout(() => {
      child.kill()
      // A timeout means the worker could not serve THIS recording in budget, not that the
      // audio is bad: degrade to provider-managed diarization instead of failing the
      // transcript (the transcript is the product, voice linking is the enhancement).
      reject(new SpeakerLinkingUnavailableError(
        `speaker-linking timed out after ${Math.round(timeoutMs / 1000)} seconds`
      ))
    }, timeoutMs)
    const cancellation = setInterval(() => {
      if (!shouldContinue()) {
        child.kill()
        clearTimeout(timeout)
        clearInterval(cancellation)
        reject(new Error('speaker-linking cancelled because recording became ineligible'))
      }
    }, 1000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < cap) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < cap) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      clearInterval(cancellation)
      reject(new SpeakerLinkingUnavailableError(`failed to start speaker-linking worker: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      clearInterval(cancellation)
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-12).join('\n') || `speaker-linking exited with code ${code}`
        if (isSpeakerLinkingUnavailableDetail(detail)) {
          reject(new SpeakerLinkingUnavailableError(detail))
        } else {
          reject(new Error(detail))
        }
        return
      }
      try {
        const parsed = JSON.parse(stdout) as AcousticWorkerResult
        if (!parsed.model || !parsed.modelVersion || !Array.isArray(parsed.segments) || !Array.isArray(parsed.speakers)) {
          throw new Error('worker returned an incomplete result')
        }
        resolve(parsed)
      } catch (error) {
        reject(new Error(`invalid speaker-linking worker output: ${(error as Error).message}`))
      }
    })
  })
}

function parseCentroid(row: VoiceClusterRow): number[] {
  try {
    const parsed = JSON.parse(row.centroid_json)
    return Array.isArray(parsed) ? parsed.map(Number) : []
  } catch {
    return []
  }
}

function stableVoiceLabel(clusterId: string): string {
  return `Voice ${clusterId.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

function removeExistingRecordingEvidence(recordingId: string): void {
  const affected = queryAll<{ voice_cluster_id: string }>(
    'SELECT DISTINCT voice_cluster_id FROM voice_cluster_observations WHERE recording_id = ?',
    [recordingId]
  ).map((row) => row.voice_cluster_id)
  runNoSave('DELETE FROM recording_voice_clusters WHERE recording_id = ?', [recordingId])
  runNoSave('DELETE FROM voice_cluster_observations WHERE recording_id = ?', [recordingId])
  for (const clusterId of affected) {
    const observations = queryAll<{ embedding_json: string; speech_seconds: number }>(
      'SELECT embedding_json, speech_seconds FROM voice_cluster_observations WHERE voice_cluster_id = ?',
      [clusterId]
    )
    if (!observations.length) {
      runNoSave('DELETE FROM voice_clusters WHERE id = ?', [clusterId])
      continue
    }
    let centroid: number[] = []
    let totalWeight = 0
    for (const observation of observations) {
      let embedding: number[] = []
      try {
        const parsed = JSON.parse(observation.embedding_json)
        embedding = Array.isArray(parsed) ? parsed.map(Number) : []
      } catch { /* malformed evidence is ignored */ }
      if (!embedding.length) continue
      centroid = updateCentroid(centroid, totalWeight, embedding, observation.speech_seconds)
      totalWeight += Math.max(0.001, observation.speech_seconds)
    }
    if (!centroid.length) {
      runNoSave('DELETE FROM voice_clusters WHERE id = ?', [clusterId])
      continue
    }
    runNoSave(
      `UPDATE voice_clusters SET centroid_json = ?, observation_count = ?, total_speech_seconds = ?,
       updated_at = ? WHERE id = ?`,
      [JSON.stringify(centroid), observations.length, totalWeight, new Date().toISOString(), clusterId]
    )
  }
}

function persistMatches(recordingId: string, result: AcousticWorkerResult): VoiceMatch[] {
  const config = getConfig().transcription
  return runInTransaction(() => {
    removeExistingRecordingEvidence(recordingId)
    const dimension = result.speakers.find((speaker) => speaker.embedding.length > 0)?.embedding.length ?? 0
    if (!dimension) return []
    const clusters = queryAll<VoiceClusterRow>(
      `SELECT vc.*, c.name AS contact_name FROM voice_clusters vc
       LEFT JOIN contacts c ON c.id = vc.contact_id
       WHERE vc.model = ? AND vc.model_version = ? AND vc.embedding_dimension = ?`,
      [result.model, result.modelVersion, dimension]
    )
    const candidates: VoiceMatchCandidate[] = clusters.map((cluster) => ({
      id: cluster.id,
      centroid: parseCentroid(cluster),
      contactId: cluster.contact_id
    }))
    const rowsById = new Map(clusters.map((cluster) => [cluster.id, cluster]))
    const used = new Set<string>()
    const matches: VoiceMatch[] = []
    for (const speaker of result.speakers) {
      const embedding = normalizeEmbedding(speaker.embedding)
      if (!embedding.length || speaker.speechSeconds < config.speakerLinkingMinSpeechSeconds) continue
      const decision = decideVoiceMatch(
        embedding,
        candidates,
        config.speakerLinkingMatchThreshold,
        config.speakerLinkingMatchMargin,
        used
      )
      const clusterId = decision.clusterId ?? randomUUID()
      let row = rowsById.get(clusterId)
      if (row) {
        const centroid = updateCentroid(
          parseCentroid(row),
          row.total_speech_seconds,
          embedding,
          speaker.speechSeconds
        )
        runNoSave(
          `UPDATE voice_clusters SET centroid_json = ?, observation_count = observation_count + 1,
           total_speech_seconds = total_speech_seconds + ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(centroid), speaker.speechSeconds, new Date().toISOString(), clusterId]
        )
      } else {
        runNoSave(
          `INSERT INTO voice_clusters
           (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          [clusterId, result.model, result.modelVersion, dimension, JSON.stringify(embedding), speaker.speechSeconds]
        )
        row = {
          id: clusterId,
          model: result.model,
          model_version: result.modelVersion,
          embedding_dimension: dimension,
          centroid_json: JSON.stringify(embedding),
          observation_count: 1,
          total_speech_seconds: speaker.speechSeconds,
          contact_id: null,
          contact_name: null
        }
        rowsById.set(clusterId, row)
        candidates.push({ id: clusterId, centroid: embedding, contactId: null })
      }
      used.add(clusterId)
      const stableLabel = stableVoiceLabel(clusterId)
      runNoSave(
        `INSERT INTO voice_cluster_observations
         (id, voice_cluster_id, recording_id, local_speaker_label, embedding_json, speech_seconds,
          quality_score, similarity, runner_up_margin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(), clusterId, recordingId, speaker.label, JSON.stringify(embedding), speaker.speechSeconds,
          speaker.qualityScore ?? null, decision.similarity, decision.runnerUpMargin
        ]
      )
      runNoSave(
        `INSERT INTO recording_voice_clusters
         (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id,
          match_status, similarity, runner_up_margin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [recordingId, speaker.label, stableLabel, clusterId, decision.status, decision.similarity, decision.runnerUpMargin]
      )
      matches.push({
        localSpeakerLabel: speaker.label,
        voiceClusterId: clusterId,
        stableLabel,
        status: decision.status,
        similarity: decision.similarity,
        runnerUpMargin: decision.runnerUpMargin,
        contactId: row.contact_id,
        contactName: row.contact_name,
        speechSeconds: speaker.speechSeconds
      })
    }
    return matches
  })
}

export async function runSpeakerLinkingPreflight(
  recordingId: string,
  audioPath: string,
  shouldContinue: () => boolean,
  audioDurationSeconds?: number | null
): Promise<SpeakerLinkingResult> {
  const config = getConfig().transcription
  const engine = resolveSpeakerEngine(config)
  if (engine === 'off') {
    return {
      available: false,
      model: pinnedVoiceModel(),
      modelVersion: null,
      device: null,
      segments: [],
      matches: [],
      reason: 'voice recognition is turned off in Speakers & voices'
    }
  }
  // pyannote-local and onnx-local skip the host; model-host (and auto with a host) tries it first.
  const result =
    engine === 'onnx-local'
      ? await runOnnxWorker(audioPath, shouldContinue, audioDurationSeconds)
      : engine === 'pyannote-local'
        ? await diarize(audioPath, shouldContinue, audioDurationSeconds, { remote: undefined, localOnly: true })
        : await diarize(audioPath, shouldContinue, audioDurationSeconds)
  if (!shouldContinue()) throw new Error('speaker-linking cancelled because recording became ineligible')
  assertInLibraryVoiceSpace(result, libraryVoiceSpace())
  const matches = persistMatches(recordingId, result)
  return {
    available: true,
    model: result.model,
    modelVersion: result.modelVersion,
    device: result.device,
    segments: result.segments,
    matches
  }
}

function overlapSeconds(a: AcousticSegment, b: AcousticSegment): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/** Overlap fraction at/above which an acoustic voice confidently owns a turn. */
export const STRONG_SPEAKER_OVERLAP = 0.35
/** Below this, the acoustic evidence is too thin to name a voice at all. */
export const WEAK_SPEAKER_OVERLAP = 0.05

/** How a turn's final speaker label was decided (persisted per turn). */
export type SpeakerAttribution = 'acoustic' | 'acoustic-weak' | 'unresolved'

/** Label used when no acoustic voice can be attributed to a turn. */
export const UNRESOLVED_SPEAKER_LABEL = 'Unknown speaker'

/**
 * Re-label provider turns by maximum overlap with the independent local
 * acoustic segmentation. Provider text/timestamps stay intact; only the
 * anonymous speaker label is reconciled.
 *
 * Every turn ends up on the SAME label scheme. Previously a turn that missed
 * the overlap gate kept whatever the provider had called it, and the provider
 * had been shown the raw SPEAKER_NN local labels (see
 * buildSpeakerLinkingContext) - so one 1:1 call came out carrying
 * "Voice C5C45B", "Voice 72D115", "SPEAKER_00" AND "SPEAKER_01", which reads
 * downstream as four people and makes one speaker appear to change identity
 * mid-answer. Turns that cannot be attributed are now labelled explicitly as
 * unknown and carry speakerAttribution / speakerConfidence so a consumer can
 * drop exactly those turns instead of distrusting the whole file.
 */
export function reconcileProviderSpeakers(
  speakersJson: string | undefined,
  linking: SpeakerLinkingResult
): string | undefined {
  if (!speakersJson || !linking.available || !linking.matches.length) return speakersJson
  try {
    const turns = JSON.parse(speakersJson) as Array<Record<string, unknown>>
    if (!Array.isArray(turns)) return speakersJson
    const stableByLocal = new Map(linking.matches.map((match) => [match.localSpeakerLabel, match.stableLabel]))
    const knownStable = new Set(stableByLocal.values())
    const rewritten = turns.map((turn) => {
      const start = Number(turn.start)
      const end = Number(turn.end)
      const unresolved = (): Record<string, unknown> => ({
        ...turn,
        // Keep an already-stable label if the provider happened to echo one;
        // otherwise never leave a foreign scheme in place.
        speaker: knownStable.has(String(turn.speaker)) ? turn.speaker : UNRESOLVED_SPEAKER_LABEL,
        speakerAttribution: 'unresolved',
        speakerConfidence: 0
      })
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return unresolved()
      const target = { start, end, speaker: '' }
      const overlapByLocal = new Map<string, number>()
      for (const segment of linking.segments) {
        const overlap = overlapSeconds(target, segment)
        if (overlap > 0) overlapByLocal.set(segment.speaker, (overlapByLocal.get(segment.speaker) ?? 0) + overlap)
      }
      const best = [...overlapByLocal.entries()].sort((a, b) => b[1] - a[1])[0]
      if (!best) return unresolved()
      const ratio = best[1] / (end - start)
      const stable = stableByLocal.get(best[0])
      if (!stable || ratio < WEAK_SPEAKER_OVERLAP) return unresolved()
      return {
        ...turn,
        speaker: stable,
        speakerAttribution: ratio >= STRONG_SPEAKER_OVERLAP ? 'acoustic' : 'acoustic-weak',
        speakerConfidence: Math.round(Math.min(1, ratio) * 100) / 100
      }
    })
    return JSON.stringify(rewritten)
  } catch {
    return speakersJson
  }
}

export function buildSpeakerLinkingContext(linking: SpeakerLinkingResult): string {
  if (!linking.available) return `LOCAL SPEAKER LINKING: unavailable (${linking.reason ?? 'unknown reason'})`
  const identities = linking.matches.map((match) =>
    match.stableLabel +
    (match.contactName ? ` (known contact: ${match.contactName})` : ' (identity unknown)')
  )
  // Emit ONLY stable labels. Listing the raw SPEAKER_NN local labels here
  // taught the provider a second naming scheme, which it then mixed into
  // its own output alongside the stable one.
  const stableByLocal = new Map(linking.matches.map((match) => [match.localSpeakerLabel, match.stableLabel]))
  return `LOCAL ACOUSTIC SPEAKER EVIDENCE (authoritative for speaker boundaries; names remain evidence-bound):
Model: ${linking.model}@${linking.modelVersion}; device: ${linking.device ?? 'unknown'}
Voices: ${identities.join('; ') || 'none with enough speech'}
Use EXACTLY these voice labels; never invent a different speaker naming scheme.
Segments: ${linking.segments.map((segment) =>
    `${segment.start.toFixed(2)}-${segment.end.toFixed(2)}s ${stableByLocal.get(segment.speaker) ?? segment.speaker}`
  ).join(', ')}`
}

/** Bind only clusters already anchored to a contact. Unknown clusters stay anonymous. */
export function applyKnownVoiceBindings(recordingId: string): number {
  return runInTransaction(() => {
    const rows = queryAll<{ transcript_speaker_label: string; contact_id: string }>(
      `SELECT DISTINCT rvc.transcript_speaker_label, vc.contact_id
       FROM recording_voice_clusters rvc
       JOIN voice_clusters vc ON vc.id = rvc.voice_cluster_id
       WHERE rvc.recording_id = ? AND rvc.transcript_speaker_label IS NOT NULL AND vc.contact_id IS NOT NULL`,
      [recordingId]
    )
    let inserted = 0
    for (const row of rows) {
      const existing = queryOne(
        'SELECT 1 FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
        [recordingId, row.transcript_speaker_label]
      )
      if (existing) continue
      runNoSave(
        'INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id) VALUES (?, ?, ?, ?)',
        [randomUUID(), recordingId, row.transcript_speaker_label, row.contact_id]
      )
      inserted++
    }
    return inserted
  })
}

/** A manual/self-ID speaker binding becomes the evidence anchor for its voice cluster. */
export function anchorVoiceClusterForSpeaker(
  recordingId: string,
  speakerLabel: string,
  contactId: string,
  method: 'manual' | 'self-identification',
  confidence: number
): boolean {
  const mapping = queryOne<{ voice_cluster_id: string }>(
    `SELECT voice_cluster_id FROM recording_voice_clusters
     WHERE recording_id = ? AND transcript_speaker_label = ?`,
    [recordingId, speakerLabel]
  )
  if (!mapping) return false
  runNoSave(
    `UPDATE voice_clusters SET contact_id = ?, contact_link_method = ?,
     contact_link_confidence = ?, updated_at = ? WHERE id = ?`,
    [contactId, method, confidence, new Date().toISOString(), mapping.voice_cluster_id]
  )
  return true
}
