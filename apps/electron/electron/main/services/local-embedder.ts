import { existsSync } from 'fs'
import { join } from 'path'
import { freemem, totalmem } from 'os'
import { getConfig, getDataPath } from './config'
import { LocalEmbedderService as Runtime, type EmbedderDeps, type EmbedPurpose } from './local-embedder-runtime'
export { meanPoolNormalize } from './local-embedder-runtime'
export type { EmbedderDeps, EmbedPurpose, EmbedSession, EmbedTokenizer } from './local-embedder-runtime'

const modelDirectory = () => join(getDataPath(), 'models', 'nemotron-3-embed-1b')

// Injectable algorithm seam; production uses a separate process.
export class LocalEmbedderService extends Runtime {
  constructor(deps?: EmbedderDeps) { super(deps, modelDirectory()) }
}

type Embedder = Pick<LocalEmbedderService, 'isModelPresent' | 'embed'> & { isPaused?: () => boolean }
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
const IDLE_TEARDOWN_MS = 60_000

class IsolatedEmbedder implements Embedder {
  private child: Electron.UtilityProcess | null = null
  private nextId = 0
  private pending = new Map<number, { resolve: (value: number[][] | null) => void; timer: NodeJS.Timeout }>()
  private stopped = false
  private memoryMonitor: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()

  isModelPresent(): boolean { return existsSync(join(modelDirectory(), 'onnx', 'model.onnx')) }
  isPaused(): boolean { return this.stopped }

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
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.stopped || !this.child || this.pending.size > 0) return
      console.info('[LocalEmbedder] Idle for ' + IDLE_TEARDOWN_MS / 1000 + 's; releasing worker so the model unloads')
      this.reset()
    }, IDLE_TEARDOWN_MS)
    this.idleTimer.unref()
  }

  private reset(): void {
    const child = this.child
    this.child = null
    this.clearIdleTimer()
    if (this.memoryMonitor) clearInterval(this.memoryMonitor)
    this.memoryMonitor = null
    child?.kill()
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer)
      resolve(null)
    }
    this.pending.clear()
  }

  embed(texts: string[], purpose: EmbedPurpose = 'passage'): Promise<number[][] | null> {
    // Queue wait does not spend another request's execution deadline.
    const work = this.queue.then(() => this.runEmbed(texts, purpose))
    this.queue = work.catch(() => undefined)
    return work
  }

  private async runEmbed(texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
    if (!texts.length) return []
    if (this.stopped || !this.isModelPresent()) return null
    if (!this.child) {
      const { app, utilityProcess } = await import('electron')
      const { getStartupState } = await import('../startup-state')
      if (this.stopped) return null
      if (!this.child) {
        const runtimeDir = getStartupState().runtimeDir
        if (!runtimeDir) throw new Error('Local embedding worker requested before startup initialization')
        const workerPath = join(runtimeDir, 'local-embedder-worker.js')
        const configured = Number(getConfig().embeddings.localCpuPercent ?? 50)
        const cpuPercent = Number.isFinite(configured) ? Math.max(10, Math.min(75, configured)) : 50
        // Leave at least half of currently free RAM available to other apps.
        const memoryBudget = Math.min(8 * 1024 ** 3, totalmem() * 0.125, freemem() * 0.5)
        const child = utilityProcess.fork(workerPath, [modelDirectory(), String(cpuPercent)], {
          serviceName: 'HiDock local embeddings'
        })
        this.child = child
        this.memoryMonitor = setInterval(() => {
          const metrics = app.getAppMetrics().find(metric => metric.pid === child.pid)
          const workingSet = (metrics?.memory.workingSetSize ?? 0) * 1024
          if (workingSet > memoryBudget || freemem() < Math.min(totalmem() * 0.08, 2 * 1024 ** 3)) {
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
          if (this.pending.size === 0) this.scheduleIdleTeardown()
        })
        child.on('exit', () => {
          if (this.child === child) {
            this.stopped = true
            this.reset()
          }
        })
        app.once('before-quit', () => { this.stopped = true; this.reset() })
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
