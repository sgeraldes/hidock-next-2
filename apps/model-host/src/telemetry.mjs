import { cpus, freemem, totalmem, hostname } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WindowsProcessSampler } from './windows-process-sampler.mjs'

export function cpuCounters() {
  return cpus().reduce((sum, cpu) => {
    sum.idle += cpu.times.idle
    sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0)
    return sum
  }, { idle: 0, total: 0 })
}

/** System CPU is a delta; a missing, non-finite or non-advancing sample is unknown, never zero or NaN. */
export function cpuPercent(before, after) {
  const finite = sample => sample != null && Number.isFinite(sample.idle) && Number.isFinite(sample.total)
  if (!finite(before) || !finite(after) || after.total <= before.total) return null
  return Math.max(0, Math.min(100, 100 * (1 - (after.idle - before.idle) / (after.total - before.total))))
}

export function parseGpuCsv(text) {
  if (typeof text !== 'string' || text.trim().split(',').length < 4) return null
  const [name, utilization, used, total] = text.trim().split('\n')[0].split(',').map(s => s.trim())
  const number = value => /^\d+(\.\d+)?$/.test(value || '') ? Number(value) : null
  return { name, utilizationPercent: number(utilization), usedMiB: number(used), totalMiB: number(total) }
}

const WORKER_STALE_MS = 15_000
const WORKER_RECENT_LIMIT = 20
const WORKER_ACTIVE_LIMIT = 64
// A live process never has a zero working set, so 0, negative and non-finite readings are unknown, not measured.
const mib = bytes => Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 2 : null

/**
 * The model worker processes this host started and has not seen exit.
 *
 * Node cannot ask the OS about another process, so this is a lifecycle ledger
 * first: a worker is listed from the moment its ChildProcess has a pid until the
 * 'exit' event, and nothing else is listed. Two limits are part of the data and
 * are reported with it. Only direct children that were registered are covered:
 * what a worker starts itself (ffmpeg, a native speech runtime) is not enumerated.
 * And memory comes only from an injected adapter; without one, or when it
 * fails, the value is null with a status. A total is given only when every listed
 * worker was measured recently, and it is always a lower bound.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(pids: number[]) => Map<number, number> | Record<number, number> | Promise<Map<number, number> | Record<number, number>>} [options.readMemory]
 *   working-set bytes by pid; a pid that could not be read is left out or null
 */
export class WorkerProcessRegistry {
  constructor({ now = Date.now, readMemory = null } = {}) {
    this.now = now
    this.readMemory = typeof readMemory === 'function' ? readMemory : null
    this.sequence = 0
    this.running = new Map()
    this.tracked = new WeakSet()
    this.recent = []
    this.counts = { registered: 0, exited: 0, alreadyExited: 0, spawnFailures: 0, notRegistered: 0, trackingErrors: 0 }
    this.measurements = new Map()
    this.measuredAt = null
    this.memoryError = null
    this.sampling = false
  }

  /** Register a child the moment it exists. Returns its registry sequence, or null when it is not listed. */
  track(child, context = {}) {
    if (!child || typeof child !== 'object' || this.tracked.has(child)) return null
    this.tracked.add(child)
    const pid = child.pid
    // A failed spawn (missing executable) has no pid and only ever emits 'error'.
    if (!Number.isSafeInteger(pid) || pid <= 0) { this.counts.spawnFailures++; return null }
    const entry = { sequence: ++this.sequence, pid, spawnedAt: this.now(), jobId: context.jobId ?? null,
      hostJobId: context.hostJobId ?? null, stage: context.stage ?? null, model: context.model ?? null, role: context.role ?? null }
    const gone = (child.exitCode !== null && child.exitCode !== undefined) || Boolean(child.signalCode)
    if (gone) { this.counts.alreadyExited++; this.#remember(entry, child.exitCode ?? null, child.signalCode ?? null); return null }
    if (typeof child.once !== 'function' || this.running.size >= WORKER_ACTIVE_LIMIT) { this.counts.notRegistered++; return null }
    this.counts.registered++
    this.running.set(entry.sequence, entry)
    const done = (code, signal) => this.#exited(entry.sequence, code, signal)
    child.once('exit', done)
    child.once('close', done)
    return entry.sequence
  }

  #exited(sequence, code, signal) {
    const entry = this.running.get(sequence)
    if (!entry) return
    this.running.delete(sequence)
    this.measurements.delete(sequence)
    this.counts.exited++
    this.#remember(entry, code ?? null, signal ?? null)
  }

  #remember(entry, exitCode, signal) {
    const exitedAt = this.now()
    this.recent.unshift({ pid: entry.pid, role: entry.role, stage: entry.stage, model: entry.model, jobId: entry.jobId,
      hostJobId: entry.hostJobId, spawnedAt: new Date(entry.spawnedAt).toISOString(), exitedAt: new Date(exitedAt).toISOString(),
      livedMs: Math.max(0, exitedAt - entry.spawnedAt), exitCode, signal })
    this.recent = this.recent.slice(0, WORKER_RECENT_LIMIT)
  }

  /**
   * Bind a listed worker to the creation time the operating system reports for that pid. The first
   * answer must agree with the host's own spawn time; every later answer must be the same creation
   * time, so a pid that Windows hands to a different process is never read as this worker.
   */
  verifyIdentity(pid, creationFiletime, createdAtMs) {
    const entry = [...this.running.values()].find(item => item.pid === pid)
    if (!entry || typeof creationFiletime !== 'string' || !creationFiletime) return false
    if (entry.osCreation) return entry.osCreation === creationFiletime
    if (!Number.isFinite(createdAtMs) || createdAtMs < entry.spawnedAt - 10_000 || createdAtMs > entry.spawnedAt + 2_000) return false
    entry.osCreation = creationFiletime
    entry.osCreatedAtMs = createdAtMs
    return true
  }

  /** One read for every listed worker. Never throws; never overlaps itself. */
  async sampleMemory() {
    if (!this.readMemory || this.sampling) return
    const requested = [...this.running.values()].map(entry => ({ sequence: entry.sequence, pid: entry.pid }))
    if (!requested.length) { this.measurements.clear(); return }
    this.sampling = true
    try {
      const result = await this.readMemory(requested.map(item => item.pid))
      const next = new Map()
      for (const { sequence, pid } of requested) {
        // Measurements are keyed by sequence, never by pid, so a reused pid cannot inherit a dead worker's
        // value. This skip only keeps an orphaned entry out of the map.
        if (!this.running.has(sequence)) continue
        const bytes = result instanceof Map ? result.get(pid) : result?.[pid]
        const value = typeof bytes === 'number' ? mib(bytes) : null
        if (value !== null) next.set(sequence, value)
      }
      this.measurements = next
      this.measuredAt = this.now()
      this.memoryError = null
    } catch (error) {
      this.measurements = new Map()
      this.memoryError = String(error?.message || error).slice(0, 160)
    } finally { this.sampling = false }
  }

  snapshot(activeJobIds = new Set()) {
    const now = this.now()
    const hasAdapter = this.readMemory !== null
    const entries = [...this.running.values()]
    const measured = this.measuredAt !== null
    const stale = measured && now - this.measuredAt > WORKER_STALE_MS
    const usable = hasAdapter && measured && !stale && !this.memoryError
    const owned = entries.map(entry => ({
      pid: entry.pid, role: entry.role, stage: entry.stage, model: entry.model, jobId: entry.jobId, hostJobId: entry.hostJobId,
      spawnedAt: new Date(entry.spawnedAt).toISOString(), ageMs: Math.max(0, now - entry.spawnedAt),
      osIdentity: entry.osCreation ? { creationFiletime: entry.osCreation, createdAtMs: entry.osCreatedAtMs } : null,
      jobStillActive: entry.jobId === null ? null : activeJobIds.has(entry.jobId),
      outlivedJob: entry.jobId === null ? null : !activeJobIds.has(entry.jobId),
      workingSetMiB: usable ? this.measurements.get(entry.sequence) ?? null : null
    }))
    const known = owned.filter(item => item.workingSetMiB !== null)
    let status
    if (!hasAdapter) status = 'no-adapter'
    else if (!entries.length) status = 'no-running-workers'
    else if (this.memoryError) status = 'adapter-error'
    else if (!measured) status = 'pending-first-sample'
    else if (stale) status = 'stale'
    else status = known.length === entries.length ? 'ok' : known.length === 0 ? 'unavailable' : 'partial'
    return {
      schema: 1,
      coverage: { scope: 'direct-children-registered-by-this-host', descendants: 'not-enumerated',
        lifecycle: 'spawn-and-exit-events', memory: status, cpu: 'unavailable', gpu: 'unavailable',
        identity: 'pid-and-host-clock-spawn-time' },
      running: owned.length, owned, recentlyExited: this.recent, counts: { ...this.counts },
      memory: { status, basis: 'working-set', includesDescendants: false, lowerBound: true, complete: status === 'ok',
        totalMiB: status === 'ok' ? known.reduce((sum, item) => sum + item.workingSetMiB, 0) : null,
        measuredAt: measured ? new Date(this.measuredAt).toISOString() : null,
        measurementAgeMs: measured ? Math.max(0, now - this.measuredAt) : null, staleAfterMs: WORKER_STALE_MS, error: this.memoryError }
    }
  }
}

const FAMILY_STALE_MS = 15_000
const PROCESS_FAMILY_OFF = Object.freeze({ schema: 1, source: 'native-process-family-sampler', status: 'unavailable',
  reason: 'disabled', measuredAt: null, ageMs: null, root: null, cpu: null, memory: null, descendants: null, processes: [],
  gpu: { status: 'unavailable', reason: 'No reliable per-process GPU counter is implemented; whole-device GPU figures are a different quantity.' } })

/**
 * @param {object} [options]
 * @param {object|null} [options.processSampler] the native process-family sampler. Left out, one is created where
 *   the helper exists (Windows) unless HIDOCK_PROCESS_SAMPLER=off; null turns it off.
 * @param {Function|null} [options.readWorkerMemory] test hook: working-set bytes by pid, used instead of the sampler's.
 */
export class HostTelemetry {
  constructor({ hasGpu = () => false, readCpu = cpuCounters, now = Date.now, gpuCommand = execFile, readWorkerMemory = null,
    processSampler } = {}) {
    this.hasGpu = hasGpu; this.readCpu = readCpu; this.now = now; this.gpuCommand = gpuCommand
    this.family = processSampler === undefined
      ? (process.env.HIDOCK_PROCESS_SAMPLER === 'off' ? null : new WindowsProcessSampler({ now })) : processSampler
    const nativeMemory = !readWorkerMemory && this.family?.available ? pids => this.#nativeWorkerMemory(pids) : null
    this.workers = new WorkerProcessRegistry({ now, readMemory: readWorkerMemory || nativeMemory })
    this.previous = null; this.gpu = null; this.gpuSampledAt = null; this.gpuPending = false
    this.active = new Map(); this.recent = []; this.completedJobs = 0; this.totalJobMs = 0
    this.outputTokens = 0; this.tokenMeasuredJobs = 0; this.tokenMeasuredJobMs = 0
    this.reading = null
    this.sample()
    this.timer = setInterval(() => this.sample(), 5000)
    this.timer.unref?.()
  }
  sample() {
    const counters = this.readCpu()
    this.reading = {
      sampledAt: new Date(this.now()).toISOString(), hostname: hostname(), logicalCores: cpus().length,
      cpuPercent: cpuPercent(this.previous, counters), memoryUsedMiB: (totalmem() - freemem()) / 1024 ** 2,
      memoryTotalMiB: totalmem() / 1024 ** 2, serviceRssMiB: process.memoryUsage().rss / 1024 ** 2
    }
    this.previous = counters
    void this.#measureProcesses()
    if (!this.hasGpu() || this.gpuPending) return
    this.gpuPending = true
    this.gpuCommand('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'
    ], { timeout: 1500, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => {
      this.gpuPending = false
      this.gpu = error ? null : parseGpuCsv(stdout)
      this.gpuSampledAt = new Date(this.now()).toISOString()
    })
  }
  /** Ask the native helper first, then read the listed workers from its answer. Never throws. */
  async #measureProcesses() {
    try { await this.family?.sample() } catch { /* the sampler reports its own failure */ }
    await this.workers.sampleMemory()
  }
  /** Working-set bytes for listed workers, only from a fresh answer and only for the process whose creation time matches. */
  async #nativeWorkerMemory(pids) {
    const out = new Map()
    for (const pid of pids) {
      const hit = this.family.lookup(pid)
      if (!hit || hit.member.exited || this.now() - hit.measuredAt > FAMILY_STALE_MS) continue
      if (!this.workers.verifyIdentity(pid, hit.member.creationFiletime, hit.member.createdAtMs)) continue
      if (hit.member.workingSetBytes !== null) out.set(pid, hit.member.workingSetBytes)
    }
    return out
  }
  start(stage, model, recordingId = null, hostJobId = null) {
    const id = randomUUID()
    this.active.set(id, { id, stage, model, recordingId, hostJobId, status: 'admitted', startedAt: new Date(this.now()).toISOString() })
    return id
  }
  phase(id, status) { const job = this.active.get(id); if (job) job.status = status }
  /** List a worker the host just started for this job. Measurement must never fail the job. */
  trackWorker(id, child, role = null) {
    const job = this.active.get(id)
    return this.workers.track(child, { jobId: id ?? null, hostJobId: job?.hostJobId ?? null, stage: job?.stage ?? null,
      model: job?.model ?? null, role })
  }
  /** A spawn function for runDiarization's `spawnFn` option: same child, now also listed. */
  spawnFor(id, role = null, spawnFn = spawn) {
    return (...args) => {
      const child = spawnFn(...args)
      try { this.trackWorker(id, child, role) } catch { this.workers.counts.trackingErrors++ }
      return child
    }
  }
  finish(id, status, device = null, result = null) {
    const job = this.active.get(id)
    if (!job) return
    this.active.delete(id)
    const elapsedMs = Math.max(0, this.now() - Date.parse(job.startedAt))
    this.totalJobMs += elapsedMs
    if (status === 'completed') this.completedJobs++
    const reported = result?.outputTokens ?? result?.usage?.output_tokens
    const outputTokens = status === 'completed' && Number.isSafeInteger(reported) && reported >= 0 ? reported : null
    if (outputTokens !== null) {
      this.outputTokens += outputTokens; this.tokenMeasuredJobs++; this.tokenMeasuredJobMs += elapsedMs
    }
    this.recent.unshift({ ...job, status, device, elapsedMs, outputTokens,
      outputTokensPerSecondAverage: outputTokens !== null && elapsedMs > 0 ? outputTokens / (elapsedMs / 1000) : null,
      tokenRateBasis: 'job-wall-average', completedAt: new Date(this.now()).toISOString() })
    this.recent = this.recent.slice(0, 20)
  }
  snapshot() {
    return {
      ...this.reading, gpu: this.gpu, gpuSampledAt: this.gpuSampledAt,
      activeJobs: [...this.active.values()].map(job => ({
        ...job, elapsedMs: Math.max(0, this.now() - Date.parse(job.startedAt))
      })), recentJobs: this.recent, completedJobs: this.completedJobs, totalJobMs: this.totalJobMs,
      tokens: this.tokenMeasuredJobs ? this.outputTokens : null,
      outputTokensPerSecond: null, outputTokensPerSecondAverage: this.tokenMeasuredJobs && this.tokenMeasuredJobMs > 0
        ? this.outputTokens / (this.tokenMeasuredJobMs / 1000) : null,
      tokenMeasuredJobs: this.tokenMeasuredJobs, tokenMeasuredJobMs: this.tokenMeasuredJobMs,
      completedJobsWithoutTokenUsage: this.completedJobs - this.tokenMeasuredJobs,
      tokenRateBasis: 'completed-measured-job-wall-average',
      // serviceRssMiB above is the Node service process alone. It is not the service plus its workers.
      serviceRssScope: 'service-process-only',
      workerProcesses: this.workers.snapshot(new Set(this.active.keys())),
      processFamily: this.family ? this.family.report(FAMILY_STALE_MS) : PROCESS_FAMILY_OFF
    }
  }
  stop() { clearInterval(this.timer); this.family?.stop() }
}

