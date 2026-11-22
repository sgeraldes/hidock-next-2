// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
// Real Model Host code (apps/model-host/src). Plain ESM without type declarations.
import { createHostServer } from '../../../../../model-host/src/server.mjs'
import { WorkerJobs } from '../../../../../model-host/src/jobs.mjs'
import { HostState, READY } from '../../../../../model-host/src/state.mjs'

const mocks = vi.hoisted(() => ({
  list: vi.fn(), save: vi.fn(), result: vi.fn(),
  create: vi.fn(() => ({ id: 'run' })), complete: vi.fn(), fail: vi.fn(), checkpoint: vi.fn()
}))
vi.mock('../stage-checkpoints', () => ({ saveStageCheckpoint: mocks.checkpoint }))
vi.mock('../remote-job-checkpoints', () => ({ listRecoverableRemoteJobs: mocks.list,
  remoteJobCheckpoints: () => ({ save: mocks.save, saveResult: mocks.result }) }))
vi.mock('../database', () => ({ createProcessingRun: mocks.create, completeProcessingRun: mocks.complete,
  failProcessingRun: mocks.fail }))
// model-host-transport and transcription-activity are the real modules: native fetch over http://127.0.0.1.
import { getActiveTranscriptionCount } from '../transcription-activity'
import { cancelRecoveredRemote, recoveredRemoteRecordings, recoverRemoteJobs, stopRemoteRecovery } from '../remote-job-recovery'
import { createRemoteRecoverySupervisor } from '../remote-recovery-supervisor'

const TOKEN = 'loopback-fixture-token'
const MODEL = 'microsoft/VibeVoice-ASR'
const LOCAL_RECORDING = 'local-recording-fixture'
const REMOTE_RECORDING = 'remote-recording-fixture'
const syntheticResult = { model: MODEL, modelVersion: 'synthetic-executor', text: 'synthetic text',
  segments: [{ start: 0, end: 1, text: 'synthetic text', speaker: '1' }] }

const cleanups: Array<() => Promise<void> | void> = []
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear()
})
afterEach(async () => {
  stopRemoteRecovery()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const listen = (server: Server) => new Promise<string>(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
})
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })

describe('remote recovery against the real Model Host over loopback', () => {
  it('stop during a pending GET releases only the observer and leaves the host job untouched', async () => {
    // Real WorkerJobs on a disposable directory, blocking synthetic executor, no model.
    const directory = await mkdtemp(join(tmpdir(), 'hidock-recovery-loopback-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>(resolve => { releaseExecutor = resolve })
    const execute = vi.fn(async (_path: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        void executorGate.then(resolve)
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return syntheticResult
    })
    const state = new HostState({ initial: READY })
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    await jobs.initialize()

    const host = createHostServer({ state, jobs,
      pairing: { accepts: (header: string) => header === `Bearer ${TOKEN}` },
      capabilities: () => ({ capabilities: [], asrModels: [MODEL] }), jobOptions: () => ({}) })
    const hostBase = await listen(host)
    cleanups.push(() => close(host))

    // Synthetic job created and uploaded straight to the real host; the recovery client never creates or uploads.
    const audio = Buffer.from('synthetic loopback payload, not a recording')
    const audioHash = createHash('sha256').update(audio).digest('hex')
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const created = await (await fetch(`${hostBase}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'loopback-stop-fixture-key', audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', extension: '.wav', recordingId: REMOTE_RECORDING }) })).json() as { id: string }
    const upload = await fetch(`${hostBase}/v1/jobs/${created.id}/audio`, { method: 'PUT', headers, body: audio })
    expect(upload.status).toBe(202)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')
    const jobFiles = (await readdir(directory)).filter(file => file.endsWith('.json')).sort()

    // Loopback gate in front of the host: forwards everything, holds the second recovery GET until released.
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = []
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const proxy = createServer((req, res) => {
      void (async () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
        if (req.method === 'GET' && seen.filter(item => item.method === 'GET').length === 2) await gate
        const upstream = await fetch(hostBase + req.url, { method: req.method,
          headers: { authorization: String(req.headers.authorization ?? '') } })
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(await upstream.text())
      })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
    })
    const proxyBase = await listen(proxy)
    cleanups.push(() => close(proxy))

    const request = { base: proxyBase, audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', recordingId: REMOTE_RECORDING }
    mocks.list.mockReturnValue([{ recordingId: LOCAL_RECORDING, key: 'lookup',
      identity: { key: 'loopback-stop-fixture-key', id: created.id, request } }])
    const ready = vi.fn()
    await recoverRemoteJobs({ modelHostUrl: proxyBase, modelHostToken: TOKEN }, ready)

    // First GET: running; observer registers. Second GET (after the 1.5 s poll interval): held open by the gate.
    await vi.waitFor(() => expect(seen.filter(item => item.method === 'GET')).toHaveLength(2), { timeout: 8000, interval: 25 })
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1)
    expect(recoveredRemoteRecordings()).toEqual([LOCAL_RECORDING])

    stopRemoteRecovery()
    // Let the host finish for real so the held GET returns a valid completed body.
    releaseExecutor()
    await vi.waitFor(() => expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('completed'), { timeout: 5000, interval: 25 })
    releaseGate()
    await vi.waitFor(() => expect(mocks.fail).toHaveBeenCalled(), { timeout: 5000, interval: 25 })

    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('stopped'), false)
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([])
    // Everything the recovery client sent: authenticated GETs of the one retained job. No POST /cancel, no create, no upload.
    expect(seen).toEqual(seen.map(() => ({ method: 'GET', url: `/v1/jobs/${created.id}`, authorization: `Bearer ${TOKEN}` })))
    expect(seen.length).toBe(2)
    expect(execute).toHaveBeenCalledOnce()
    expect(jobs.jobs.size).toBe(1)
    expect((await readdir(directory)).filter(file => file.endsWith('.json')).sort()).toEqual(jobFiles)
    expect((await readdir(directory)).filter(file => file.endsWith('.audio'))).toEqual([])
  })

  it('explicit cancel sends one POST /cancel and settles only after the host reports cancelled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-recovery-loopback-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    let executorSawAbort = false
    const execute = vi.fn((_path: string, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { executorSawAbort = true; reject(new Error('aborted')) }, { once: true })
    }))
    const state = new HostState({ initial: READY })
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    await jobs.initialize()
    const host = createHostServer({ state, jobs,
      pairing: { accepts: (header: string) => header === `Bearer ${TOKEN}` },
      capabilities: () => ({ capabilities: [], asrModels: [MODEL] }), jobOptions: () => ({}) })
    const hostBase = await listen(host)
    cleanups.push(() => close(host))

    const audio = Buffer.from('synthetic loopback payload for cancel, not a recording')
    const audioHash = createHash('sha256').update(audio).digest('hex')
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const created = await (await fetch(`${hostBase}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'loopback-cancel-fixture-key', audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', extension: '.wav', recordingId: REMOTE_RECORDING }) })).json() as { id: string }
    expect((await fetch(`${hostBase}/v1/jobs/${created.id}/audio`, { method: 'PUT', headers, body: audio })).status).toBe(202)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')

    // Pass-through recorder: forwards method, path and bearer to the real host, holds nothing.
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = []
    const proxy = createServer((req, res) => {
      void (async () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
        const upstream = await fetch(hostBase + req.url, { method: req.method,
          headers: { authorization: String(req.headers.authorization ?? '') } })
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(await upstream.text())
      })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
    })
    const proxyBase = await listen(proxy)
    cleanups.push(() => close(proxy))

    const request = { base: proxyBase, audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', recordingId: REMOTE_RECORDING }
    mocks.list.mockReturnValue([{ recordingId: LOCAL_RECORDING, key: 'lookup',
      identity: { key: 'loopback-cancel-fixture-key', id: created.id, request } }])
    const ready = vi.fn()
    await recoverRemoteJobs({ modelHostUrl: proxyBase, modelHostToken: TOKEN }, ready)

    // The observer has seen `running`, registered its activity reference and opened its processing run.
    await vi.waitFor(() => expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1), { timeout: 5000, interval: 25 })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(seen.map(item => item.method)).toEqual(['GET'])

    cancelRecoveredRemote(LOCAL_RECORDING)
    // The observer polls the host every 1.5 s and settles after the GET that reports `cancelled`.
    // 8 s ran out once under the full suite's load (16-oct-2026); the test's own timeout is 30 s.
    await vi.waitFor(() => expect(recoveredRemoteRecordings()).toEqual([]), { timeout: 20000, interval: 25 })

    // Exactly one authenticated POST for the synthetic job; everything else is a GET of that job.
    const posts = seen.filter(item => item.method === 'POST')
    expect(posts).toEqual([{ method: 'POST', url: `/v1/jobs/${created.id}/cancel`, authorization: `Bearer ${TOKEN}` }])
    expect(seen.filter(item => item.method !== 'POST')
      .every(item => item.method === 'GET' && item.url === `/v1/jobs/${created.id}` && item.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen[seen.length - 1].method).toBe('GET') // cancelled is confirmed by a GET after the POST
    expect(seen.indexOf(posts[0])).toBeGreaterThan(0)

    // Host side: real WorkerJobs aborted the executor and persisted the terminal state.
    expect(executorSawAbort).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('cancelled')
    await jobs.writes
    const persisted = JSON.parse(await readFile(join(directory, `${created.id}.json`), 'utf8')) as { status: string; result?: unknown }
    expect(persisted.status).toBe('cancelled')
    expect(persisted.result).toBeUndefined()
    expect((await readdir(directory)).filter(file => file.endsWith('.audio'))).toEqual([])
    expect(jobs.jobs.size).toBe(1)

    // Client side: local run closed as cancelled (third argument true) only after that confirmation.
    expect(mocks.fail).toHaveBeenCalledOnce()
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('cancelled'), true)
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('a rejected cancel leaves the host job running and a later reattach accepts its completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-recovery-loopback-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>(resolve => { releaseExecutor = resolve })
    let executorSawAbort = false
    const execute = vi.fn(async (_path: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        void executorGate.then(resolve)
        options.signal.addEventListener('abort', () => {
          executorSawAbort = true
          reject(new Error('aborted'))
        }, { once: true })
      })
      return syntheticResult
    })
    const state = new HostState({ initial: READY })
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    await jobs.initialize()
    const cancelOnHost = vi.spyOn(jobs, 'cancel')
    const host = createHostServer({ state, jobs,
      pairing: { accepts: (header: string) => header === `Bearer ${TOKEN}` },
      capabilities: () => ({ capabilities: [], asrModels: [MODEL] }), jobOptions: () => ({}) })
    const hostBase = await listen(host)
    cleanups.push(() => close(host))

    const audio = Buffer.from('synthetic loopback payload for rejected cancel, not a recording')
    const audioHash = createHash('sha256').update(audio).digest('hex')
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const created = await (await fetch(`${hostBase}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'loopback-rejected-fixture-key', audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', extension: '.wav', recordingId: REMOTE_RECORDING }) })).json() as { id: string }
    expect((await fetch(`${hostBase}/v1/jobs/${created.id}/audio`, { method: 'PUT', headers, body: audio })).status).toBe(202)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')

    // Forwards GETs to the real host; answers the one POST /cancel with 503 itself and never forwards it.
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = []
    const proxy = createServer((req, res) => {
      void (async () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
        if (req.method === 'POST' && req.url === `/v1/jobs/${created.id}/cancel`) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'synthetic cancel rejection' }))
          return
        }
        const upstream = await fetch(hostBase + req.url, { method: req.method,
          headers: { authorization: String(req.headers.authorization ?? '') } })
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(await upstream.text())
      })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
    })
    const proxyBase = await listen(proxy)
    cleanups.push(() => close(proxy))

    const request = { base: proxyBase, audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', recordingId: REMOTE_RECORDING }
    mocks.list.mockReturnValue([{ recordingId: LOCAL_RECORDING, key: 'lookup',
      identity: { key: 'loopback-rejected-fixture-key', id: created.id, request } }])
    const config = { modelHostUrl: proxyBase, modelHostToken: TOKEN }
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.waitFor(() => expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1), { timeout: 5000, interval: 25 })

    cancelRecoveredRemote(LOCAL_RECORDING)
    await vi.waitFor(() => expect(mocks.fail).toHaveBeenCalled(), { timeout: 8000, interval: 25 })

    // First observer: one rejected POST, then it ends. Cancellation is not marked, nothing terminal is stored.
    expect(seen).toEqual([
      { method: 'GET', url: `/v1/jobs/${created.id}`, authorization: `Bearer ${TOKEN}` },
      { method: 'POST', url: `/v1/jobs/${created.id}/cancel`, authorization: `Bearer ${TOKEN}` }
    ])
    expect(mocks.fail).toHaveBeenCalledOnce()
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('Remote cancellation not confirmed'), false)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([])
    // Host never saw the cancel: job still running, executor not aborted.
    expect(cancelOnHost).not.toHaveBeenCalled()
    expect(executorSawAbort).toBe(false)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')
    expect(execute).toHaveBeenCalledOnce()

    // The synthetic executor finishes; reattaching by the same retained identity accepts the completed job.
    releaseExecutor()
    await vi.waitFor(() => expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('completed'), { timeout: 5000, interval: 25 })
    await recoverRemoteJobs(config, ready)
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 5000, interval: 25 })
    await vi.waitFor(() => expect(recoveredRemoteRecordings()).toEqual([]), { timeout: 5000, interval: 25 })

    expect(ready).toHaveBeenCalledWith(LOCAL_RECORDING, MODEL, 'transcription')
    expect(mocks.result).toHaveBeenCalledOnce()
    expect(mocks.result).toHaveBeenCalledWith('lookup', { ...syntheticResult, hostJobId: created.id })
    expect(mocks.checkpoint).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledWith('lookup', expect.objectContaining({ id: created.id, observedStatus: 'completed' }))
    expect(mocks.fail).toHaveBeenCalledOnce() // only the first observer's run; the reattach never opened one
    // Whole conversation: the single rejected POST, then GETs of the one retained job. No create, no upload, no second cancel.
    expect(seen.filter(item => item.method !== 'GET')).toEqual([
      { method: 'POST', url: `/v1/jobs/${created.id}/cancel`, authorization: `Bearer ${TOKEN}` }
    ])
    expect(seen.every(item => item.url === `/v1/jobs/${created.id}` || item.method === 'POST')).toBe(true)
    expect(cancelOnHost).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(jobs.jobs.size).toBe(1)
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
  })

  it('transport outage keeps the host job running; a manual reattach to the same job finishes it once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-recovery-loopback-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>(resolve => { releaseExecutor = resolve })
    let executorSawAbort = false
    const execute = vi.fn(async (_path: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        void executorGate.then(resolve)
        options.signal.addEventListener('abort', () => {
          executorSawAbort = true
          reject(new Error('aborted'))
        }, { once: true })
      })
      return syntheticResult
    })
    const state = new HostState({ initial: READY })
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    await jobs.initialize()
    const cancelOnHost = vi.spyOn(jobs, 'cancel')
    const host = createHostServer({ state, jobs,
      pairing: { accepts: (header: string) => header === `Bearer ${TOKEN}` },
      capabilities: () => ({ capabilities: [], asrModels: [MODEL] }), jobOptions: () => ({}) })
    const hostBase = await listen(host)
    cleanups.push(() => close(host))

    const audio = Buffer.from('synthetic loopback payload for transport outage, not a recording')
    const audioHash = createHash('sha256').update(audio).digest('hex')
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const created = await (await fetch(`${hostBase}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'loopback-outage-fixture-key', audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', extension: '.wav', recordingId: REMOTE_RECORDING }) })).json() as { id: string }
    expect((await fetch(`${hostBase}/v1/jobs/${created.id}/audio`, { method: 'PUT', headers, body: audio })).status).toBe(202)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')

    // Records every request the recovery client sends. While `outage` is on it destroys the socket without
    // forwarding, so the client sees a transport failure; the host never learns about those requests.
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = []
    let outage = false
    let dropped = 0
    const proxy = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
      if (outage) { dropped++; req.socket.destroy(); return }
      void (async () => {
        const upstream = await fetch(hostBase + req.url, { method: req.method,
          headers: { authorization: String(req.headers.authorization ?? '') } })
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(await upstream.text())
      })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
    })
    const proxyBase = await listen(proxy)
    cleanups.push(() => close(proxy))

    const request = { base: proxyBase, audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', recordingId: REMOTE_RECORDING }
    mocks.list.mockReturnValue([{ recordingId: LOCAL_RECORDING, key: 'lookup',
      identity: { key: 'loopback-outage-fixture-key', id: created.id, request } }])
    const config = { modelHostUrl: proxyBase, modelHostToken: TOKEN }
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)

    // First GET saw `running`. The outage starts before the next polling GET (1.5 s later).
    await vi.waitFor(() => expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1), { timeout: 5000, interval: 25 })
    expect(mocks.create).toHaveBeenCalledOnce()
    outage = true

    // First failed GET: the observer closes its run and releases its activity reference, but it is NOT finished:
    // it stays registered and retries after 1.5 s.
    await vi.waitFor(() => expect(mocks.fail).toHaveBeenCalledOnce(), { timeout: 8000, interval: 25 })
    expect(mocks.fail).toHaveBeenCalledWith('run', 'Remote connection lost; reconnecting by retained identity')
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([LOCAL_RECORDING])

    // The third consecutive failure ends this observer for good. No second run was open, so no second fail.
    await vi.waitFor(() => expect(recoveredRemoteRecordings()).toEqual([]), { timeout: 12000, interval: 25 })
    expect(dropped).toBeGreaterThanOrEqual(3)
    expect(mocks.fail).toHaveBeenCalledOnce()
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    // Host side was never told: same job, still running, executor started once and never aborted.
    expect(cancelOnHost).not.toHaveBeenCalled()
    expect(executorSawAbort).toBe(false)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('running')
    expect(execute).toHaveBeenCalledOnce()

    // Connectivity restored. Manual reattach by the test calling recoverRemoteJobs again with the same retained
    // identity; this is not an automatic app or UI recovery.
    outage = false
    await recoverRemoteJobs(config, ready)
    await vi.waitFor(() => expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1), { timeout: 5000, interval: 25 })
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(ready).not.toHaveBeenCalled()

    releaseExecutor()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 8000, interval: 25 })
    await vi.waitFor(() => expect(recoveredRemoteRecordings()).toEqual([]), { timeout: 5000, interval: 25 })

    expect(ready).toHaveBeenCalledWith(LOCAL_RECORDING, MODEL, 'transcription')
    expect(mocks.result).toHaveBeenCalledOnce()
    expect(mocks.result).toHaveBeenCalledWith('lookup', { ...syntheticResult, hostJobId: created.id })
    expect(mocks.checkpoint).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledWith('lookup', expect.objectContaining({
      key: 'loopback-outage-fixture-key', id: created.id, observedStatus: 'completed' }))
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.fail).toHaveBeenCalledOnce() // only the outage; the reattached observer closed its run as completed
    // Everything the recovery client sent, before and after the outage: GETs of the one retained job.
    expect(seen.every(item => item.method === 'GET' && item.url === `/v1/jobs/${created.id}` &&
      item.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(cancelOnHost).not.toHaveBeenCalled()
    expect(executorSawAbort).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('completed')
    expect(jobs.jobs.size).toBe(1)
    expect((await readdir(directory)).filter(file => file.endsWith('.audio'))).toEqual([])
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
  })

  it('automatically reattaches after three transport failures using only the retained job identity', async () => {
    // Client checkpoint persistence is mocked; the Model Host, HTTP server, fetch transport,
    // and blocking synthetic executor are real. No model or recording audio is used.
    const directory = await mkdtemp(join(tmpdir(), 'hidock-recovery-supervisor-loopback-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>(resolve => { releaseExecutor = resolve })
    let executorSawAbort = false
    const execute = vi.fn(async (_path: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        void executorGate.then(resolve)
        options.signal.addEventListener('abort', () => { executorSawAbort = true; reject(new Error('aborted')) }, { once: true })
      })
      return syntheticResult
    })
    const state = new HostState({ initial: READY })
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    await jobs.initialize()
    const host = createHostServer({ state, jobs,
      pairing: { accepts: (header: string) => header === `Bearer ${TOKEN}` },
      capabilities: () => ({ capabilities: [], asrModels: [MODEL] }), jobOptions: () => ({}) })
    const hostBase = await listen(host)
    cleanups.push(() => close(host))

    // Seed one durable host job directly. The supervised client must only read this retained identity.
    const audio = Buffer.from('synthetic loopback supervisor payload, not a recording')
    const audioHash = createHash('sha256').update(audio).digest('hex')
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const createResponse = await fetch(`${hostBase}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'loopback-supervisor-fixture-key', audioHash, bytes: audio.length, model: MODEL,
      stage: 'transcription', language: 'es', extension: '.wav', recordingId: REMOTE_RECORDING }) })
    const created = await createResponse.json() as { id: string }
    const uploadResponse = await fetch(
      `${hostBase}/v1/jobs/${created.id}/audio`, { method: 'PUT', headers, body: audio })
    expect(uploadResponse.status).toBe(202)

    const seen: Array<{ method?: string; url?: string; authorization?: string }> = []
    let outage = false
    let dropped = 0
    const proxy = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
      if (outage && dropped < 3) { dropped++; req.socket.destroy(); return }
      void (async () => {
        const upstream = await fetch(hostBase + req.url, { method: req.method,
          headers: { authorization: String(req.headers.authorization ?? '') } })
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(await upstream.text())
      })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
    })
    const proxyBase = await listen(proxy)
    cleanups.push(() => close(proxy))

    const request = { base: proxyBase, audioHash, bytes: audio.length, model: MODEL, stage: 'transcription',
      language: 'es', recordingId: REMOTE_RECORDING }
    // This mock represents the durable client checkpoint table: completed identities stop being recoverable.
    let recoverable = [{ recordingId: LOCAL_RECORDING, key: 'lookup',
      identity: { key: 'loopback-supervisor-fixture-key', id: created.id, request } }]
    mocks.list.mockImplementation(() => recoverable)
    mocks.save.mockImplementation((_key, identity) => {
      if (identity.observedStatus === 'completed') recoverable = []
    })
    const currentConfig = { modelHostUrl: proxyBase, modelHostToken: TOKEN }
    const ready = vi.fn()
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => currentConfig,
      recover: recoverRemoteJobs, onComplete: ready, intervalMs: 50 })
    cleanups.push(() => supervisor.stop())
    supervisor.start()

    await vi.waitFor(() => expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(1),
      { timeout: 5000, interval: 25 })
    expect(mocks.create).toHaveBeenCalledOnce()
    outage = true
    await vi.waitFor(() => expect(dropped).toBe(3), { timeout: 8000, interval: 25 })
    // Restore transport after exactly three failed HTTP requests. The same observer exits;
    // the next bounded supervisor scan then reattaches by GET to the saved job ID.
    outage = false

    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2), { timeout: 8000, interval: 25 })
    expect(ready).not.toHaveBeenCalled()
    expect(jobs.jobs.size).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()

    releaseExecutor()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 8000, interval: 25 })
    await vi.waitFor(() => expect(recoveredRemoteRecordings()).toEqual([]), { timeout: 5000, interval: 25 })

    expect(ready).toHaveBeenCalledWith(LOCAL_RECORDING, MODEL, 'transcription')
    expect(dropped).toBe(3)
    expect(mocks.result).toHaveBeenCalledOnce()
    expect(mocks.checkpoint).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledWith('lookup', expect.objectContaining({
      key: 'loopback-supervisor-fixture-key', id: created.id, observedStatus: 'completed' }))
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.fail).toHaveBeenCalledOnce()
    expect(seen.every(item => item.method === 'GET' && item.url === `/v1/jobs/${created.id}` &&
      item.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(jobs.get(created.id, `Bearer ${TOKEN}`).status).toBe('completed')
    expect(jobs.jobs.size).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
    expect(executorSawAbort).toBe(false)
    expect(getActiveTranscriptionCount(LOCAL_RECORDING)).toBe(0)
  })
})
