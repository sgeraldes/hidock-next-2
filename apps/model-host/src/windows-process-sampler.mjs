/**
 * The model host's own process family, measured by one persistent native helper.
 *
 * native/process-sampler.c is started once and kept running. Each telemetry tick sends it one
 * line and gets one JSON line back: CPU time and memory of this service and of every process it
 * started, directly or not. Nothing here starts PowerShell or WMI, and nothing starts a process
 * per sample.
 *
 * This module turns those raw counters into figures with their basis stated:
 *
 *  - CPU is the change in kernel+user time between two samples of the same process
 *    (identified by pid AND the creation time Windows reports), divided by elapsed wall time and
 *    by ALL logical processors of the machine. The first sample of anything is unknown.
 *    A process that was not in both samples contributes nothing and the result says it is partial.
 *  - Memory is the private working set when Windows supports it, which does not count pages
 *    shared with other processes twice. When it does not, the figure is the working set and is
 *    labelled as one, with the shared-page limit. Private COMMIT is reported under its own name
 *    and is never presented as physical RAM.
 *  - Nothing is invented. A missing counter is null, a status says why, and a total exists
 *    only when every process that is counted was measured.
 *
 * GPU per process is not provided: no reliable per-process source is implemented here, and the
 * whole-device figures in HostTelemetry are not a substitute.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const FILETIME_TICKS_PER_MS = 10_000
const MIB = 1024 ** 2

/** Where the helper is looked for: next to the program in an installation, or in the build folder. */
export function defaultSamplerPath() {
  const candidates = [join(here, '..', 'process-sampler.exe'), join(here, '..', 'build', 'process-sampler.exe')]
  return candidates.find(path => existsSync(path)) ?? null
}

const asNumber = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
const asTicks = value => {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value)
  return null
}

/** Normalise one helper line. Returns null for a line that is not a sample. */
export function parseSample(line) {
  let raw
  try { raw = JSON.parse(line) } catch { return null }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.members)) return null
  const members = []
  for (const item of raw.members) {
    const created = asTicks(item?.creationFiletime)
    if (!Number.isSafeInteger(item?.pid) || item.pid <= 0 || created === null) continue
    const kernel = asTicks(item.cpuKernel100ns === null ? null : String(item.cpuKernel100ns))
    const user = asTicks(item.cpuUser100ns === null ? null : String(item.cpuUser100ns))
    members.push({
      pid: item.pid, ppid: Number.isSafeInteger(item.ppid) ? item.ppid : null, name: typeof item.name === 'string' ? item.name.slice(0, 64) : null,
      link: ['root', 'descendant', 'orphan'].includes(item.link) ? item.link : 'descendant',
      creationFiletime: created.toString(), createdAtMs: asNumber(item.createdAtMs),
      cpuTicks: kernel !== null && user !== null ? kernel + user : null,
      exited: item.exited === true, exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null,
      workingSetBytes: asNumber(item.workingSetBytes), privateWorkingSetBytes: asNumber(item.privateWorkingSetBytes),
      privateCommitBytes: asNumber(item.privateCommitBytes), memoryError: Number.isSafeInteger(item.memoryError) ? item.memoryError : null
    })
  }
  const root = raw.root && Number.isSafeInteger(raw.root.pid) ? { pid: raw.root.pid, alive: raw.root.alive === true,
    createdAtMs: asNumber(raw.root.createdAtMs), creationFiletime: String(raw.root.creationFiletime ?? '') } : null
  return {
    seq: asNumber(raw.seq), monotonicUs: asNumber(raw.monotonicUs), sampledAtMs: asNumber(raw.sampledAtMs),
    logicalProcessors: asNumber(raw.logicalProcessors), processorGroups: asNumber(raw.processorGroups),
    memoryApi: ['ex2', 'ex', 'base'].includes(raw.memoryApi) ? raw.memoryApi : 'base',
    counters: { unverifiedCandidates: asNumber(raw.counters?.unverifiedCandidates) ?? 0,
      rejectedByCreationTime: asNumber(raw.counters?.rejectedByCreationTime) ?? 0, truncated: raw.counters?.truncated === true },
    root, members
  }
}

const identity = member => `${member.pid}:${member.creationFiletime}`

/**
 * Turns successive raw samples into the figures HiDock shows. Pure: no processes, no clock.
 * `previous` is the sample before `current`, or null for the first one.
 */
// os.availableParallelism() can report fewer than the machine has (it honours affinity and, here, returned half), so
// the fallback counts logical processors the same way the rest of the host telemetry does.
export function summarizeFamily(current, previous, { fallbackLogicalProcessors = cpus().length } = {}) {
  const logical = current.logicalProcessors && current.logicalProcessors > 0 ? current.logicalProcessors : fallbackLogicalProcessors
  const before = new Map((previous?.members ?? []).map(member => [identity(member), member]))
  const elapsedSeconds = previous && current.monotonicUs !== null && previous.monotonicUs !== null
    ? (current.monotonicUs - previous.monotonicUs) / 1e6 : null
  const usableInterval = elapsedSeconds !== null && elapsedSeconds > 0

  let cpuTicks = 0n
  let comparable = 0
  let withoutBaseline = 0
  let noCpuCounter = 0
  for (const member of current.members) {
    if (member.cpuTicks === null) { noCpuCounter++; continue }
    const earlier = before.get(identity(member))
    // A process missing from the previous sample (new, or an id that now names a different process)
    // has no comparable baseline. Its time so far is not guessed at.
    if (!earlier || earlier.cpuTicks === null) { withoutBaseline++; continue }
    comparable++
    cpuTicks += member.cpuTicks >= earlier.cpuTicks ? member.cpuTicks - earlier.cpuTicks : 0n
  }
  // The helper reports a process that stopped once, with its final CPU time, so its last stretch is counted
  // above. What it cannot show is a process that was in the previous sample and is in no later answer at all.
  const currentIds = new Set(current.members.map(identity))
  const vanished = [...before.values()].filter(member => !member.exited && !currentIds.has(identity(member))).length
  const exitedReported = current.members.filter(member => member.exited).length

  let cpuStatus
  let cpuPercent = null
  if (!previous) cpuStatus = 'first-sample'
  else if (!usableInterval) cpuStatus = 'no-elapsed-time'
  else if (comparable === 0) cpuStatus = 'no-comparable-process'
  else {
    cpuPercent = Math.min(100, Number(cpuTicks) / (elapsedSeconds * 1e7) / logical * 100)
    cpuStatus = withoutBaseline > 0 || noCpuCounter > 0 || vanished > 0 ? 'partial' : 'ok'
  }

  const live = current.members.filter(member => !member.exited)
  const anyEx2 = current.memoryApi === 'ex2'
  const basis = anyEx2 ? 'private-working-set' : 'working-set'
  const field = anyEx2 ? 'privateWorkingSetBytes' : 'workingSetBytes'
  const measured = live.filter(member => member[field] !== null)
  const memoryStatus = live.length === 0 ? 'no-live-process' : measured.length === live.length ? 'ok' : measured.length === 0 ? 'unavailable' : 'partial'
  const sum = key => live.every(member => member[key] !== null) && live.length > 0 ? live.reduce((total, member) => total + member[key], 0) : null

  return {
    cpu: { percent: cpuPercent, status: cpuStatus, denominator: 'all-logical-processors', logicalProcessors: logical,
      processorGroups: current.processorGroups, elapsedSeconds: usableInterval ? elapsedSeconds : null,
      comparableProcesses: comparable, withoutBaseline, withoutCpuCounter: noCpuCounter, vanishedBetweenSamples: vanished,
      note: 'Share of the whole machine across all logical processors; the first sample of any process is unknown.' },
    memory: { status: memoryStatus, basis,
      totalMiB: memoryStatus === 'ok' && sum(field) !== null ? sum(field) / MIB : null,
      workingSetTotalMiB: sum('workingSetBytes') === null ? null : sum('workingSetBytes') / MIB,
      privateCommitTotalMiB: sum('privateCommitBytes') === null ? null : sum('privateCommitBytes') / MIB,
      measuredProcesses: measured.length, liveProcesses: live.length,
      sharedPages: anyEx2 ? 'excluded-from-private-working-set' : 'counted-once-per-process-in-working-set',
      note: anyEx2
        ? 'Private working set: physical memory used only by these processes. Private commit is a different quantity and is reported separately.'
        : 'Working set sum: pages shared between processes are counted once per process, so this can exceed real use. This Windows did not provide private working set.' },
    processes: current.members.map(member => ({
      pid: member.pid, ppid: member.ppid, name: member.name, link: member.link, createdAtMs: member.createdAtMs,
      creationFiletime: member.creationFiletime, exited: member.exited, exitCode: member.exitCode,
      workingSetMiB: member.workingSetBytes === null ? null : member.workingSetBytes / MIB,
      privateWorkingSetMiB: member.privateWorkingSetBytes === null ? null : member.privateWorkingSetBytes / MIB,
      privateCommitMiB: member.privateCommitBytes === null ? null : member.privateCommitBytes / MIB,
      memoryError: member.memoryError
    })),
    descendants: { counted: current.members.filter(member => member.link === 'descendant').length,
      orphans: current.members.filter(member => member.link === 'orphan').length,
      rejectedByCreationTime: current.counters.rejectedByCreationTime, unverifiedCandidates: current.counters.unverifiedCandidates,
      truncated: current.counters.truncated, exitedReported,
      note: 'Children, grandchildren and so on that Windows still lists under a process this service owns. A process that started and ended between two samples is never seen.' }
  }
}

/**
 * A running helper, and the last two samples it produced.
 *
 * @param {object} [options]
 * @param {string} [options.path] the helper executable
 * @param {number} [options.rootPid] the process whose family is measured; defaults to this process
 * @param {() => number} [options.now] wall clock, for freshness
 * @param {number} [options.timeoutMs] how long one sample may take before it is called unavailable
 * @param {typeof spawn} [options.spawnFn] injected for tests
 */
export class WindowsProcessSampler {
  constructor({ path = defaultSamplerPath(), rootPid = process.pid, now = Date.now, timeoutMs = 3000, spawnFn = spawn } = {}) {
    Object.assign(this, { path, rootPid, now, timeoutMs, spawnFn })
    this.child = null
    this.buffer = ''
    this.pending = null
    this.previous = null
    this.current = null
    this.summary = null
    this.measuredAt = null
    this.error = null
    this.starts = 0
    this.stopped = false
  }

  get available() { return process.platform === 'win32' && Boolean(this.path) }

  #start() {
    if (this.child || this.stopped) return
    if (!this.available) return
    this.starts++
    const child = this.spawnFn(this.path, ['--root-pid', String(this.rootPid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.child = child
    this.buffer = ''
    // The helper must never be the reason the service cannot exit; it also quits on its own when its input closes.
    child.unref?.()
    child.stdout.unref?.()
    child.stdin.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      this.buffer += chunk
      if (this.buffer.length > 2_000_000) { this.buffer = ''; this.#settle(null, 'output-too-large'); return }
      let newline
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        this.#settle(line, null)
      }
    })
    child.stdin.on('error', () => {})
    child.once('error', error => { this.#lost(`helper-error:${String(error?.code || error?.message || error).slice(0, 60)}`) })
    child.once('exit', (code, signal) => { this.#lost(`helper-exited:${code ?? signal ?? 'unknown'}`) })
  }

  #lost(reason) {
    this.child = null
    this.previous = null
    this.current = null
    this.summary = null
    this.error = reason
    this.#settle(null, reason)
  }

  #settle(line, failure) {
    const waiting = this.pending
    if (!waiting) return
    this.pending = null
    clearTimeout(waiting.timer)
    this.child?.stdout?.unref?.()
    if (failure || line === null) { this.error = failure ?? 'no-answer'; waiting.resolve(false); return }
    const sample = parseSample(line)
    if (!sample) { this.error = 'unreadable-answer'; waiting.resolve(false); return }
    this.previous = this.current
    this.current = sample
    this.summary = summarizeFamily(sample, this.previous)
    this.measuredAt = this.now()
    this.error = null
    waiting.resolve(true)
  }

  /** Ask for one sample. Never throws and never overlaps itself; resolves true when a fresh sample arrived. */
  sample() {
    if (this.pending) return this.pending.promise
    this.#start()
    if (!this.child) return Promise.resolve(false)
    let resolve
    const promise = new Promise(done => { resolve = done })
    const timer = setTimeout(() => { this.error = 'sample-timeout'; this.#settle(null, 'sample-timeout') }, this.timeoutMs)
    // While an answer is awaited the pipe and the deadline count as work, so a caller that only waits for the
    // sample is not abandoned by the event loop; #settle lets go of the pipe again.
    this.child.stdout.ref?.()
    this.pending = { resolve, timer, promise }
    try { this.child.stdin.write('S\n') } catch { this.#lost('helper-write-failed') }
    return promise
  }

  /** What is known right now, with the age of the measurement and the reason when nothing is known. */
  report(staleAfterMs = 15_000) {
    const base = { schema: 1, source: 'native-process-family-sampler', rootPid: this.rootPid,
      gpu: { status: 'unavailable', reason: 'No reliable per-process GPU counter is implemented; whole-device GPU figures are a different quantity.' } }
    if (!this.available) {
      return { ...base, status: 'unavailable', reason: process.platform === 'win32' ? 'helper-not-found' : 'not-windows', measuredAt: null, ageMs: null, ...EMPTY }
    }
    if (!this.current || !this.summary || this.measuredAt === null) {
      return { ...base, status: this.error ? 'unavailable' : 'pending-first-sample', reason: this.error, measuredAt: null, ageMs: null, ...EMPTY }
    }
    const ageMs = Math.max(0, this.now() - this.measuredAt)
    const stale = ageMs > staleAfterMs
    const root = this.current.root
    const status = stale ? 'stale' : this.error ? 'degraded' : root && !root.alive ? 'root-exited' : 'ok'
    // A stale reading is old news: keep the identities and the age, drop the figures.
    const summary = stale ? { ...this.summary, cpu: { ...this.summary.cpu, percent: null, status: 'stale' },
      memory: { ...this.summary.memory, totalMiB: null, workingSetTotalMiB: null, privateCommitTotalMiB: null, status: 'stale' } } : this.summary
    return { ...base, status, reason: this.error, measuredAt: new Date(this.measuredAt).toISOString(), ageMs, staleAfterMs,
      sampledAtMs: this.current.sampledAtMs, root, cpu: summary.cpu, memory: summary.memory, descendants: summary.descendants,
      processes: stale ? summary.processes.map(item => ({ ...item, workingSetMiB: null, privateWorkingSetMiB: null, privateCommitMiB: null })) : summary.processes }
  }

  /** The newest raw member for a pid, with the sample's freshness, or null. Used to match registry entries. */
  lookup(pid) {
    if (!this.current || this.measuredAt === null) return null
    const member = this.current.members.find(item => item.pid === pid) ?? null
    return member ? { member, measuredAt: this.measuredAt, memoryApi: this.current.memoryApi } : null
  }

  stop() {
    this.stopped = true
    const child = this.child
    this.child = null
    this.#settle(null, 'stopped')
    if (!child) return
    try { child.stdin.write('Q\n'); child.stdin.end() } catch { /* already closed */ }
    // The helper quits when its input closes; this only makes sure it cannot outlive its owner.
    const force = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 1500)
    force.unref?.()
    child.once('exit', () => clearTimeout(force))
  }
}

const EMPTY = { root: null, cpu: null, memory: null, descendants: null, processes: [] }
