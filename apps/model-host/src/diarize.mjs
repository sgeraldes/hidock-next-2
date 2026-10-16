/**
 * Run the diarization worker on audio the client sent, then forget the audio.
 *
 * This is the same `worker.py` the client runs locally, called the same way, so
 * a remote result and a local result are the same object. That equivalence is
 * the whole point: the client can fall back to local without a second code
 * path, and a transcript does not change shape depending on which machine
 * produced it.
 */

import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { availableParallelism, freemem, totalmem } from 'os'

/** Output above this is a runaway worker, not a transcript. */
const OUTPUT_CAP_BYTES = 25 * 1024 * 1024
// Symbol capability cannot be supplied by an HTTP/JSON caller.
export const AUDIO8_MEMORY_PROFILE = Symbol('audio8-host-memory-profile')

export function workerMemoryMb(profile, totalBytes = totalmem(), freeBytes = freemem()) {
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0 || freeBytes < 0) {
    throw new Error('Worker resource admission failed: memory counters unavailable')
  }
  const audio8 = profile === AUDIO8_MEMORY_PROFILE
  const bytes = Math.min((audio8 ? 24 : 16) * 1024 ** 3,
    totalBytes * (audio8 ? 0.375 : 0.25), freeBytes * 0.5)
  const mb = Math.floor(bytes / 1024 ** 2)
  if (audio8 && mb < 20 * 1024) {
    throw new Error(`Audio8 resource admission failed: requires at least 20 GiB worker memory; safely available ${(mb / 1024).toFixed(2)} GiB. Free host memory before retrying; no fallback was started.`)
  }
  if (!audio8 && mb < 1024) {
    throw new Error(`Worker resource admission failed: requires at least 1 GiB worker memory; safely available ${(mb / 1024).toFixed(2)} GiB. Free host memory before retrying; no fallback was started.`)
  }
  return mb
}

/**
 * Thread limits for the worker, same six variables the client sets.
 *
 * Each one is read by a different layer (OpenMP, Intel MKL, OpenBLAS, NumExpr,
 * and the worker's own torch.set_num_threads). Missing one is enough for that
 * layer to go back to using every core, which on the host means the machine
 * that is also used for playing games stutters for the length of a meeting.
 */
export function threadEnv(cpuPercent, parallelism = availableParallelism()) {
  const total = Math.max(1, parallelism)
  const pct = Number.isFinite(cpuPercent) && cpuPercent > 0 ? Math.min(100, cpuPercent) : 50
  const threads = String(Math.max(1, Math.min(total, Math.floor((total * pct) / 100))))
  return {
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    TORCH_NUM_THREADS: threads,
    HIDOCK_DIARIZATION_THREADS: threads,
  }
}

/** The worker's result, or a clear reason there is none. */
export function parseWorkerOutput(stdout) {
  const parsed = JSON.parse(stdout)
  if (
    !parsed.model ||
    !parsed.modelVersion ||
    !Array.isArray(parsed.segments) ||
    !Array.isArray(parsed.speakers)
  ) {
    throw new Error('worker returned an incomplete result')
  }
  return parsed
}

/**
 * @param {Buffer} audio
 * @param {object} options
 * @param {string} options.pythonPath
 * @param {string} options.workerPath
 * @param {string} options.model
 * @param {string} options.fallbackModel
 * @param {number} options.minSpeechSeconds
 * @param {number} options.cpuPercent
 * @param {number} options.timeoutMs
 * @param {string} [options.hfToken]
 * @param {string} [options.ffmpegPath]
 * @param {string} [options.extension] container extension, for ffmpeg's benefit
 * @param {AbortSignal} [options.signal]
 * @param {typeof spawn} [options.spawnFn] injected for tests
 */
export async function runDiarization(audio, options) {
  const spawnFn = options.spawnFn || spawn
  const memoryMb = workerMemoryMb(options.memoryProfile)
  const dir = await mkdtemp(join(tmpdir(), 'hidock-host-'))
  // Second line of defence for the same thing server.mjs checks. This function
  // writes attacker-supplied bytes to this path, so the name is rebuilt from
  // an allow-list here too rather than trusted from the caller.
  const extension = /^\.[a-z0-9]{1,8}$/i.test(String(options.extension ?? ''))
    ? String(options.extension).toLowerCase()
    : '.wav'
  const audioPath = typeof audio === 'string' ? audio : join(dir, `job${extension}`)
  try {
    if (typeof audio !== 'string') await writeFile(audioPath, audio)
    if (options.signal?.aborted) throw new Error('diarization cancelled')
    return await new Promise((resolve, reject) => {
      const child = spawnFn(
        options.pythonPath,
        options.workerArgs ? options.workerArgs(audioPath) : [
          options.workerPath,
          '--audio', audioPath,
          '--model', options.model,
          '--fallback-model', options.fallbackModel,
          '--min-speech-seconds', String(options.minSpeechSeconds),
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // The pipe is decoded as UTF-8 below; Windows Python otherwise may
            // emit cp1252 and silently corrupt accented transcript characters.
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            ...(options.ffmpegPath ? { FFMPEG_PATH: options.ffmpegPath } : {}),
            ...(options.hfToken
              ? { HF_TOKEN: options.hfToken, HUGGINGFACE_HUB_TOKEN: options.hfToken }
              : {}),
            ...threadEnv(options.cpuPercent),
            HIDOCK_WORKER_PRIORITY: 'below-normal',
            HIDOCK_WORKER_MEMORY_MB: String(memoryMb),
          },
        }
      )

      let stdout = ''
      let stderr = ''
      let settled = false
      let stopReason = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const timer = setTimeout(() => {
        stopReason = new Error(`diarization timed out after ${Math.round(options.timeoutMs / 1000)} seconds`)
        child.kill()
      }, options.timeoutMs)
      const onAbort = () => {
        stopReason = new Error('diarization cancelled')
        child.kill()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length <= OUTPUT_CAP_BYTES) stdout += chunk
        else { stopReason = new Error('Worker output exceeded memory limit'); child.kill() }
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-8192)
      })
      child.on('error', (error) => {
        finish(reject, new Error(`failed to start the diarization worker: ${error.message}`))
      })
      child.on('close', (code) => {
        if (stopReason) { finish(reject, stopReason); return }
        if (code !== 0) {
          const detail = stderr.trim().split('\n').slice(-12).join('\n')
          finish(reject, new Error(detail || `the diarization worker exited with code ${code}`))
          return
        }
        try {
          finish(resolve, (options.parseOutput || parseWorkerOutput)(stdout))
        } catch (error) {
          finish(reject, new Error(`invalid diarization worker output: ${error.message}`))
        }
      })
    })
  } finally {
    // The audio is the client's, and the host has no business keeping it. This
    // runs on success, on failure, on timeout and on cancellation.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
