/**
 * The native process-family sampler, against the real helper and real processes.
 *
 * The helper (native/process-sampler.c, built to build/process-sampler.exe) is started for real, and
 * the processes it measures are real, bounded Node children that this file starts: one holds a known
 * amount of memory, one burns CPU for a fixed time, one starts a descendant, one exits. Nothing here
 * runs a model, starts PowerShell or WMI, or ends a process this file did not start. Every child
 * carries its own self-expiry timer so a failed test cannot leave one behind.
 *
 * Tests that need the helper are skipped, and named as skipped, when it is not built. Build it with
 * `node -e "import('./scripts/build-installer.mjs').then(m => m.buildSampler())"` from apps/model-host
 * (zig on PATH, as for the tray icon). A few cases use hand-written helper lines to
 * reach states that cannot be produced on demand (a different Windows build, a reused parent id); those
 * say so in their names and are never the only evidence for a behaviour.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { HostTelemetry } from '../src/telemetry.mjs'
import { WindowsProcessSampler, defaultSamplerPath, parseSample, summarizeFamily } from '../src/windows-process-sampler.mjs'

// HIDOCK_SAMPLER_UNDER_TEST points the same tests at a deliberately broken build of the helper, to show they fail
// when the native behaviour they guard is removed.
const HELPER = process.env.HIDOCK_SAMPLER_UNDER_TEST || join(import.meta.dirname, '..', 'build', 'process-sampler.exe')
const built = process.platform === 'win32' && existsSync(HELPER)
const real = built ? describe : describe.skip
const MIB = 1024 ** 2

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A bounded child. `body` runs after the child reports ready; it always expires by itself. */
function child(source, { stdio = ['pipe', 'pipe', 'ignore'] } = {}) {
  const proc = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(3),25000);${source}`],
    { stdio, windowsHide: true })
  proc.on('error', () => {})
  const closed = new Promise(resolve => proc.once('close', resolve))
  let output = ''
  proc.stdout?.on('data', chunk => { output += chunk })
  const lines = async (pattern, ms = 8000) => {
    const until = Date.now() + ms
    while (Date.now() < until) { const match = pattern.exec(output); if (match) return match; await sleep(25) }
    throw new Error(`child did not print ${pattern}; got ${JSON.stringify(output.slice(0, 120))}`)
  }
  const stop = async () => { if (proc.exitCode === null && !proc.signalCode) { try { proc.stdin.write('x\n') } catch { /* closed */ } await Promise.race([closed, sleep(3000)]); if (proc.exitCode === null) proc.kill() } }
  cleanups.push(stop)
  return { proc, lines, stop, closed }
}

const HOLD_MEMORY = (mib) => `const keep=Buffer.alloc(${mib}*1024*1024,1);let s=0;for(let i=0;i<keep.length;i+=4096)s+=keep[i];console.log('HELD '+keep.length+' '+s)`
const BURN_CPU = (ms) => `const t=Date.now();let x=0;while(Date.now()-t<${ms}){x+=Math.sqrt(x+1)}console.log('BURNED')`
const WITH_GRANDCHILD = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e',"process.stdin.resume();setTimeout(()=>process.exit(0),20000)"],{stdio:['pipe','ignore','ignore'],windowsHide:true});process.stdin.on('end',()=>{});console.log('GRAND '+g.pid);process.on('exit',()=>{try{g.stdin.end()}catch{}})`

/** Start a sampler rooted at this test process and make sure it is stopped afterwards. */
function sampler(options = {}) {
  const value = new WindowsProcessSampler({ path: HELPER, timeoutMs: 8000, ...options })
  cleanups.push(() => value.stop())
  return value
}

real('the native helper measures real processes', () => {
  it('lists the root and a descendant it did not start itself, with the creation time Windows reports', async () => {
    const holder = child(`${WITH_GRANDCHILD};setInterval(()=>{},1000)`)
    const [, grandPid] = await holder.lines(/GRAND (\d+)/)
    const watcher = sampler()
    expect(await watcher.sample()).toBe(true)
    const report = watcher.report()
    expect(report.status).toBe('ok')
    const pids = report.processes.map(item => item.pid)
    expect(pids).toContain(process.pid)
    expect(pids).toContain(holder.proc.pid)
    expect(pids).toContain(Number(grandPid))
    const byPid = new Map(report.processes.map(item => [item.pid, item]))
    expect(byPid.get(process.pid).link).toBe('root')
    expect(byPid.get(holder.proc.pid)).toMatchObject({ link: 'descendant', ppid: process.pid })
    expect(byPid.get(Number(grandPid))).toMatchObject({ link: 'descendant', ppid: holder.proc.pid })
    // The creation time is the operating system's. A child cannot have been created before its parent, and not before this test began.
    for (const item of report.processes) expect(item.creationFiletime).toMatch(/^\d{17,19}$/)
    expect(Number(byPid.get(holder.proc.pid).creationFiletime)).toBeGreaterThanOrEqual(Number(byPid.get(process.pid).creationFiletime))
    expect(Number(byPid.get(Number(grandPid)).creationFiletime)).toBeGreaterThanOrEqual(Number(byPid.get(holder.proc.pid).creationFiletime))
    expect(Math.abs(byPid.get(holder.proc.pid).createdAtMs - Date.now())).toBeLessThan(60_000)
    expect(report.descendants.counted).toBeGreaterThanOrEqual(2)
    expect(report.root).toMatchObject({ pid: process.pid, alive: true })
  })

  it('does not list a process this service did not start', async () => {
    const unrelated = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(0),20000)"], { stdio: 'ignore', windowsHide: true, detached: true })
    // Started from this very process, so it IS a child. A sibling is what matters: the helper's own parent is the root.
    cleanups.push(async () => { try { unrelated.kill() } catch { /* gone */ } })
    const watcher = sampler({ rootPid: unrelated.pid })
    await watcher.sample()
    const pids = watcher.report().processes.map(item => item.pid)
    expect(pids).toContain(unrelated.pid)
    expect(pids).not.toContain(process.pid)
    expect(pids.length).toBe(1)
  })

  it('reports the memory of a child that holds a known amount, and the figure moves with the allocation', async () => {
    const small = child("setInterval(()=>{},1000);console.log('IDLE')")
    await small.lines(/IDLE/)
    const watcher = sampler()
    await watcher.sample()
    const before = watcher.report().processes.find(item => item.pid === small.proc.pid)

    const big = child(`${HOLD_MEMORY(200)};setInterval(()=>{},1000)`)
    await big.lines(/HELD (\d+)/)
    await watcher.sample()
    const report = watcher.report()
    const after = report.processes.find(item => item.pid === big.proc.pid)
    expect(report.memory.basis).toBe('private-working-set')
    // A 200 MiB buffer that was written to is resident and private to the process that holds it.
    expect(after.privateWorkingSetMiB).toBeGreaterThan(150)
    expect(after.privateWorkingSetMiB).toBeLessThan(450)
    expect(after.privateWorkingSetMiB).toBeGreaterThan(before.privateWorkingSetMiB + 120)
    // Private commit is its own quantity: at least what is resident, and never reported as physical memory.
    expect(after.privateCommitMiB).toBeGreaterThanOrEqual(after.privateWorkingSetMiB - 1)
    expect(report.memory.totalMiB).toBeGreaterThan(after.privateWorkingSetMiB)
    expect(report.memory.privateCommitTotalMiB).toBeGreaterThanOrEqual(report.memory.totalMiB - 1)
    expect(report.memory.sharedPages).toBe('excluded-from-private-working-set')
  })

  it('reports a working set that is not smaller than the private working set', async () => {
    const big = child(`${HOLD_MEMORY(64)};setInterval(()=>{},1000)`)
    await big.lines(/HELD/)
    const watcher = sampler()
    await watcher.sample()
    for (const item of watcher.report().processes) {
      expect(item.workingSetMiB).toBeGreaterThanOrEqual(item.privateWorkingSetMiB)
    }
  })

  it('reports no CPU on the first sample, then a real share once a child has burned time between two samples', async () => {
    const burner = child(`process.stdin.removeAllListeners();setTimeout(()=>{${BURN_CPU(1500)}},300);setInterval(()=>{},1000)`)
    const watcher = sampler()
    await watcher.sample()
    const first = watcher.report()
    expect(first.cpu.percent).toBeNull()
    expect(first.cpu.status).toBe('first-sample')
    await burner.lines(/BURNED/, 10_000)
    await watcher.sample()
    const second = watcher.report()
    const logical = cpus().length
    expect(second.cpu.logicalProcessors).toBe(logical)
    expect(second.cpu.denominator).toBe('all-logical-processors')
    // The child ran one thread flat out for about 1.5 s of an interval of a few seconds, so the machine-wide share is
    // 100/logical at most; it must be a real positive number below that, never 0 and never above the whole machine.
    expect(second.cpu.percent).toBeGreaterThan(0)
    expect(second.cpu.percent).toBeLessThanOrEqual(100 / logical * 1.15 + 0.5)
    expect(second.cpu.comparableProcesses).toBeGreaterThanOrEqual(2)
  })

  it('reports a genuine zero for processes that were comparable and idle, not an unknown', async () => {
    const idle = child("setInterval(()=>{},1000);console.log('IDLE')")
    await idle.lines(/IDLE/)
    const rootOnly = sampler({ rootPid: idle.proc.pid })
    await rootOnly.sample()
    await sleep(900)
    await rootOnly.sample()
    const { cpu } = rootOnly.report()
    expect(cpu.status).toBe('ok')
    expect(cpu.percent).not.toBeNull()
    expect(cpu.percent).toBeGreaterThanOrEqual(0)
    expect(cpu.percent).toBeLessThan(2)
  })

  it('removes a child that exits, reports its exit once with the real exit code, and keeps counting the rest', async () => {
    const stays = child("setInterval(()=>{},1000);console.log('IDLE')")
    const leaves = child("setInterval(()=>{},1000);console.log('IDLE')")
    await Promise.all([stays.lines(/IDLE/), leaves.lines(/IDLE/)])
    const watcher = sampler()
    await watcher.sample()
    expect(watcher.report().processes.map(item => item.pid)).toContain(leaves.proc.pid)
    await leaves.stop()
    await watcher.sample()
    const withExit = watcher.report()
    const gone = withExit.processes.find(item => item.pid === leaves.proc.pid)
    expect(gone).toMatchObject({ exited: true, exitCode: 0, workingSetMiB: null, privateWorkingSetMiB: null })
    expect(withExit.descendants.exitedReported).toBeGreaterThanOrEqual(1)
    expect(withExit.processes.map(item => item.pid)).toContain(stays.proc.pid)
    await watcher.sample()
    const later = watcher.report()
    expect(later.processes.map(item => item.pid)).not.toContain(leaves.proc.pid)
    expect(later.processes.map(item => item.pid)).toContain(stays.proc.pid)
  })

  it('counts the CPU a child used right up to its exit, from the final time Windows kept for it', async () => {
    const burner = child(`process.stdin.removeAllListeners();${BURN_CPU(800)};process.exit(5)`)
    const watcher = sampler()
    await watcher.sample()
    await burner.lines(/BURNED/, 8000)
    await burner.closed
    await watcher.sample()
    const report = watcher.report()
    expect(report.processes.find(item => item.pid === burner.proc.pid)).toMatchObject({ exited: true, exitCode: 5 })
    expect(report.cpu.percent).toBeGreaterThan(0)
    expect(report.cpu.exitedBetweenSamples ?? 0).toBe(0)
  })

  it('reports an ordinary Node grandchild as exited when its parent exits (observed here; the helper only reports what Windows shows)', async () => {
    const parent = child(`${WITH_GRANDCHILD};setInterval(()=>{},1000)`)
    const [, grandPid] = await parent.lines(/GRAND (\d+)/)
    const watcher = sampler()
    await watcher.sample()
    await parent.stop()
    await watcher.sample()
    const report = watcher.report()
    expect(report.processes.find(item => item.pid === parent.proc.pid)).toMatchObject({ exited: true })
    expect(report.processes.find(item => item.pid === Number(grandPid))).toMatchObject({ exited: true })
    expect(report.descendants.orphans).toBe(0)
  })

  it('keeps a descendant that detached from its worker and calls it an orphan once the worker has exited', async () => {
    // detached: true makes the grandchild leave the parent's job, as a Python worker's own subprocess does. It expires by itself.
    const DETACHED = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),7000)"],{stdio:'ignore',detached:true,windowsHide:true});console.log('GRAND '+g.pid)`
    const parent = child(`${DETACHED};setInterval(()=>{},1000)`)
    const [, grandPid] = await parent.lines(/GRAND (\d+)/)
    const watcher = sampler()
    await watcher.sample()
    expect(watcher.report().processes.find(item => item.pid === Number(grandPid)).link).toBe('descendant')
    await parent.stop()
    await watcher.sample()
    const report = watcher.report()
    const grand = report.processes.find(item => item.pid === Number(grandPid))
    // The parent is gone from the list; Windows still names it as the grandchild's parent. The grandchild is
    // still owned (its handle was opened while the lineage was intact) but is no longer connected to the root.
    expect(grand).toBeDefined()
    expect(grand.link).toBe('orphan')
    expect(report.descendants.orphans).toBeGreaterThanOrEqual(1)
  })
})

real('the sampler as a persistent helper', () => {
  it('answers many samples from one helper process, without starting a process per sample', async () => {
    const watcher = sampler()
    for (let index = 0; index < 8; index++) expect(await watcher.sample()).toBe(true)
    expect(watcher.starts).toBe(1)
    expect(watcher.report().status).toBe('ok')
  })

  it('does not overlap samples: a second request while one is pending shares its answer', async () => {
    const watcher = sampler()
    const first = watcher.sample()
    const second = watcher.sample()
    expect(second).toBe(first)
    expect(await first).toBe(true)
  })

  it('stops the helper when asked, and does not leave a process running', async () => {
    const watcher = sampler()
    await watcher.sample()
    const helperPid = watcher.child.pid
    watcher.stop()
    await expect.poll(() => { try { process.kill(helperPid, 0); return 'alive' } catch { return 'gone' } }, { timeout: 6000 }).toBe('gone')
  })

  it('ends the helper by itself when its input closes', async () => {
    const helper = spawn(HELPER, ['--root-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    cleanups.push(async () => { if (helper.exitCode === null) helper.kill() })
    const closed = new Promise(resolve => helper.once('exit', code => resolve(code)))
    helper.stdin.end()
    expect(await Promise.race([closed, sleep(5000).then(() => 'still running')])).toBe(0)
  })

  it('refuses a missing or invalid root without crashing, and says why', () => {
    const none = spawnSync(HELPER, [], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    expect(none.status).toBe(2)
    expect(JSON.parse(none.stdout.trim())).toMatchObject({ v: 1, error: expect.stringContaining('usage') })
    const bad = spawnSync(HELPER, ['--root-pid', '4294967000'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    expect(bad.status).toBe(3)
    expect(JSON.parse(bad.stdout.trim())).toMatchObject({ v: 1, error: 'root-unavailable' })
  })

  it('answers an unknown command with an error line and keeps working', async () => {
    const helper = spawn(HELPER, ['--root-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    cleanups.push(async () => { if (helper.exitCode === null) helper.kill() })
    let out = ''
    helper.stdout.on('data', chunk => { out += chunk })
    helper.stdin.write('Z\nS\n')
    await expect.poll(() => out.split('\n').filter(Boolean).length, { timeout: 5000 }).toBe(2)
    const [first, second] = out.split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(first).toMatchObject({ error: 'unknown-command' })
    expect(second).toMatchObject({ v: 1, members: expect.any(Array) })
    helper.stdin.end()
  })

  it('reports an unavailable helper that dies, then recovers with a fresh baseline when sampled again', async () => {
    const watcher = sampler()
    await watcher.sample()
    const dead = watcher.child.pid
    // Ending the helper is ending a process this test started, through its own input; no other process is touched.
    watcher.child.stdin.end()
    await expect.poll(() => { try { process.kill(dead, 0); return 'alive' } catch { return 'gone' } }, { timeout: 6000 }).toBe('gone')
    await sleep(100)
    expect(watcher.report().status).toBe('unavailable')
    expect(watcher.report().cpu).toBeNull()
    expect(await watcher.sample()).toBe(true)
    expect(watcher.starts).toBe(2)
    const recovered = watcher.report()
    expect(recovered.status).toBe('ok')
    expect(recovered.cpu.status).toBe('first-sample')
    expect(recovered.cpu.percent).toBeNull()
  })

  it('reports the age of the measurement, and drops the figures once it is stale', async () => {
    let now = 5_000_000
    const watcher = sampler({ now: () => now })
    await watcher.sample()
    now += 2500
    expect(watcher.report(15_000)).toMatchObject({ status: 'ok', ageMs: 2500 })
    now += 13_000
    const stale = watcher.report(15_000)
    expect(stale.status).toBe('stale')
    expect(stale.ageMs).toBe(15_500)
    expect(stale.cpu.percent).toBeNull()
    expect(stale.memory.totalMiB).toBeNull()
    expect(stale.processes[0].pid).toBe(process.pid)
    expect(stale.processes[0].privateWorkingSetMiB).toBeNull()
  })
})

real('HostTelemetry carries the native family next to the earlier fields', () => {
  function host(options = {}) {
    const value = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }), processSampler: new WindowsProcessSampler({ path: HELPER }), ...options })
    cleanups.push(() => value.stop())
    return value
  }

  it('adds processFamily without changing the service-only field, and says what serviceRssMiB is', async () => {
    const telemetry = host()
    await expect.poll(() => telemetry.snapshot().processFamily.status, { timeout: 8000 }).toBe('ok')
    const snapshot = telemetry.snapshot()
    expect(snapshot.serviceRssMiB).toEqual(expect.any(Number))
    expect(snapshot.serviceRssScope).toBe('service-process-only')
    expect(snapshot.processFamily.source).toBe('native-process-family-sampler')
    expect(snapshot.processFamily.gpu.status).toBe('unavailable')
    // The family holds the service and everything under it, so it can never be smaller than the service alone in the same basis.
    const root = snapshot.processFamily.processes.find(item => item.pid === process.pid)
    expect(root.link).toBe('root')
    expect(snapshot.processFamily.memory.workingSetTotalMiB).toBeGreaterThanOrEqual(root.workingSetMiB)
    for (const field of ['cpuPercent', 'memoryTotalMiB', 'activeJobs', 'recentJobs', 'workerProcesses']) expect(snapshot).toHaveProperty(field)
  })

  it('measures a registered worker from native output and binds it to the creation time Windows reports', async () => {
    const telemetry = host()
    const id = telemetry.start('transcription', 'fixture-model', 'recording-1', 'durable-1')
    const worker = child(`${HOLD_MEMORY(120)};setInterval(()=>{},1000)`)
    telemetry.trackWorker(id, worker.proc, 'job-worker')
    await worker.lines(/HELD/)
    // The constructor already asked for a sample before the child had allocated; wait for one taken after it did.
    const askedAfterAllocation = Date.now()
    telemetry.sample()
    await expect.poll(() => {
      const { owned } = telemetry.snapshot().workerProcesses
      return owned[0]?.workingSetMiB > 100 && Date.parse(telemetry.snapshot().workerProcesses.memory.measuredAt) >= askedAfterAllocation
    }, { timeout: 8000 }).toBe(true)
    const { owned, memory } = telemetry.snapshot().workerProcesses
    expect(owned).toHaveLength(1)
    expect(owned[0].pid).toBe(worker.proc.pid)
    expect(owned[0].workingSetMiB).toBeGreaterThan(100)
    expect(owned[0].osIdentity.creationFiletime).toMatch(/^\d{17,19}$/)
    expect(memory.basis).toBe('working-set')
    expect(memory.totalMiB).toBeGreaterThan(100)
    const family = telemetry.snapshot().processFamily
    expect(family.processes.map(item => item.pid)).toContain(worker.proc.pid)
  })

  it('removes an exited worker from both the registry and the family', async () => {
    const telemetry = host()
    const worker = child("setInterval(()=>{},1000);console.log('IDLE')")
    await worker.lines(/IDLE/)
    telemetry.trackWorker(null, worker.proc, 'job-worker')
    telemetry.sample()
    await expect.poll(() => telemetry.snapshot().processFamily.processes.some(item => item.pid === worker.proc.pid), { timeout: 8000 }).toBe(true)
    await worker.stop()
    expect(telemetry.snapshot().workerProcesses.owned).toEqual([])
    telemetry.sample()
    await expect.poll(() => telemetry.snapshot().processFamily.processes.find(item => item.pid === worker.proc.pid)?.exited ?? true, { timeout: 8000 }).toBe(true)
    telemetry.sample()
    await expect.poll(() => telemetry.snapshot().processFamily.processes.some(item => item.pid === worker.proc.pid), { timeout: 8000 }).toBe(false)
  })

  it('never reports NaN, Infinity or undefined anywhere in the combined snapshot', async () => {
    const telemetry = host()
    const worker = child(`${HOLD_MEMORY(32)};setInterval(()=>{},1000)`)
    await worker.lines(/HELD/)
    telemetry.trackWorker(null, worker.proc)
    telemetry.sample(); await sleep(600); telemetry.sample(); await sleep(600)
    const problems = []
    const scan = (value, path = '$') => {
      if (value === undefined) problems.push(`${path} undefined`)
      else if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`${path} ${value}`)
      else if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`))
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) scan(item, `${path}.${key}`)
    }
    scan(telemetry.snapshot().processFamily)
    scan(telemetry.snapshot().workerProcesses)
    expect(problems).toEqual([])
  })

  it('is switched off with HIDOCK_PROCESS_SAMPLER=off, reporting unavailable and never starting the helper', () => {
    const previous = process.env.HIDOCK_PROCESS_SAMPLER
    process.env.HIDOCK_PROCESS_SAMPLER = 'off'
    try {
      const telemetry = new HostTelemetry({ readCpu: () => ({ idle: 1, total: 2 }) })
      cleanups.push(() => telemetry.stop())
      expect(telemetry.snapshot().processFamily).toMatchObject({ status: 'unavailable', reason: 'disabled', cpu: null, memory: null })
      expect(telemetry.family).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.HIDOCK_PROCESS_SAMPLER
      else process.env.HIDOCK_PROCESS_SAMPLER = previous
    }
  })
})

describe('summarizing raw samples (hand-written lines; the real helper is exercised above)', () => {
  const NOW = 134_000_000_000_000_000n
  const member = (pid, over = {}) => ({
    pid, ppid: 1, name: 'node.exe', link: 'descendant', creationFiletime: String(NOW + BigInt(pid)), createdAtMs: 1000,
    cpuTicks: 0n, exited: false, exitCode: null, workingSetBytes: 100 * MIB, privateWorkingSetBytes: 40 * MIB,
    privateCommitBytes: 60 * MIB, memoryError: null, ...over
  })
  const sample = (members, over = {}) => ({ seq: 1, monotonicUs: 0, sampledAtMs: 0, logicalProcessors: 8, processorGroups: 1, memoryApi: 'ex2',
    counters: { unverifiedCandidates: 0, rejectedByCreationTime: 0, truncated: false }, root: { pid: 1, alive: true }, members, ...over })
  const TICKS_PER_SECOND = 10_000_000n

  it('divides CPU time by all logical processors and by the elapsed time', () => {
    const before = sample([member(10, { cpuTicks: 0n })], { monotonicUs: 1_000_000 })
    const after = sample([member(10, { cpuTicks: 4n * TICKS_PER_SECOND })], { monotonicUs: 3_000_000 })
    // 4 s of CPU in 2 s of wall time is two full cores; on 8 logical processors that is 25 %.
    expect(summarizeFamily(after, before).cpu).toMatchObject({ percent: 25, status: 'ok', logicalProcessors: 8, denominator: 'all-logical-processors' })
  })

  it('keeps a real zero when comparable processes used no CPU', () => {
    const before = sample([member(10, { cpuTicks: 500n })], { monotonicUs: 0 })
    const after = sample([member(10, { cpuTicks: 500n })], { monotonicUs: 2_000_000 })
    expect(summarizeFamily(after, before).cpu).toMatchObject({ percent: 0, status: 'ok' })
  })

  it('treats the first sample, a missing interval and no comparable process as unknown, never zero', () => {
    const only = sample([member(10)], { monotonicUs: 1 })
    expect(summarizeFamily(only, null).cpu).toMatchObject({ percent: null, status: 'first-sample' })
    expect(summarizeFamily(only, sample([member(10)], { monotonicUs: 1 })).cpu).toMatchObject({ percent: null, status: 'no-elapsed-time' })
    const replaced = sample([member(11)], { monotonicUs: 2_000_000 })
    expect(summarizeFamily(replaced, sample([member(10)], { monotonicUs: 0 })).cpu).toMatchObject({ percent: null, status: 'no-comparable-process' })
  })

  it('does not credit a reused pid with the previous process\'s CPU time: a different creation time is a different process', () => {
    const before = sample([member(10, { cpuTicks: 900n * TICKS_PER_SECOND })], { monotonicUs: 0 })
    const reused = member(10, { cpuTicks: 3n * TICKS_PER_SECOND, creationFiletime: String(NOW + 999_999n) })
    const after = sample([reused], { monotonicUs: 2_000_000 })
    const summary = summarizeFamily(after, before)
    expect(summary.cpu.percent).toBeNull()
    expect(summary.cpu.status).toBe('no-comparable-process')
    expect(summary.cpu.withoutBaseline).toBe(1)
  })

  it('marks CPU partial when some processes have no baseline or vanished without a report, and still counts the rest', () => {
    const before = sample([member(10, { cpuTicks: 0n }), member(11, { cpuTicks: 0n })], { monotonicUs: 0 })
    const after = sample([member(10, { cpuTicks: TICKS_PER_SECOND }), member(12, { cpuTicks: 5n * TICKS_PER_SECOND })], { monotonicUs: 2_000_000 })
    const { cpu } = summarizeFamily(after, before)
    expect(cpu.status).toBe('partial')
    expect(cpu.comparableProcesses).toBe(1)
    expect(cpu.withoutBaseline).toBe(1)
    expect(cpu.vanishedBetweenSamples).toBe(1)
    // 1 s of CPU in 2 s on 8 logical processors.
    expect(cpu.percent).toBeCloseTo(6.25, 6)
  })

  it('never lets a counter that went backwards produce a negative or inflated figure', () => {
    const before = sample([member(10, { cpuTicks: 9n * TICKS_PER_SECOND })], { monotonicUs: 0 })
    const after = sample([member(10, { cpuTicks: 1n * TICKS_PER_SECOND })], { monotonicUs: 2_000_000 })
    expect(summarizeFamily(after, before).cpu.percent).toBe(0)
  })

  it('caps the share at the whole machine', () => {
    const before = sample([member(10, { cpuTicks: 0n })], { monotonicUs: 0 })
    const after = sample([member(10, { cpuTicks: 100n * TICKS_PER_SECOND })], { monotonicUs: 1_000_000 })
    expect(summarizeFamily(after, before).cpu.percent).toBe(100)
  })

  it('uses private working set when the OS provides it, and labels the working-set sum with its shared-page limit when it does not', () => {
    const live = sample([member(10), member(11)])
    expect(summarizeFamily(live, null).memory).toMatchObject({ basis: 'private-working-set', status: 'ok', totalMiB: 80, workingSetTotalMiB: 200,
      privateCommitTotalMiB: 120, sharedPages: 'excluded-from-private-working-set' })
    const basic = sample([member(10, { privateWorkingSetBytes: null, privateCommitBytes: null }), member(11, { privateWorkingSetBytes: null, privateCommitBytes: null })], { memoryApi: 'base' })
    const memory = summarizeFamily(basic, null).memory
    expect(memory).toMatchObject({ basis: 'working-set', status: 'ok', totalMiB: 200, privateCommitTotalMiB: null,
      sharedPages: 'counted-once-per-process-in-working-set' })
    expect(memory.note).toMatch(/shared/i)
  })

  it('gives no total when any live process was not measured, and never fills the gap with zero', () => {
    const partial = sample([member(10), member(11, { workingSetBytes: null, privateWorkingSetBytes: null, privateCommitBytes: null, memoryError: 5 })])
    const summary = summarizeFamily(partial, null)
    expect(summary.memory).toMatchObject({ status: 'partial', totalMiB: null, workingSetTotalMiB: null, measuredProcesses: 1, liveProcesses: 2 })
    expect(summary.processes[1]).toMatchObject({ workingSetMiB: null, privateWorkingSetMiB: null, privateCommitMiB: null, memoryError: 5 })
    const none = sample([member(10, { workingSetBytes: null, privateWorkingSetBytes: null, privateCommitBytes: null })])
    expect(summarizeFamily(none, null).memory).toMatchObject({ status: 'unavailable', totalMiB: null })
  })

  it('ignores an exited process when totalling memory but still lists it once', () => {
    const exited = sample([member(10), member(11, { exited: true, exitCode: 4, workingSetBytes: null, privateWorkingSetBytes: null, privateCommitBytes: null })])
    const summary = summarizeFamily(exited, null)
    expect(summary.memory).toMatchObject({ status: 'ok', totalMiB: 40, liveProcesses: 1 })
    expect(summary.descendants.exitedReported).toBe(1)
  })

  it('reports orphans and creation-time rejections in the descendant coverage', () => {
    const summary = summarizeFamily(sample([member(10, { link: 'orphan' }), member(11)], {
      counters: { unverifiedCandidates: 2, rejectedByCreationTime: 1, truncated: true } }), null)
    expect(summary.descendants).toMatchObject({ counted: 1, orphans: 1, rejectedByCreationTime: 1, unverifiedCandidates: 2, truncated: true })
  })
})

describe('reading helper lines safely (hand-written lines)', () => {
  const line = (extra = {}) => JSON.stringify({ v: 1, seq: 1, monotonicUs: 5, sampledAtMs: 6, logicalProcessors: 4, processorGroups: 1, memoryApi: 'ex2',
    counters: {}, root: { pid: 9, alive: true, createdAtMs: 1, creationFiletime: '134000000000000000' },
    members: [{ pid: 9, ppid: 1, name: 'node.exe', link: 'root', creationFiletime: '134000000000000000', createdAtMs: 1,
      cpuKernel100ns: 10, cpuUser100ns: 20, exited: false, exitCode: null, workingSetBytes: 1048576, peakWorkingSetBytes: 1, privateWorkingSetBytes: 524288,
      privateCommitBytes: 786432, memoryError: null }], ...extra })

  it('accepts a well formed line and keeps CPU as exact integers', () => {
    const parsed = parseSample(line())
    expect(parsed.members[0]).toMatchObject({ pid: 9, link: 'root', cpuTicks: 30n, workingSetBytes: 1048576, privateWorkingSetBytes: 524288 })
    expect(parsed.memoryApi).toBe('ex2')
  })

  it.each([['not json', 'nope'], ['wrong version', JSON.stringify({ v: 2, members: [] })], ['no members', JSON.stringify({ v: 1 })],
    ['an error line', JSON.stringify({ v: 1, error: 'snapshot-failed', code: 5 })], ['empty', '']])('rejects %s', (_name, text) => {
    expect(parseSample(text)).toBeNull()
  })

  it('drops a member with no usable identity instead of guessing one', () => {
    const parsed = parseSample(line({ members: [{ pid: 0, creationFiletime: '1' }, { pid: 5 }, { pid: 6, creationFiletime: 'abc' }, { pid: 7, creationFiletime: '134000000000000001' }] }))
    expect(parsed.members.map(item => item.pid)).toEqual([7])
  })

  it('turns negative, non-numeric and missing counters into null, never into zero', () => {
    const parsed = parseSample(line({ members: [{ pid: 9, creationFiletime: '134000000000000000', workingSetBytes: -1, privateWorkingSetBytes: 'x',
      privateCommitBytes: null, cpuKernel100ns: null, cpuUser100ns: 5 }] }))
    expect(parsed.members[0]).toMatchObject({ workingSetBytes: null, privateWorkingSetBytes: null, privateCommitBytes: null, cpuTicks: null })
  })
})

describe('without the helper', () => {
  it('reports unavailable with the reason and never invents a figure', () => {
    const watcher = new WindowsProcessSampler({ path: null })
    expect(watcher.available).toBe(false)
    expect(watcher.report()).toMatchObject({ status: 'unavailable', reason: process.platform === 'win32' ? 'helper-not-found' : 'not-windows',
      cpu: null, memory: null, processes: [], gpu: { status: 'unavailable' } })
  })

  it('resolves false instead of throwing when sampling is impossible', async () => {
    await expect(new WindowsProcessSampler({ path: null }).sample()).resolves.toBe(false)
  })

  it('finds the built helper in the build folder when it exists', () => {
    expect(defaultSamplerPath() === null || existsSync(defaultSamplerPath())).toBe(true)
  })

  it('reports a failure to start the helper, without throwing', async () => {
    const watcher = new WindowsProcessSampler({ path: join(import.meta.dirname, 'no-such-sampler.exe'), timeoutMs: 2000 })
    cleanups.push(() => watcher.stop())
    await expect(watcher.sample()).resolves.toBe(false)
    expect(watcher.report().status).toBe('unavailable')
    expect(watcher.report().reason).toMatch(/helper-/)
  })
})
