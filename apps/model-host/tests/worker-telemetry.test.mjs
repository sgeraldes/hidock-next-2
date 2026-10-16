/**
 * Which model worker processes this host owns, and how much is honestly known about them.
 *
 * Real boundary: trivial bounded Node children started through the real spawn, tracked by the real
 * registry, with the real HostTelemetry, WorkerJobs and createHostServer around them. No model, no
 * Python, no ffmpeg, no PowerShell, no WMI. Process memory itself has no native adapter in this
 * repository, so those tests inject a function standing for one and say so in their names.
 * Every child is started by a test, waits on its own stdin and carries a self-expiry timer, and
 * nothing is ever terminated that a test did not start.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { HostTelemetry, WorkerProcessRegistry } from '../src/telemetry.mjs'
import { WorkerJobs } from '../src/jobs.mjs'
import { createHostServer } from '../src/server.mjs'
import { HostState, READY } from '../src/state.mjs'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Exits with code 7 when told to; expires by itself after 20 s so a failed test never leaves it behind.
const WAITING_CHILD = "process.stdin.once('data',()=>process.exit(7));setTimeout(()=>process.exit(3),20000)"
const GRANDPARENT = `const {spawn}=require('node:child_process');
const g=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore'});
process.stdout.write('GRANDCHILD '+g.pid+'\\n');
process.stdin.once('data',()=>process.exit(7));setTimeout(()=>process.exit(3),20000)`

function realChild(script = WAITING_CHILD, spawnFn = spawn) {
  const child = spawnFn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  child.on('error', () => {})
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  cleanups.push(async () => { if (child.exitCode === null && !child.signalCode) { child.kill(); await exited } })
  return { child, exited, finish: () => { child.stdin.write('go\n'); return exited } }
}

let nextFakePid = 900_000
function fakeChild(pid = nextFakePid++) {
  const child = new EventEmitter()
  Object.assign(child, { pid, exitCode: null, signalCode: null })
  child.exit = (code = 0, signal = null) => {
    child.exitCode = code; child.signalCode = signal
    child.emit('exit', code, signal); child.emit('close', code, signal)
  }
  return child
}

const MIB = 1024 ** 2
function registry(options = {}) {
  let now = options.start ?? 1_000_000
  const value = new WorkerProcessRegistry({ now: () => now, ...options })
  return { registry: value, advance: ms => { now += ms }, clock: () => now }
}
const bytesFor = table => async pids => new Map(pids.filter(pid => table[pid] !== undefined).map(pid => [pid, table[pid]]))

describe('worker lifecycle registry with real child processes', () => {
  it('lists a real child from spawn, answers with its real pid, and drops it on exit with the real exit code', async () => {
    const { registry: workers } = registry()
    const { child, finish } = realChild()
    expect(workers.track(child, { jobId: 'job-1', stage: 'transcription', model: 'fixture-model', role: 'job-worker' })).toBe(1)
    let snapshot = workers.snapshot(new Set(['job-1']))
    expect(snapshot.running).toBe(1)
    expect(snapshot.owned[0]).toMatchObject({ pid: child.pid, jobId: 'job-1', stage: 'transcription', model: 'fixture-model',
      role: 'job-worker', jobStillActive: true, outlivedJob: false, workingSetMiB: null })
    expect(Number.isSafeInteger(snapshot.owned[0].pid)).toBe(true)
    expect(snapshot.owned[0].pid).not.toBe(process.pid)

    expect((await finish()).code).toBe(7)
    snapshot = workers.snapshot()
    expect(snapshot.running).toBe(0)
    expect(snapshot.owned).toEqual([])
    expect(snapshot.recentlyExited).toHaveLength(1)
    expect(snapshot.recentlyExited[0]).toMatchObject({ pid: child.pid, exitCode: 7, signal: null, jobId: 'job-1' })
    expect(snapshot.counts).toMatchObject({ registered: 1, exited: 1 })
  })

  it('does not count a direct child twice, and counts the exit once even though exit and close both fire', async () => {
    const { registry: workers } = registry()
    const { child, finish } = realChild()
    expect(workers.track(child)).toBe(1)
    expect(workers.track(child)).toBeNull()
    await finish()
    expect(workers.snapshot().counts).toMatchObject({ registered: 1, exited: 1 })
    expect(workers.snapshot().recentlyExited).toHaveLength(1)
  })

  it('lists only the direct child: a descendant the worker starts is neither listed nor claimed', async () => {
    const { registry: workers } = registry()
    const { child, finish } = realChild(GRANDPARENT)
    let grandchild = null
    await new Promise(resolve => child.stdout.on('data', chunk => {
      const match = /GRANDCHILD (\d+)/.exec(String(chunk))
      if (match) { grandchild = Number(match[1]); resolve() }
    }))
    workers.track(child)
    const snapshot = workers.snapshot()
    expect(grandchild).toBeGreaterThan(0)
    expect(snapshot.owned.map(item => item.pid)).toEqual([child.pid])
    expect(snapshot.owned.map(item => item.pid)).not.toContain(grandchild)
    expect(snapshot.coverage.descendants).toBe('not-enumerated')
    expect(snapshot.memory.includesDescendants).toBe(false)
    expect(snapshot.memory.lowerBound).toBe(true)
    await finish()
    // The grandchild expires on its own timer; wait for it with an existence probe (signal 0 delivers nothing).
    await expect.poll(() => { try { process.kill(grandchild, 0); return 'alive' } catch { return 'gone' } }, { timeout: 8000 }).toBe('gone')
  })

  it('counts a spawn that never produced a process and lists nothing for it', async () => {
    const { registry: workers } = registry()
    const child = spawn(join(tmpdir(), 'hidock-no-such-executable-xyz.exe'), [], { stdio: 'ignore' })
    child.on('error', () => {})
    expect(child.pid).toBeUndefined()
    expect(workers.track(child)).toBeNull()
    expect(workers.snapshot().running).toBe(0)
    expect(workers.snapshot().counts.spawnFailures).toBe(1)
    await new Promise(resolve => setImmediate(resolve))
  })

  it('does not list a child that had already exited before it was registered', async () => {
    const { registry: workers } = registry()
    const { child, finish } = realChild()
    await finish()
    expect(workers.track(child, { jobId: 'late' })).toBeNull()
    const snapshot = workers.snapshot()
    expect(snapshot.running).toBe(0)
    expect(snapshot.counts).toMatchObject({ alreadyExited: 1, registered: 0 })
    expect(snapshot.recentlyExited[0]).toMatchObject({ pid: child.pid, exitCode: 7, jobId: 'late' })
  })

  it('keeps tracking errors out of the caller: a bad child object lists nothing and throws nothing', () => {
    const { registry: workers } = registry()
    for (const bad of [null, undefined, 42, 'x', {}, { pid: -1 }, { pid: 1.5 }, { pid: 0 }, { pid: 123 }]) {
      expect(() => workers.track(bad)).not.toThrow()
    }
    expect(workers.snapshot().running).toBe(0)
  })

  it('stops listing after the bound and says so, instead of growing without limit', () => {
    const { registry: workers } = registry()
    const children = Array.from({ length: 70 }, () => fakeChild())
    for (const child of children) workers.track(child)
    const snapshot = workers.snapshot()
    expect(snapshot.running).toBe(64)
    expect(snapshot.counts).toMatchObject({ registered: 64, notRegistered: 6 })
    for (const child of children) child.exit(0)
    expect(workers.snapshot().running).toBe(0)
    expect(workers.snapshot().recentlyExited.length).toBeLessThanOrEqual(20)
  })
})

describe('lifecycle races', () => {
  it('keeps a worker\'s measurement away from a new worker that reused its pid while the read was in flight', async () => {
    const reusedPid = 777_001
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { registry: workers } = registry({ readMemory: async pids => { await gate; return new Map(pids.map(pid => [pid, 300 * MIB])) } })
    const first = fakeChild(reusedPid)
    workers.track(first)
    const reading = workers.sampleMemory()
    first.exit(0)
    const second = fakeChild(reusedPid)
    workers.track(second)
    release()
    await reading
    const snapshot = workers.snapshot()
    expect(snapshot.owned).toHaveLength(1)
    expect(snapshot.owned[0].pid).toBe(reusedPid)
    expect(snapshot.owned[0].workingSetMiB).toBeNull()
    expect(snapshot.memory.totalMiB).toBeNull()
    expect(snapshot.memory.status).not.toBe('ok')
  })

  it('drops the measurement of a worker that exits right after being measured', async () => {
    const { registry: workers } = registry({ readMemory: bytesFor({ 501: 100 * MIB, 502: 200 * MIB }) })
    const a = fakeChild(501), b = fakeChild(502)
    workers.track(a); workers.track(b)
    await workers.sampleMemory()
    expect(workers.snapshot().memory.totalMiB).toBe(300)
    a.exit(0)
    const snapshot = workers.snapshot()
    expect(snapshot.owned.map(item => item.pid)).toEqual([502])
    expect(snapshot.memory.totalMiB).toBe(200)
    expect(snapshot.recentlyExited[0].pid).toBe(501)
  })

  it('never runs two memory reads at once', async () => {
    let calls = 0
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { registry: workers } = registry({ readMemory: async pids => { calls++; await gate; return new Map(pids.map(pid => [pid, MIB])) } })
    workers.track(fakeChild())
    const first = workers.sampleMemory()
    await workers.sampleMemory()
    release()
    await first
    expect(calls).toBe(1)
  })

  it('survives a worker exiting while no read is running and the next read finding nothing to measure', async () => {
    let calls = 0
    const { registry: workers } = registry({ readMemory: async () => { calls++; return new Map() } })
    const child = fakeChild()
    workers.track(child)
    child.exit(1, null)
    await workers.sampleMemory()
    expect(calls).toBe(0)
    expect(workers.snapshot().memory.status).toBe('no-running-workers')
  })
})

describe('memory coverage is stated, never invented', () => {
  it('says there is no adapter and reports no value when none is configured', () => {
    const { registry: workers } = registry()
    workers.track(fakeChild())
    const snapshot = workers.snapshot()
    expect(snapshot.memory).toMatchObject({ status: 'no-adapter', totalMiB: null, measuredAt: null, measurementAgeMs: null, complete: false })
    expect(snapshot.owned[0].workingSetMiB).toBeNull()
    expect(snapshot.coverage).toMatchObject({ memory: 'no-adapter', cpu: 'unavailable', gpu: 'unavailable' })
  })

  it('says it is waiting for the first read, then reports a measured total with its age and scope', async () => {
    const { registry: workers, advance } = registry({ readMemory: bytesFor({ 601: 512 * MIB, 602: 256 * MIB }) })
    workers.track(fakeChild(601)); workers.track(fakeChild(602))
    expect(workers.snapshot().memory.status).toBe('pending-first-sample')
    expect(workers.snapshot().memory.totalMiB).toBeNull()
    await workers.sampleMemory()
    advance(2500)
    const { memory, owned } = workers.snapshot()
    expect(memory).toMatchObject({ status: 'ok', complete: true, totalMiB: 768, basis: 'working-set',
      includesDescendants: false, lowerBound: true, measurementAgeMs: 2500, error: null })
    expect(owned.map(item => item.workingSetMiB)).toEqual([512, 256])
    expect(memory.measuredAt).toEqual(expect.any(String))
  })

  it('reports a partial read without a total, and leaves the unread worker null instead of zero', async () => {
    const { registry: workers } = registry({ readMemory: bytesFor({ 611: 128 * MIB }) })
    workers.track(fakeChild(611)); workers.track(fakeChild(612))
    await workers.sampleMemory()
    const { memory, owned } = workers.snapshot()
    expect(memory).toMatchObject({ status: 'partial', complete: false, totalMiB: null })
    expect(owned.find(item => item.pid === 611).workingSetMiB).toBe(128)
    expect(owned.find(item => item.pid === 612).workingSetMiB).toBeNull()
  })

  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], ['100'], [null], [undefined]])(
    'treats an adapter reading of %s as unavailable, not as a measurement', async (reading) => {
      const { registry: workers } = registry({ readMemory: async pids => new Map(pids.map(pid => [pid, reading])) })
      workers.track(fakeChild())
      await workers.sampleMemory()
      const { memory, owned } = workers.snapshot()
      expect(owned[0].workingSetMiB).toBeNull()
      expect(memory.totalMiB).toBeNull()
      expect(memory.status).toBe('unavailable')
    })

  it('accepts an adapter that answers with a plain object', async () => {
    const child = fakeChild(621)
    const { registry: workers } = registry({ readMemory: async () => ({ 621: 64 * MIB }) })
    workers.track(child)
    await workers.sampleMemory()
    expect(workers.snapshot().memory).toMatchObject({ status: 'ok', totalMiB: 64 })
  })

  it('reports an adapter failure as such, keeps no stale value, and recovers on the next good read', async () => {
    let fail = true
    const { registry: workers } = registry({ readMemory: async pids => {
      if (fail) throw new Error('access denied for synthetic reasons')
      return new Map(pids.map(pid => [pid, 10 * MIB]))
    } })
    workers.track(fakeChild())
    await expect(workers.sampleMemory()).resolves.toBeUndefined()
    let { memory, owned } = workers.snapshot()
    expect(memory).toMatchObject({ status: 'adapter-error', totalMiB: null, error: expect.stringContaining('access denied') })
    expect(owned[0].workingSetMiB).toBeNull()
    fail = false
    await workers.sampleMemory()
    ;({ memory, owned } = workers.snapshot())
    expect(memory).toMatchObject({ status: 'ok', totalMiB: 10, error: null })
  })

  it('stops reporting values once the last read is older than the staleness bound, and says how old it is', async () => {
    const { registry: workers, advance } = registry({ readMemory: bytesFor({ 631: 50 * MIB }) })
    workers.track(fakeChild(631))
    await workers.sampleMemory()
    advance(14_999)
    expect(workers.snapshot().memory).toMatchObject({ status: 'ok', totalMiB: 50 })
    advance(2)
    const { memory, owned } = workers.snapshot()
    expect(memory).toMatchObject({ status: 'stale', totalMiB: null, measurementAgeMs: 15_001, staleAfterMs: 15_000 })
    expect(owned[0].workingSetMiB).toBeNull()
  })

  it('reports no running workers when the adapter exists but nothing is listed, and never calls it', async () => {
    let calls = 0
    const { registry: workers } = registry({ readMemory: async () => { calls++; return new Map() } })
    await workers.sampleMemory()
    expect(calls).toBe(0)
    expect(workers.snapshot()).toMatchObject({ running: 0, memory: { status: 'no-running-workers', totalMiB: null } })
  })

  it('carries no NaN, Infinity or undefined anywhere in any state', async () => {
    const { registry: workers, advance } = registry({ readMemory: bytesFor({ 641: 5 * MIB }) })
    const problems = []
    const scan = (value, path = '$') => {
      if (value === undefined) problems.push(`${path} undefined`)
      else if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`${path} ${value}`)
      else if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`))
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) scan(item, `${path}.${key}`)
    }
    scan(workers.snapshot())
    workers.track(fakeChild(641)); workers.track(fakeChild(642))
    scan(workers.snapshot())
    await workers.sampleMemory()
    scan(workers.snapshot())
    advance(60_000)
    scan(workers.snapshot())
    expect(problems).toEqual([])
  })
})

describe('HostTelemetry keeps its public shape and adds workerProcesses', () => {
  const PREVIOUS_FIELDS = ['sampledAt', 'hostname', 'logicalCores', 'cpuPercent', 'memoryUsedMiB', 'memoryTotalMiB', 'serviceRssMiB',
    'gpu', 'gpuSampledAt', 'activeJobs', 'recentJobs', 'completedJobs', 'totalJobMs', 'tokens', 'outputTokensPerSecond',
    'outputTokensPerSecondAverage', 'tokenMeasuredJobs', 'tokenMeasuredJobMs', 'completedJobsWithoutTokenUsage', 'tokenRateBasis']

  function telemetry(options = {}) {
    const value = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }), ...options })
    cleanups.push(() => value.stop())
    return value
  }

  it('keeps every earlier field and labels the new block, with cpu and gpu explicitly unavailable', () => {
    const snapshot = telemetry().snapshot()
    for (const field of PREVIOUS_FIELDS) expect(snapshot, field).toHaveProperty(field)
    expect(snapshot.workerProcesses).toMatchObject({ schema: 1, running: 0,
      coverage: { scope: 'direct-children-registered-by-this-host', descendants: 'not-enumerated', cpu: 'unavailable', gpu: 'unavailable' } })
    expect(snapshot.serviceRssMiB).toEqual(expect.any(Number))
  })

  it('records workers through trackWorker and lists them under their job', async () => {
    const host = telemetry()
    const id = host.start('transcription', 'fixture-model', 'recording-1', 'durable-1')
    const { child, finish } = realChild()
    host.trackWorker(id, child, 'job-worker')
    const snapshot = host.snapshot()
    expect(snapshot.workerProcesses.owned[0]).toMatchObject({ pid: child.pid, jobId: id, hostJobId: 'durable-1',
      stage: 'transcription', model: 'fixture-model', jobStillActive: true })
    host.finish(id, 'completed')
    expect(host.snapshot().workerProcesses.owned[0]).toMatchObject({ jobStillActive: false, outlivedJob: true })
    await finish()
    expect(host.snapshot().workerProcesses.owned).toEqual([])
  })

  it('wraps a spawn function so the child it returns is the real one and is listed', async () => {
    const host = telemetry()
    const id = host.start('diarization', 'fixture-model')
    const { child, finish } = realChild(WAITING_CHILD, host.spawnFor(id, 'worker'))
    expect(child.pid).toBeGreaterThan(0)
    expect(host.snapshot().workerProcesses.owned.map(item => item.pid)).toEqual([child.pid])
    await finish()
    expect(host.snapshot().workerProcesses.recentlyExited[0]).toMatchObject({ pid: child.pid, exitCode: 7, role: 'worker' })
  })

  it('does not let a failing spawn function or a broken child take the caller down', () => {
    const host = telemetry()
    const id = host.start('diarization', 'fixture-model')
    expect(() => host.spawnFor(id, 'worker', () => { throw new Error('spawn blew up') })()).toThrow('spawn blew up')
    expect(() => host.spawnFor(id, 'worker', () => ({}))()).not.toThrow()
    expect(host.snapshot().workerProcesses.running).toBe(0)
  })

  it('reads memory on its own sampling tick through the injected adapter', async () => {
    const child = fakeChild(651)
    const host = telemetry({ readWorkerMemory: bytesFor({ 651: 96 * MIB }) })
    host.trackWorker(null, child)
    host.sample()
    await expect.poll(() => host.snapshot().workerProcesses.memory.status).toBe('ok')
    expect(host.snapshot().workerProcesses.memory.totalMiB).toBe(96)
  })

  it('reports no adapter when the native sampler is switched off and no reader is injected', () => {
    const host = telemetry({ processSampler: null })
    host.trackWorker(null, fakeChild())
    host.sample()
    expect(host.snapshot().workerProcesses.memory).toMatchObject({ status: 'no-adapter', totalMiB: null })
  })
})

describe('worker tracking through WorkerJobs and the HTTP surface', () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')

  async function wired(execute) {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-worker-telemetry-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const state = new HostState({ initial: READY })
    const host = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }) })
    cleanups.push(() => host.stop())
    const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
    jobs.telemetry = host
    await jobs.initialize()
    cleanups.push(() => jobs.close())
    const audio = Buffer.from('representative synthetic input')
    const request = { idempotencyKey: 'worker-telemetry-fixture', audioHash: hash(audio), bytes: audio.length,
      model: 'pyannote/speaker-diarization-3.1', extension: '.wav', stage: 'diarization' }
    return { jobs, host, audio, request, state }
  }

  it('lists the worker a job starts through the options it was given, and removes it when the job ends', async () => {
    let started
    let child
    let finish
    const f = await wired(async (_path, options) => {
      expect(typeof options.spawnFn).toBe('function')
      ;({ child, finish } = realChild(WAITING_CHILD, options.spawnFn))
      started = true
      await finish()
      return { model: options.model, modelVersion: 'fixture', segments: [], speakers: [] }
    })
    const job = await f.jobs.create(f.request, 'owner')
    await f.jobs.upload(job.id, 'owner', Readable.from([f.audio]))
    await expect.poll(() => started).toBe(true)
    await expect.poll(() => f.jobs.get(job.id, 'owner').status).toBe('completed')
    const final = f.host.snapshot().workerProcesses
    expect(final.running).toBe(0)
    expect(final.recentlyExited[0]).toMatchObject({ pid: child.pid, hostJobId: job.id, stage: 'diarization', exitCode: 7 })
  })

  it('shows the worker as running and tied to the active job while the job is still working', async () => {
    let finish
    let child
    let go
    const gate = new Promise(resolve => { go = resolve })
    const f = await wired(async (_path, options) => {
      ;({ child, finish } = realChild(WAITING_CHILD, options.spawnFn))
      await gate
      await finish()
      return { model: options.model, modelVersion: 'fixture', segments: [], speakers: [] }
    })
    const job = await f.jobs.create(f.request, 'owner')
    await f.jobs.upload(job.id, 'owner', Readable.from([f.audio]))
    await expect.poll(() => f.host.snapshot().workerProcesses.running).toBe(1)
    const running = f.host.snapshot()
    expect(running.workerProcesses.owned[0]).toMatchObject({ pid: child.pid, hostJobId: job.id, jobStillActive: true, outlivedJob: false })
    expect(running.activeJobs).toHaveLength(1)
    go()
    await expect.poll(() => f.jobs.get(job.id, 'owner').status).toBe('completed')
    expect(f.host.snapshot().workerProcesses.running).toBe(0)
  })

  it('flags a worker that outlives the job that started it', async () => {
    let finish
    const f = await wired(async (_path, options) => {
      ;({ finish } = realChild(WAITING_CHILD, options.spawnFn))
      return { model: options.model, modelVersion: 'fixture', segments: [], speakers: [] }
    })
    const job = await f.jobs.create(f.request, 'owner')
    await f.jobs.upload(job.id, 'owner', Readable.from([f.audio]))
    await expect.poll(() => f.jobs.get(job.id, 'owner').status).toBe('completed')
    await expect.poll(() => f.host.snapshot().activeJobs.length).toBe(0)
    const { owned } = f.host.snapshot().workerProcesses
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ jobStillActive: false, outlivedJob: true })
    await finish()
    expect(f.host.snapshot().workerProcesses.running).toBe(0)
  })

  it('keeps a caller-provided spawn function in the chain instead of replacing it', async () => {
    const calls = []
    const directory = await mkdtemp(join(tmpdir(), 'hidock-worker-telemetry-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const host = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }) })
    cleanups.push(() => host.stop())
    const spawnFn = (...args) => { calls.push(args[0]); return spawn(...args) }
    const jobs = new WorkerJobs({ directory, state: new HostState({ initial: READY }), options: () => ({ spawnFn }),
      execute: async (_path, options) => {
        const { finish } = realChild(WAITING_CHILD, options.spawnFn)
        await finish()
        return { model: options.model, modelVersion: 'fixture', segments: [], speakers: [] }
      } })
    jobs.telemetry = host
    await jobs.initialize()
    cleanups.push(() => jobs.close())
    const audio = Buffer.from('another synthetic input')
    const job = await jobs.create({ idempotencyKey: 'worker-telemetry-chain', audioHash: hash(audio), bytes: audio.length,
      model: 'pyannote/speaker-diarization-3.1', extension: '.wav', stage: 'diarization' }, 'owner')
    await jobs.upload(job.id, 'owner', Readable.from([audio]))
    await expect.poll(() => jobs.get(job.id, 'owner').status).toBe('completed')
    expect(calls).toEqual([process.execPath])
    expect(host.snapshot().workerProcesses.recentlyExited).toHaveLength(1)
  })

  it('does not add a spawn function when there is no telemetry, so the earlier behaviour is unchanged', async () => {
    let received
    const directory = await mkdtemp(join(tmpdir(), 'hidock-worker-telemetry-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const jobs = new WorkerJobs({ directory, state: new HostState({ initial: READY }), options: () => ({}),
      execute: async (_path, options) => { received = options; return { model: options.model, modelVersion: 'fixture', segments: [], speakers: [] } } })
    await jobs.initialize()
    cleanups.push(() => jobs.close())
    const audio = Buffer.from('a third synthetic input')
    const job = await jobs.create({ idempotencyKey: 'worker-telemetry-none', audioHash: hash(audio), bytes: audio.length,
      model: 'pyannote/speaker-diarization-3.1', extension: '.wav', stage: 'diarization' }, 'owner')
    await jobs.upload(job.id, 'owner', Readable.from([audio]))
    await expect.poll(() => jobs.get(job.id, 'owner').status).toBe('completed')
    expect(received).not.toHaveProperty('spawnFn')
  })

  it('serves workerProcesses over authenticated HTTP loopback next to every earlier field', async () => {
    const host = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }), processSampler: null })
    cleanups.push(() => host.stop())
    const server = createHostServer({ state: new HostState({ initial: READY }), telemetry: host,
      pairing: { accepts: () => true }, capabilities: () => ({ capabilities: [] }) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise(resolve => server.close(resolve)))
    const id = host.start('transcription', 'fixture-model', 'recording-1', 'durable-1')
    const { finish } = realChild(WAITING_CHILD, host.spawnFor(id, 'worker'))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/telemetry`)
    const body = await response.json()
    expect(response.status).toBe(200)
    for (const field of ['cpuPercent', 'memoryTotalMiB', 'serviceRssMiB', 'activeJobs', 'recentJobs', 'tokens', 'hostState']) {
      expect(body, field).toHaveProperty(field)
    }
    expect(body.workerProcesses.running).toBe(1)
    expect(body.workerProcesses.owned[0]).toMatchObject({ stage: 'transcription', model: 'fixture-model', hostJobId: 'durable-1', workingSetMiB: null })
    expect(body.workerProcesses.coverage).toMatchObject({ memory: 'no-adapter', cpu: 'unavailable', gpu: 'unavailable', descendants: 'not-enumerated' })
    expect(body.serviceRssMiB).toEqual(expect.any(Number))
    await finish()
    host.finish(id, 'completed')
  })
})
