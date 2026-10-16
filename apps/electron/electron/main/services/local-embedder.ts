import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { availableParallelism, freemem, totalmem } from 'os'
import { getConfig, getDataPath } from './config'
import { isRecoveryMode } from '../recovery-mode'
import { guardOwnedWorker } from './worker-resource-guard'
import { inLocalComputeSlot, localMemoryReserveBytes } from './local-compute-slot'
import { LocalEmbedderService as Runtime, type EmbedderDeps, type EmbedPurpose } from './local-embedder-runtime'
export { meanPoolNormalize } from './local-embedder-runtime'
export type { EmbedderDeps, EmbedPurpose, EmbedSession, EmbedTokenizer } from './local-embedder-runtime'

const modelDirectory = () => join(getDataPath(), 'models', 'nemotron-3-embed-1b')

// Injectable algorithm seam; production uses a separate process.
export class LocalEmbedderService extends Runtime {
  constructor(deps?: EmbedderDeps) { super(deps, modelDirectory()) }
}

type Embedder = Pick<LocalEmbedderService, 'isModelPresent' | 'embed'> & {
  isPaused?: () => boolean; getPauseReason?: () => string | null
  getState?: () => 'not-loaded' | 'working' | 'idle' | 'paused'
}
let instance: Embedder | null = null

/**
 * How long the worker may sit with no request in flight before it is released.
 *
 * The worker holds Nemotron-3-Embed-1B: a billion parameters, ~4 GB resident
 * as ONNX fp32. Indexing needs it; an idle app does not, and before this the
 * process lived until quit — measured at 4.2 GB working set hours after the
 * last chunk was embedded. Releasing it costs one model reload (a few seconds)
 * the next time something needs a vector, against 4 GB back for everything
 * else on the machine in between.
 */
function idleTeardownMs(): number {
  const seconds = Number(getConfig().transcription.localModelIdleSeconds ?? 60)
  return (Number.isFinite(seconds) ? Math.max(0, Math.min(600, seconds)) : 60) * 1000
}

class IsolatedEmbedder implements Embedder {
  private child: Electron.UtilityProcess | null = null
  private releaseGuard: (() => void) | null = null
  private appliedPolicy = ''
  private nextId = 0
  private pending = new Map<number, { resolve: (value: number[][] | null) => void; timer: NodeJS.Timeout }>()
  private stopped = false
  private memoryMonitor: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private quitCleanupRegistered = false
  private admissionPaused = false
  private admissionBytes = 0
  private lastAdmissionCheck = 0

  isModelPresent(): boolean { return existsSync(join(modelDirectory(), 'onnx', 'model.onnx')) }
  isPaused(): boolean {
    if (isRecoveryMode()) return true
    // No retry timer or model spawn. A future query/status check may discover
    // that transient pre-load pressure cleared, at most once per 30 seconds.
    if (this.admissionPaused && Date.now() - this.lastAdmissionCheck >= 30_000) {
      this.lastAdmissionCheck = Date.now()
      if (this.admissionBytes <= Math.min(8 * 1024 ** 3, totalmem() * 0.125, freemem() * 0.5)) {
        this.admissionPaused = false
        this.stopped = false
      }
    }
    return this.stopped
  }
  getPauseReason(): string | null {
    if (isRecoveryMode()) return 'Local models disabled for this recovery launch.'
    if (!this.isPaused()) return null
    return this.admissionPaused
      ? 'Local indexing paused before model load: insufficient RAM. The budget is rechecked on future requests.'
      : 'Local indexing stopped after a resource limit or worker failure. Restart HiDock to retry.'
  }
  getState(): 'not-loaded' | 'working' | 'idle' | 'paused' {
    return this.isPaused() ? 'paused' : !this.child ? 'not-loaded' : this.pending.size ? 'working' : 'idle'
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Arm the idle release. Called whenever the last in-flight request settles.
   * Releasing goes through reset(), which nulls `this.child` BEFORE killing it,
   * so the child's 'exit' handler sees a stale reference and does not flip
   * `stopped` — an idle release must leave the embedder able to respawn,
   * unlike a crash or a blown memory budget.
   */
  private scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    const delay = idleTeardownMs()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.stopped || !this.child || this.pending.size > 0) return
      console.info('[LocalEmbedder] Idle for ' + delay / 1000 + 's; releasing worker so the model unloads')
      this.reset()
    }, delay)
    this.idleTimer.unref()
  }

  private reset(): void {
    const child = this.child
    this.child = null
    this.clearIdleTimer()
    if (this.memoryMonitor) clearInterval(this.memoryMonitor)
    this.memoryMonitor = null
    this.releaseGuard?.()
    this.releaseGuard = null
    child?.kill()
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer)
      resolve(null)
    }
    this.pending.clear()
  }

  embed(texts: string[], purpose: EmbedPurpose = 'passage'): Promise<number[][] | null> {
    if (this.isPaused()) return Promise.resolve(null)
    // Queue wait does not spend another request's execution deadline.
    const work = this.queue.then(() => inLocalComputeSlot(() => this.runEmbed(texts, purpose),
      () => !this.isPaused())).catch(error => {
      if (String(error).includes('Local processing cancelled')) return null
      throw error
    })
    this.queue = work.catch(() => undefined)
    return work
  }

  private async runEmbed(texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
    if (!texts.length) return []
    if (this.isPaused() || !this.isModelPresent()) return null
    const policy = getConfig().transcription
    const policyKey = JSON.stringify([policy.speakerLinkingCpuPercent ?? 50, policy.localComputePriority ?? 'below-normal'])
    // The admission lane guarantees that no inference is active here.
    if (this.child && this.appliedPolicy !== policyKey) this.reset()
    if (!this.child) {
      const { app, utilityProcess } = await import('electron')
      const { getStartupState } = await import('../startup-state')
      if (this.stopped) return null
      if (!this.child) {
        const runtimeDir = getStartupState().runtimeDir
        if (!runtimeDir) throw new Error('Local embedding worker requested before startup initialization')
        const workerPath = join(runtimeDir, 'local-embedder-worker.js')
        const configured = Number(getConfig().transcription.speakerLinkingCpuPercent ?? 50)
        const cpuPercent = Number.isFinite(configured) ? Math.max(10, Math.min(100, configured)) : 50
        // Leave at least half of currently free RAM available to other apps.
        const memoryBudget = Math.min(8 * 1024 ** 3, totalmem() * 0.125, freemem() * 0.5)
        // Admission must happen before ONNX allocates its weights, not only after
        // a one-second sampler discovers the machine is already under pressure.
        const weightsPath = join(modelDirectory(), 'onnx', 'model.onnx.data')
        const weightsBytes = statSync(existsSync(weightsPath) ? weightsPath
          : join(modelDirectory(), 'onnx', 'model.onnx')).size
        const admissionBytes = weightsBytes * 1.35 + 512 * 1024 ** 2
        if (admissionBytes > memoryBudget) {
          console.warn('[LocalEmbedder] Insufficient memory budget before model load; indexing paused without cloud fallback')
          this.stopped = true
          this.admissionPaused = true
          this.admissionBytes = admissionBytes
          this.lastAdmissionCheck = Date.now()
          return null
        }
        const threadCount = Math.max(1, Math.floor(availableParallelism() * cpuPercent / 100))
        const child = utilityProcess.fork(workerPath, [modelDirectory(), String(cpuPercent), String(threadCount)], {
          serviceName: 'HiDock local embeddings'
        })
        this.child = child
        this.appliedPolicy = policyKey
        this.memoryMonitor = setInterval(() => {
          const metrics = app.getAppMetrics().find(metric => metric.pid === child.pid)
          const workingSet = (metrics?.memory.workingSetSize ?? 0) * 1024
          if (workingSet > memoryBudget || freemem() < localMemoryReserveBytes()) {
            console.error('[LocalEmbedder] Memory budget reached; stopped without retry')
            this.stopped = true
            this.reset()
          }
        }, 1000)
        this.memoryMonitor.unref()
        child.on('message', (message: { id: number; vectors: number[][] | null; error?: string;
          backend?: string; cpuThreads?: number; type?: string; name?: string; elapsedMs?: number }) => {
          if (message.type === 'timing') {
            console.info('[LocalEmbedder] Worker timing ' + JSON.stringify({
              name: message.name, elapsedMs: message.elapsedMs
            }))
            return
          }
          const pending = this.pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error) console.error('[LocalEmbedder] Worker failed:', message.error)
          if (message.vectors?.length) console.info('[LocalEmbedder] Worker completed ' + JSON.stringify({
            vectors: message.vectors.length, dims: message.vectors[0].length,
            backend: message.backend, cpuThreads: message.cpuThreads
          }))
          pending.resolve(message.vectors)
          if (message.vectors === null) {
            this.stopped = true
            this.reset()
            return
          }
          if (this.pending.size === 0) this.scheduleIdleTeardown()
        })
        child.on('exit', () => {
          if (this.child === child) {
            this.stopped = true
            this.reset()
          }
        })
        try {
          if (!child.pid) await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timer)
              child.removeListener('spawn', spawned)
              child.removeListener('exit', exited)
            }
            const spawned = () => { cleanup(); resolve() }
            const exited = () => { cleanup(); reject(new Error('Embedding worker exited before spawn')) }
            const timer = setTimeout(() => { cleanup(); reject(new Error('Embedding worker spawn timed out')) }, 10000)
            child.once('spawn', spawned)
            child.once('exit', exited)
          })
          if (this.child !== child || this.stopped) return null
          if (!child.pid) throw new Error('Embedding worker has no process id')
          this.releaseGuard = await guardOwnedWorker(child.pid, memoryBudget, () => {
            this.stopped = true
            this.reset()
          })
          if (this.child !== child) { this.releaseGuard(); this.releaseGuard = null; return null }
        } catch (error) {
          console.error('[LocalEmbedder] Resource policy refused worker:', error)
          this.stopped = true
          this.reset()
          return null
        }
        if (!this.quitCleanupRegistered) {
          app.once('before-quit', () => { this.admissionPaused = false; this.stopped = true; this.reset() })
          this.quitCleanupRegistered = true
        }
      }
    }
    const id = ++this.nextId
    // New work: the worker is needed again, so it must not be released under us.
    this.clearIdleTimer()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error('[LocalEmbedder] Worker exceeded 90 seconds; stopped without retry')
        this.stopped = true
        this.reset()
      }, 90000)
      this.pending.set(id, { resolve, timer })
      try { this.child!.postMessage({ id, texts, purpose }) } catch {
        this.stopped = true
        this.reset()
      }
    })
  }
}

export function getLocalEmbedder(): Embedder {
  if (!instance) instance = new IsolatedEmbedder()
  return instance
}

export function setLocalEmbedderForTests(service: LocalEmbedderService | null): void {
  instance = service
}
