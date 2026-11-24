// @vitest-environment node
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ forks: vi.fn(), metrics: vi.fn(() => [] as any[]), quit: vi.fn(),
  freeBytes: 16 * 1024 ** 3, idleSeconds: 60 }))
vi.mock('../worker-resource-guard', () => ({ guardOwnedWorker: vi.fn(async () => vi.fn()) }))
// Exercise the embedder's own admission/release rules; shared admission is tested separately.
vi.mock('../local-compute-slot', async importOriginal => ({
  ...await importOriginal<typeof import('../local-compute-slot')>(),
  inLocalComputeSlot: (task: () => Promise<unknown>) => task()
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: state.metrics, once: state.quit },
  utilityProcess: { fork: state.forks }
}))
vi.mock('fs', () => ({ existsSync: () => true, statSync: () => ({ size: 4.25 * 1024 ** 3 }) }))
vi.mock('../config', () => ({ getDataPath: () => 'test-data', getConfig: () => ({ transcription: {
  speakerLinkingCpuPercent: 50, localModelIdleSeconds: state.idleSeconds } }) }))
vi.mock('../../startup-state', () => ({ getStartupState: () => ({ runtimeDir: 'test-runtime' }) }))
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>(),
  freemem: () => state.freeBytes, totalmem: () => 64 * 1024 ** 3, availableParallelism: () => 24 }))
import { getLocalEmbedder, setLocalEmbedderForTests } from '../local-embedder'

function child() {
  return Object.assign(new EventEmitter(), { pid: 999, postMessage: vi.fn(), kill: vi.fn() })
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); state.metrics.mockReturnValue([]);
  state.freeBytes = 16 * 1024 ** 3; state.idleSeconds = 60; setLocalEmbedderForTests(null) })

describe('local embedding process boundary', () => {
  it('honors immediate idle unload without cancelling the completed request', async () => {
    vi.useFakeTimers()
    state.idleSeconds = 0
    const worker = child()
    state.forks.mockReturnValue(worker)
    const request = getLocalEmbedder().embed(['release after completion'])
    await vi.dynamicImportSettled()
    expect(worker.kill).not.toHaveBeenCalled()
    worker.emit('message', { id: 1, vectors: [[1]] })
    expect(await request).toEqual([[1]])
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.kill).toHaveBeenCalledOnce()
    expect(getLocalEmbedder().isPaused?.()).toBe(false)
  })
  it('waits for the real spawn boundary before attaching policy or dispatching inference', async () => {
    const worker = Object.assign(new EventEmitter(), { pid: undefined as number | undefined,
      postMessage: vi.fn(), kill: vi.fn() })
    state.forks.mockReturnValue(worker)
    const pending = getLocalEmbedder().embed(['spawn test'])
    await vi.dynamicImportSettled()
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(worker.kill).not.toHaveBeenCalled()
    worker.pid = 999
    worker.emit('spawn')
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
    worker.emit('message', { id: 1, vectors: [[1]] })
    expect(await pending).toEqual([[1]])
  })
  it('latches a native model failure instead of retrying initialization on every request', async () => {
    const worker = child()
    state.forks.mockReturnValue(worker)
    const first = getLocalEmbedder().embed(['first'])
    await vi.dynamicImportSettled()
    worker.emit('message', { id: 1, vectors: null, error: 'out of memory' })
    expect(await first).toBeNull()
    expect(await getLocalEmbedder().embed(['next'])).toBeNull()
    expect(state.forks).toHaveBeenCalledOnce()
    expect(worker.kill).toHaveBeenCalledOnce()
  })
  it('recovery launch never forks a model even when RAM is available', async () => {
    vi.stubEnv('HIDOCK_RECOVERY_MODE', '1')
    try {
      expect(await getLocalEmbedder().embed(['query'])).toBeNull()
      expect(getLocalEmbedder().isPaused?.()).toBe(true)
      expect(getLocalEmbedder().getPauseReason?.()).toContain('recovery')
      expect(state.forks).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
  it('does not load model weights when the available memory budget cannot fit them', async () => {
    state.freeBytes = 4 * 1024 ** 3
    expect(await getLocalEmbedder().embed(['first'])).toBeNull()
    expect(state.forks).not.toHaveBeenCalled()
    expect(getLocalEmbedder().isPaused?.()).toBe(true)
    expect(await getLocalEmbedder().embed(['retry'])).toBeNull()
    expect(state.forks).not.toHaveBeenCalled()
  })
  it('rechecks transient admission pressure without spawning or retrying a worker automatically', async () => {
    vi.useFakeTimers()
    state.freeBytes = 4 * 1024 ** 3
    expect(await getLocalEmbedder().embed(['first'])).toBeNull()
    expect(getLocalEmbedder().getPauseReason?.()).toContain('insufficient RAM')
    state.freeBytes = 16 * 1024 ** 3
    expect(getLocalEmbedder().isPaused?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(getLocalEmbedder().isPaused?.()).toBe(false)
    expect(state.forks).not.toHaveBeenCalled()
    const worker = child()
    state.forks.mockReturnValue(worker)
    const retry = getLocalEmbedder().embed(['new user query'])
    await vi.dynamicImportSettled()
    worker.emit('message', { id: 1, vectors: [[1]] })
    expect(await retry).toEqual([[1]])
  })
  it('starts each execution deadline only after its queue wait', async () => {
    vi.useFakeTimers()
    const worker = child()
    state.forks.mockReturnValue(worker)
    const a = getLocalEmbedder().embed(['first'])
    const b = getLocalEmbedder().embed(['second'])
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(60000)
    worker.emit('message', { id: 1, vectors: [[1]] })
    await a
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(60000)
    expect(worker.kill).not.toHaveBeenCalled()
    worker.emit('message', { id: 2, vectors: [[2]] })
    expect(await b).toEqual([[2]])
    state.quit.mock.calls[0][1]()
  })
  it('shares one process across concurrent requests and matches results by id', async () => {
    const worker = child()
    state.forks.mockReturnValue(worker)
    const a = getLocalEmbedder().embed(['first'])
    const b = getLocalEmbedder().embed(['second'])
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1))
    expect(state.forks).toHaveBeenCalledTimes(1)
    worker.emit('message', { id: 1, vectors: [[1]] })
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2))
    worker.emit('message', { id: 2, vectors: [[2]] })
    expect(await a).toEqual([[1]])
    expect(await b).toEqual([[2]])
    state.quit.mock.calls[0][1]()
    expect(worker.kill).toHaveBeenCalledOnce()
  })

  it('settles pending callers after a crash and prevents an automatic restart loop', async () => {
    const worker = child()
    state.forks.mockReturnValue(worker)
    const pending = getLocalEmbedder().embed(['test'])
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    worker.emit('exit', 1)
    expect(await pending).toBeNull()
    expect(await getLocalEmbedder().embed(['again'])).toBeNull()
    expect(state.forks).toHaveBeenCalledTimes(1)
  })

  it('kills a stalled model without waiting for its event loop', async () => {
    vi.useFakeTimers()
    const worker = child()
    state.forks.mockReturnValue(worker)
    const pending = getLocalEmbedder().embed(['test'])
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(90001)
    expect(await pending).toBeNull()
    expect(worker.kill).toHaveBeenCalledOnce()
  })

  it('stops the child when measured memory exceeds the adaptive budget', async () => {
    vi.useFakeTimers()
    const worker = child()
    state.forks.mockReturnValue(worker)
    state.metrics.mockReturnValue([{ pid: 999, memory: { workingSetSize: 9 * 1024 ** 2 } }])
    const pending = getLocalEmbedder().embed(['test'])
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toBeNull()
    expect(worker.kill).toHaveBeenCalledOnce()
  })

  // The worker holds a ~4 GB model. Measured 2026-09-21: it stayed resident at
  // 4.2 GB for hours after the last chunk was embedded, because nothing ever
  // released it short of quit. These pin the release AND that a release is not
  // a crash: the next request must get a fresh worker, not a permanent null.
  it('releases an idle worker after the last request settles', async () => {
    vi.useFakeTimers()
    const worker = child()
    state.forks.mockReturnValue(worker)
    const a = getLocalEmbedder().embed(['first'])
    await vi.dynamicImportSettled()
    worker.emit('message', { id: 1, vectors: [[1]] })
    expect(await a).toEqual([[1]])
    // Not yet: a request could arrive any moment.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(worker.kill).not.toHaveBeenCalled()
    // Idle window elapsed with nothing in flight: the model goes.
    await vi.advanceTimersByTimeAsync(1_001)
    expect(worker.kill).toHaveBeenCalledOnce()
  })

  it('does not release while a request is still in flight', async () => {
    vi.useFakeTimers()
    const worker = child()
    state.forks.mockReturnValue(worker)
    const a = getLocalEmbedder().embed(['first'])
    await vi.dynamicImportSettled()
    worker.emit('message', { id: 1, vectors: [[1]] })
    await a
    // Second request lands inside the idle window and disarms the release.
    const b = getLocalEmbedder().embed(['second'])
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(80_000)
    expect(worker.kill).not.toHaveBeenCalled()
    worker.emit('message', { id: 2, vectors: [[2]] })
    expect(await b).toEqual([[2]])
  })

  it('respawns a fresh worker after an idle release instead of staying stopped', async () => {
    vi.useFakeTimers()
    const first = child()
    const second = child()
    state.forks.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const a = getLocalEmbedder().embed(['first'])
    await vi.dynamicImportSettled()
    first.emit('message', { id: 1, vectors: [[1]] })
    await a
    await vi.advanceTimersByTimeAsync(60_001)
    expect(first.kill).toHaveBeenCalledOnce()
    // The real child emits 'exit' after kill(); it must NOT be read as a crash.
    first.emit('exit', 0)

    const b = getLocalEmbedder().embed(['second'])
    await vi.dynamicImportSettled()
    expect(state.forks).toHaveBeenCalledTimes(2)
    expect(state.quit).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(second.postMessage).toHaveBeenCalledOnce())
    second.emit('message', { id: 2, vectors: [[2]] })
    expect(await b).toEqual([[2]])
    expect(getLocalEmbedder().isPaused?.()).toBe(false)
  })
})
