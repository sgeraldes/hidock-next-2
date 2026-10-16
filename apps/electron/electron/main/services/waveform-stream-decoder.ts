import { createHash } from 'crypto'
import { spawn, type ChildProcessByStdio } from 'child_process'
import { realpathSync, statSync } from 'fs'
import { constants, setPriority } from 'os'
import type { Readable } from 'stream'
import { bundledFfmpegPath } from './audio-profile'

export const WAVEFORM_PEAKS = 1000
export const WAVEFORM_SAMPLE_RATE = 8000
export const WAVEFORM_MAX_CHANNELS = 8
export const WAVEFORM_MAX_DURATION_SECONDS = 6 * 60 * 60
export const WAVEFORM_MAX_STDERR_BYTES = 64 * 1024
export const WAVEFORM_MAX_CHUNK_BYTES = 64 * 1024
export const WAVEFORM_DECODE_TIMEOUT_MS = 10 * 60 * 1000
export const WAVEFORM_MAX_QUEUED_JOBS = 3

export interface WaveformSourceIdentity {
  canonicalPath: string
  size: number
  mtimeMs: number
  ctimeMs: number
  device: string
  fileId: string
  fingerprint: string
}

export interface DecodedWaveform {
  sourceIdentity: WaveformSourceIdentity
  codec: string
  sourceSampleRate: number
  durationSeconds: number
  framesAtOutputRate: number
  /** Largest single PCM chunk observed from the child pipe, for boundedness evidence. */
  maxPcmChunkBytes: number
  /** Channel zero is mirrored here for existing waveform consumers. */
  peaks: number[]
  /** Channel order comes from FFmpeg; labels deliberately make no speaker claim. */
  channels: number[][]
  channelLabels: string[]
}

interface AudioMetadata {
  codec: string
  sourceSampleRate: number
  channels: number
  layout: string
}

export interface DecodeWaveformOptions {
  signal?: AbortSignal
  timeoutMs?: number
  ffmpegPath?: string
  spawnChild?: typeof spawn
  lowerPriority?: typeof setPriority
}

export function getWaveformSourceIdentity(filePath: string): WaveformSourceIdentity {
  const canonicalPath = realpathSync(filePath)
  const info = statSync(canonicalPath, { bigint: true })
  const size = Number(info.size)
  const mtimeMs = Number(info.mtimeMs)
  const ctimeMs = Number(info.ctimeMs)
  const device = String(info.dev)
  const fileId = String(info.ino)
  const pathKey = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  const fingerprint = createHash('sha256')
    .update(`${pathKey}\0${size}\0${mtimeMs}\0${ctimeMs}\0${device}\0${fileId}`)
    .digest('hex')
  return { canonicalPath, size, mtimeMs, ctimeMs, device, fileId, fingerprint }
}

export function sameWaveformSource(a: WaveformSourceIdentity, b: WaveformSourceIdentity): boolean {
  const samePath = process.platform === 'win32'
    ? a.canonicalPath.toLowerCase() === b.canonicalPath.toLowerCase()
    : a.canonicalPath === b.canonicalPath
  return samePath && a.fingerprint === b.fingerprint
}

function channelsForLayout(value: string): number {
  const layout = value.trim().toLowerCase()
  if (layout === 'mono') return 1
  if (layout === 'stereo') return 2
  const explicit = /^(\d+) channels$/.exec(layout)
  if (explicit) return Number(explicit[1])
  return ({
    '2.1': 3, '3.0': 3, '3.0(back)': 3, '4.0': 4, quad: 4,
    '5.0': 5, '5.0(side)': 5, '5.1': 6, '5.1(side)': 6,
    '6.1': 7, '7.1': 8, '7.1(wide)': 8
  } as Record<string, number>)[layout] ?? 0
}

function parseAudioMetadata(stderr: string): AudioMetadata {
  const audio = /Audio:\s*([^,\s]+)[^\n]*?,\s*(\d+)\s*Hz,\s*([^,\n]+)/.exec(stderr)
  if (!audio) throw new Error('FFmpeg did not report audio codec and channel layout')
  const channels = channelsForLayout(audio[3])
  const sourceSampleRate = Number(audio[2])
  if (!Number.isInteger(channels) || channels < 1 || channels > WAVEFORM_MAX_CHANNELS) {
    throw new Error(`Unsupported FFmpeg channel layout: ${audio[3].trim()}`)
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error(`Unsupported FFmpeg sample rate: ${audio[2]}`)
  }
  return {
    codec: audio[1],
    sourceSampleRate,
    channels,
    layout: audio[3].trim()
  }
}

function foldPeakBins(channels: number[][]): number[][] {
  return channels.map((values) => {
    const folded = new Array<number>(WAVEFORM_PEAKS).fill(0)
    for (let index = 0; index < WAVEFORM_PEAKS / 2; index++) {
      folded[index] = Math.max(values[index * 2], values[index * 2 + 1])
    }
    return folded
  })
}

/** Re-spread bounded source bins over the exact decoded frame count. */
function spreadPeakBins(source: number[][], binSize: number, frameCount: number): number[][] {
  const output = source.map(() => new Array<number>(WAVEFORM_PEAKS).fill(0))
  for (let channel = 0; channel < source.length; channel++) {
    const sourceBinCount = Math.min(WAVEFORM_PEAKS, Math.ceil(frameCount / binSize))
    for (let sourceBin = 0; sourceBin < sourceBinCount; sourceBin++) {
      const startFrame = sourceBin * binSize
      const endFrame = Math.min(frameCount, startFrame + binSize)
      const firstTarget = Math.floor((startFrame * WAVEFORM_PEAKS) / frameCount)
      const lastTarget = Math.min(WAVEFORM_PEAKS - 1, Math.floor(((endFrame - 1) * WAVEFORM_PEAKS) / frameCount))
      const peak = source[channel][sourceBin]
      for (let target = firstTarget; target <= lastTarget; target++) {
        if (peak > output[channel][target]) output[channel][target] = peak
      }
    }
  }
  return output
}

type FfmpegChild = ChildProcessByStdio<null, Readable, Readable>

function makeClosedPromise(child: FfmpegChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

/** Decode one source with one bounded FFmpeg child and retain only fixed-size peaks. */
export async function decodeWaveformFile(filePath: string, options: DecodeWaveformOptions = {}): Promise<DecodedWaveform> {
  const {
    signal,
    timeoutMs = WAVEFORM_DECODE_TIMEOUT_MS,
    ffmpegPath = bundledFfmpegPath(),
    spawnChild = spawn,
    lowerPriority = setPriority
  } = options
  if (signal?.aborted) throw new Error('Waveform decode cancelled')
  const before = getWaveformSourceIdentity(filePath)
  if (signal?.aborted) throw new Error('Waveform decode cancelled')

  const child = spawnChild(ffmpegPath, [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    '-i', before.canonicalPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ar', String(WAVEFORM_SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = makeClosedPromise(child)
  let stopReason: string | null = null
  let killSent = false
  let stderr = ''
  let stderrBytes = 0
  let resolveMetadata!: (metadata: AudioMetadata) => void
  let rejectMetadata!: (error: Error) => void
  const metadataReady = new Promise<AudioMetadata>((resolve, reject) => {
    resolveMetadata = resolve
    rejectMetadata = reject
  })
  const stop = (reason: string) => {
    stopReason ??= reason
    if (killSent || child.exitCode != null || child.signalCode != null) return
    killSent = true
    child.kill()
  }
  const onAbort = () => stop('Waveform decode cancelled')
  const timer = setTimeout(() => stop('Waveform decode exceeded its timeout'), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  try {
    if (!child.pid) throw new Error('FFmpeg child did not start')
    try {
      lowerPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch (error) {
      stop(`Could not lower FFmpeg process priority: ${error instanceof Error ? error.message : String(error)}`)
    }
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > WAVEFORM_MAX_STDERR_BYTES) {
        stop('FFmpeg diagnostics exceeded 64 KiB')
        rejectMetadata(new Error('FFmpeg diagnostics exceeded 64 KiB'))
        return
      }
      stderr += chunk.toString('utf8')
      // Audio stream metadata is enough to begin. Container duration may be
      // absent (MediaRecorder WebM) or inaccurate (VBR MP3 without Xing), so
      // duration is measured from decoded output frames below.
      if (/(?:^|\r?\n)[^\r\n]*Audio:[^\r\n]*\r?\n/.test(stderr)) {
        try { resolveMetadata(parseAudioMetadata(stderr)) }
        catch (error) { rejectMetadata(error instanceof Error ? error : new Error(String(error))) }
      }
    })

    const metadata = await Promise.race([
      metadataReady,
      closed.then(({ code }) => {
        if (stopReason) throw new Error(stopReason)
        throw new Error(`FFmpeg exited ${code} before audio metadata was available`)
      })
    ])
    let channels = Array.from({ length: metadata.channels }, () => new Array<number>(WAVEFORM_PEAKS).fill(0))
    let binSize = 1
    const maximumFrames = WAVEFORM_MAX_DURATION_SECONDS * WAVEFORM_SAMPLE_RATE
    const frameBytes = metadata.channels * Float32Array.BYTES_PER_ELEMENT
    let frameCount = 0
    let maxPcmChunkBytes = 0
    let carry = Buffer.alloc(0)

    for await (const chunk of child.stdout) {
      if (chunk.length > WAVEFORM_MAX_CHUNK_BYTES) throw new Error('FFmpeg stdout chunk exceeded 64 KiB')
      maxPcmChunkBytes = Math.max(maxPcmChunkBytes, chunk.length)
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const completeBytes = data.length - (data.length % frameBytes)
      for (let offset = 0; offset < completeBytes; offset += frameBytes) {
        if (frameCount >= maximumFrames) throw new Error(`Audio exceeds the ${WAVEFORM_MAX_DURATION_SECONDS}-second waveform limit`)
        while (Math.floor(frameCount / binSize) >= WAVEFORM_PEAKS) {
          channels = foldPeakBins(channels)
          binSize *= 2
        }
        const bin = Math.floor(frameCount / binSize)
        for (let channel = 0; channel < metadata.channels; channel++) {
          const value = Math.abs(data.readFloatLE(offset + channel * Float32Array.BYTES_PER_ELEMENT))
          if (!Number.isFinite(value)) throw new Error('FFmpeg produced a non-finite PCM sample')
          if (value > channels[channel][bin]) channels[channel][bin] = Math.min(1, value)
        }
        frameCount++
      }
      carry = data.subarray(completeBytes)
    }

    const exit = await closed
    if (stopReason) throw new Error(stopReason)
    if (exit.code !== 0) throw new Error(`FFmpeg exited ${exit.code ?? exit.signal}: ${stderr.slice(-1000)}`)
    if (carry.length || frameCount === 0) throw new Error('FFmpeg produced an empty or incomplete PCM stream')
    const durationSeconds = frameCount / WAVEFORM_SAMPLE_RATE
    channels = spreadPeakBins(channels, binSize, frameCount)
    const after = getWaveformSourceIdentity(filePath)
    if (!sameWaveformSource(before, after)) throw new Error('Audio source changed during waveform decode')
    return {
      sourceIdentity: before,
      codec: metadata.codec,
      sourceSampleRate: metadata.sourceSampleRate,
      durationSeconds,
      framesAtOutputRate: frameCount,
      maxPcmChunkBytes,
      peaks: channels[0],
      channels,
      channelLabels: channels.map((_, index) => `Channel ${index}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    stop(reason)
    await closed.catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

interface QueuedJob {
  identity: WaveformSourceIdentity
  path: string
  controller: AbortController
  subscribers: Set<string>
  started: boolean
  promise: Promise<DecodedWaveform>
  resolve: (decoded: DecodedWaveform) => void
  reject: (error: Error) => void
}

export type WaveformDecoder = (filePath: string, options: { signal?: AbortSignal }) => Promise<DecodedWaveform>

/** Small factory keeps queue semantics independently testable without hardware or DB access. */
export function createWaveformDecodeQueue(
  decoder: WaveformDecoder = decodeWaveformFile,
  maxQueuedJobs = WAVEFORM_MAX_QUEUED_JOBS
): { request(filePath: string, requestId: string): Promise<DecodedWaveform>; cancel(requestId: string): boolean } {
  const jobsByFingerprint = new Map<string, QueuedJob>()
  const jobsByRequest = new Map<string, QueuedJob>()
  const queue: QueuedJob[] = []
  let activeJob: QueuedJob | null = null

  const runNextJob = () => {
    if (activeJob) return
    const job = queue.shift()
    if (!job) return
    if (job.controller.signal.aborted) {
      if (jobsByFingerprint.get(job.identity.fingerprint) === job) jobsByFingerprint.delete(job.identity.fingerprint)
      job.reject(new Error('Waveform decode cancelled'))
      runNextJob()
      return
    }
    activeJob = job
    job.started = true
    void decoder(job.path, { signal: job.controller.signal })
      .then(job.resolve, job.reject)
      .finally(() => {
        // A cancelled active job may have detached so a replacement can queue
        // behind its actual process exit. Do not erase that replacement here.
        if (jobsByFingerprint.get(job.identity.fingerprint) === job) {
          jobsByFingerprint.delete(job.identity.fingerprint)
        }
        for (const requestId of job.subscribers) {
          if (jobsByRequest.get(requestId) === job) jobsByRequest.delete(requestId)
        }
        job.subscribers.clear()
        activeJob = null
        runNextJob()
      })
  }

  const request = (filePath: string, requestId: string) => {
    if (!requestId || requestId.length > 160) return Promise.reject(new Error('Invalid waveform request id'))
    let identity: WaveformSourceIdentity
    try { identity = getWaveformSourceIdentity(filePath) }
    catch (error) { return Promise.reject(error) }
    const existingOwner = jobsByRequest.get(requestId)
    if (existingOwner && existingOwner.identity.fingerprint !== identity.fingerprint) {
      return Promise.reject(new Error('Waveform request id is already in use'))
    }
    let job = jobsByFingerprint.get(identity.fingerprint)
    if (existingOwner && existingOwner !== job) {
      return Promise.reject(new Error('Waveform request id is already in use'))
    }
    if (!job) {
      if (queue.length >= maxQueuedJobs) return Promise.reject(new Error('Waveform decode queue is full'))
      let resolve!: (decoded: DecodedWaveform) => void
      let reject!: (error: Error) => void
      const promise = new Promise<DecodedWaveform>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      job = { identity, path: identity.canonicalPath, controller: new AbortController(), subscribers: new Set(), started: false, promise, resolve, reject }
      jobsByFingerprint.set(identity.fingerprint, job)
      queue.push(job)
    }
    job.subscribers.add(requestId)
    jobsByRequest.set(requestId, job)
    if (!job.started) runNextJob()
    return job.promise.finally(() => {
      if (jobsByRequest.get(requestId) === job) jobsByRequest.delete(requestId)
      job!.subscribers.delete(requestId)
    })
  }

  const cancel = (requestId: string) => {
    const job = jobsByRequest.get(requestId)
    if (!job) return false
    jobsByRequest.delete(requestId)
    job.subscribers.delete(requestId)
    if (job.subscribers.size > 0) return true
    // Immediately detach the old fingerprint. A same-file click during child
    // teardown must create a fresh queued job rather than join this aborting one.
    if (jobsByFingerprint.get(job.identity.fingerprint) === job) {
      jobsByFingerprint.delete(job.identity.fingerprint)
    }
    job.controller.abort()
    if (!job.started) {
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      job.reject(new Error('Waveform decode cancelled'))
      runNextJob()
    }
    return true
  }

  return { request, cancel }
}

const defaultQueue = createWaveformDecodeQueue()

/** Deduplicate by file fingerprint and run at most one FFmpeg child globally. */
export const requestWaveformDecode = defaultQueue.request

/** Cancel one subscriber; shared work stops only when no requesters remain. */
export const cancelWaveformDecode = defaultQueue.cancel
