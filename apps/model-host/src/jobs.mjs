import { createHash, randomUUID } from 'crypto'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { channelRequest } from './asr-channels.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const fail = (status, message) => Object.assign(new Error(message), { status })
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const validId = /^[a-f0-9-]{36}$/

/** One durable job identity survives desktop reconnects. Audio is never retained after execution. */
export class WorkerJobs {
  constructor({ directory, state, execute, options, maxBytes = 512 * 1024 ** 2, now = Date.now }) {
    Object.assign(this, { directory, state, execute, options, maxBytes, now })
    this.jobs = new Map()
    this.controllers = new Map()
    this.writes = Promise.resolve()
    this.creating = new Map()
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true })
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (/^[a-f0-9-]{36}\.audio$/.test(entry.name)) {
        await rm(join(this.directory, entry.name), { force: true })
      } else if (/^[a-f0-9-]{36}\.json$/.test(entry.name)) {
        const job = JSON.parse(await readFile(join(this.directory, entry.name), 'utf8'))
        if (!validId.test(job.id) || entry.name !== `${job.id}.json`) continue
        if (!terminal.has(job.status)) {
          job.status = 'interrupted'
          job.error = 'Worker restarted; input was removed. Explicitly restart this job.'
          job.revision++
          await this.persist(job)
        }
        this.jobs.set(job.id, job)
      }
    }
    await this.expire()
    this.timer = setInterval(() => { void this.expire().catch(() => {}) }, 60_000)
    this.timer.unref()
  }

  persist(job) {
    const content = JSON.stringify(job)
    const work = this.writes.then(async () => {
      const target = join(this.directory, `${job.id}.json`)
      await writeFile(`${target}.tmp`, content, { mode: 0o600, flush: true })
      await rename(`${target}.tmp`, target)
    })
    this.writes = work.catch(() => {})
    return work
  }

  view(job) {
    const { owner, key, ...publicJob } = job
    return publicJob
  }

  get(id, authorization) {
    const job = this.jobs.get(id)
    if (!job || job.owner !== digest(authorization)) throw fail(404, 'No such job')
    return job
  }

  async create(request, authorization) {
    let channels
    try { channels = channelRequest(request) } catch (error) { throw fail(400, error.message) }
    if (channels.channelMode === 'separate' && request.stage !== 'transcription') {
      throw fail(400, 'Separate channel processing currently requires transcription stage')
    }
    if (!/^[a-f0-9]{64}$/.test(request.audioHash || '') ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(request.idempotencyKey || '') ||
        !Number.isSafeInteger(request.bytes) || request.bytes < 1 || request.bytes > this.maxBytes ||
        !['diarization', 'vad', 'transcription'].includes(request.stage) || !/^\.[a-z0-9]{1,8}$/i.test(request.extension || '')) {
      throw fail(400, 'Invalid job request')
    }
    if (request.language !== undefined && !/^(?:[a-z]{2,3}|auto)$/.test(request.language)) throw fail(400, 'Invalid language')
    if (request.recordingId !== undefined && (typeof request.recordingId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(request.recordingId))) throw fail(400, 'Invalid recording identity')
    const owner = digest(authorization)
    const key = digest(request.idempotencyKey)
    const existing = [...this.jobs.values()].find(job => job.owner === owner && job.key === key)
    if (existing) {
      if (existing.audioHash !== request.audioHash || existing.model !== request.model || existing.bytes !== request.bytes ||
          existing.stage !== request.stage || (existing.language || 'es') !== (request.language || 'es') ||
          (existing.recordingId || null) !== (request.recordingId || null) ||
          (existing.channelMode || 'mixed') !== channels.channelMode ||
          JSON.stringify(existing.channelMap || []) !== JSON.stringify(channels.channelMap) ||
          JSON.stringify(existing.activeChannels ?? null) !== JSON.stringify(channels.activeChannels ?? null)) {
        throw fail(409, 'Idempotency key belongs to different input')
      }
      await this.creating.get(existing.id)
      return this.view(existing)
    }
    if (this.jobs.size >= 1000) throw fail(429, 'Job history is full; wait for retention cleanup')
    const job = { id: randomUUID(), owner, key, audioHash: request.audioHash, bytes: request.bytes,
      model: request.model, extension: request.extension.toLowerCase(), stage: request.stage, language: request.language || 'es',
      recordingId: request.recordingId || null, ...channels,
      status: 'awaiting-upload', revision: 1, createdAt: this.now(), updatedAt: this.now(),
      retention: { audio: 'deleted on completion, cancellation, failure or service restart', resultSeconds: 86400 } }
    this.jobs.set(job.id, job)
    const persisted = this.persist(job)
    this.creating.set(job.id, persisted)
    try { await persisted } catch (error) { this.jobs.delete(job.id); throw error }
    finally { this.creating.delete(job.id) }
    return this.view(job)
  }

  async update(job, fields) {
    Object.assign(job, fields, { revision: job.revision + 1, updatedAt: this.now() })
    await this.persist(job)
  }

  async upload(id, authorization, input) {
    const job = this.get(id, authorization)
    if (job.status !== 'awaiting-upload') throw fail(409, 'Job already accepted input; observe its existing identity')
    if (!this.state.canAdmit()) throw fail(429, 'Worker is busy or paused')
    const controller = new AbortController()
    const telemetryId = this.telemetry?.start(job.stage, job.model, job.recordingId, job.id)
    job.telemetryId = telemetryId
    this.telemetry?.phase(telemetryId, 'uploading')
    this.state.activeJob = controller
    this.controllers.set(id, controller)
    job.status = 'uploading'
    const audioPath = join(this.directory, `${id}.audio`)
    let accepted = false
    try {
      await this.update(job, { status: 'uploading' })
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > job.bytes) { callback(fail(413, 'Audio exceeds declared size')); return }
        hash.update(chunk)
        callback(null, chunk)
      } })
      await pipeline(input, meter, createWriteStream(audioPath, { flags: 'wx', mode: 0o600, flush: true }),
        { signal: controller.signal })
      if (bytes !== job.bytes || hash.digest('hex') !== job.audioHash) throw fail(422, 'Audio hash or size mismatch')
      await this.update(job, { status: 'running', receivedBytes: bytes })
      this.telemetry?.phase(telemetryId, job.stage === 'vad' ? 'detecting audio activity' : job.stage === 'transcription' ? 'loading / transcribing' : 'loading / diarizing')
      accepted = true
      // Disconnecting the desktop does not cancel an accepted job. Cancel has its own authenticated route.
      void this.run(job, audioPath, controller).catch(error => console.error('[Jobs] Could not persist terminal state:', error.message))
      return this.view(job)
    } catch (error) {
      await this.update(job, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message })
      throw error
    } finally {
      if (!accepted) {
        await this.cleanup(job, audioPath, controller)
      }
    }
  }

  async run(job, audioPath, controller) {
    try {
      const base = this.options()
      // Every worker the supervisor starts for this job is listed, and removed when it exits.
      const tracked = this.telemetry && job.telemetryId
        ? { spawnFn: this.telemetry.spawnFor(job.telemetryId, 'job-worker', base.spawnFn || undefined) } : {}
      const result = await this.execute(audioPath, { ...base, ...tracked, stage: job.stage, language: job.language, model: job.model, fallbackModel: job.model,
        extension: job.extension, signal: controller.signal,
        channelMode: job.channelMode || 'mixed', channelMap: job.channelMap || [], activeChannels: job.activeChannels })
      if (controller.signal.aborted) throw new Error('Job cancelled')
      await rm(audioPath, { force: true })
      if (controller.signal.aborted) throw new Error('Job cancelled')
      await this.update(job, { status: 'completed', result, resultHash: digest(JSON.stringify(result)) })
    } catch (error) {
      // The input goes before the terminal state is visible, as on success: a client that reads
      // `cancelled` must not find the audio still on disk. A failed delete is retried and reported
      // as cleanup-failed by cleanup() below.
      await rm(audioPath, { force: true }).catch(() => {})
      await this.update(job, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message })
    } finally {
      await this.cleanup(job, audioPath, controller)
    }
  }

  async cleanup(job, audioPath, controller) {
    try { await rm(audioPath, { force: true }) }
    catch (error) {
      await this.update(job, { status: 'cleanup-failed', error: 'Input deletion pending: ' + error.message })
    } finally {
      this.controllers.delete(job.id)
      if (this.state.activeJob === controller) this.state.activeJob = null
      this.telemetry?.finish(job.telemetryId, job.status, job.result?.device || null, job.result)
    }
  }

  async cancel(id, authorization) {
    const job = this.get(id, authorization)
    this.controllers.get(id)?.abort()
    if (job.status === 'awaiting-upload') await this.update(job, { status: 'cancelled' })
    return this.view(job)
  }

  async expire() {
    for (const job of this.jobs.values()) {
      if (job.status === 'cleanup-failed') {
        try {
          await rm(join(this.directory, `${job.id}.audio`), { force: true })
          await this.update(job, { status: 'failed', error: 'Temporary input removed; review the interrupted job before retrying' })
        } catch { /* Keep the visible cleanup failure and retry next sweep. */ }
      }
      const ttl = terminal.has(job.status) ? 86400_000 : job.status === 'awaiting-upload' ? 600_000 : Infinity
      if (this.now() - job.updatedAt < ttl) continue
      // Remove admission synchronously; an upload cannot begin during disk deletion.
      this.jobs.delete(job.id)
      try { await rm(join(this.directory, `${job.id}.json`), { force: true }) }
      catch (error) { this.jobs.set(job.id, job); throw error }
    }
  }

  close() { clearInterval(this.timer); for (const controller of this.controllers.values()) controller.abort() }
}
