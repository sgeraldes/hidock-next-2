// @vitest-environment node
import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { availableParallelism, tmpdir } from 'node:os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cancelLocalStageRestart, restartLocalStageAfterExit } from '../local-stage-restart'

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
it.skipIf(process.platform !== 'win32')('changes isolated CPU policy, replaces only after actual owner exit, then cancels both worker and descendant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hidock-cpu-restart-'))
  const db = new DatabaseSync(join(directory, 'isolated.db'))
  db.exec("CREATE TABLE profile(percent INTEGER); INSERT INTO profile VALUES(25); CREATE TABLE runs(id INTEGER PRIMARY KEY, pid INTEGER, percent INTEGER, status TEXT); CREATE TABLE checkpoints(value TEXT); INSERT INTO checkpoints VALUES('retained-provider-result');")
  const workers: ChildProcess[] = [], reports: any[] = [], closures: Promise<void>[] = []
  let owner: ChildProcess | undefined, sequence = 0
  async function admit() {
    expect(owner).toBeUndefined()
    const percent = Number(db.prepare('SELECT percent FROM profile').get()!.percent)
    const id = ++sequence, threads = Math.max(1, Math.floor(availableParallelism() * percent / 100))
    const child = spawn('python', ['-S', resolve('resources/speaker-linking/supervised_runner.py'),
      resolve('electron/main/services/__tests__/fixtures/cpu-policy-sleeper.py')], { windowsHide: true,
      env: { ...process.env, HIDOCK_DIARIZATION_THREADS: String(threads), HIDOCK_WORKER_MEMORY_MB: '256', HIDOCK_WORKER_PRIORITY: 'below-normal' },
      stdio: ['ignore', 'pipe', 'pipe'] })
    workers.push(child); owner = child
    let output = '', stderr = '', ended = false
    const report: any = { id, requestedPercent: percent, expectedThreads: threads, startedAt: new Date().toISOString() }
    reports.push(report)
    const closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      ended = true; report.exitCode = code; report.exitSignal = signal; report.closedAt = new Date().toISOString()
      db.prepare("UPDATE runs SET status='closed' WHERE id=?").run(id)
      if (owner === child) owner = undefined
      resolve()
    }))
    closures.push(closed)
    child.once('error', e => { stderr += e.message })
    child.stdout!.on('data', b => { output += b.toString() })
    child.stderr!.on('data', b => { stderr += b.toString() })
    const deadline = Date.now() + 10000
    while (!output.includes('\n')) { if (ended || Date.now() > deadline) throw Error('Supervised fixture did not start: ' + stderr); await pause(20) }
    Object.assign(report, JSON.parse(output.split('\n')[0]))
    const policyLine = stderr.split('\n').find(line => line.startsWith('[ResourcePolicy] '))
    expect(policyLine).toBeTruthy()
    report.policy = JSON.parse(policyLine!.slice('[ResourcePolicy] '.length))
    report.pid = child.pid
    db.prepare("INSERT INTO runs VALUES(?,?,?,'running')").run(id, child.pid!, percent)
    expect(report.observedJobFlags & 5).toBe(5)
    expect(report.observedJobRatePercent).toBe(report.policy.cpuPercent)
    expect(report.policy.threads).toBe(threads)
    expect(report.policy.memoryMb).toBe(256)
    expect(report.policy.priority).toBe('below-normal')
    return { child, closed, report }
  }
  try {
    const first = await admit()
    db.prepare('UPDATE profile SET percent=50').run()
    let replacement: Promise<Awaited<ReturnType<typeof admit>>> | undefined
    await restartLocalStageAfterExit('isolated-recording', {
      eligible: () => true, cancel: () => { first.child.kill() }, isOwned: () => !!owner,
      wait: () => first.closed, enqueue: () => { expect(owner).toBeUndefined(); replacement = admit() }
    })
    const second = await replacement!
    expect(reports.map(r => r.requestedPercent)).toEqual([25, 50])
    expect(reports[1].observedJobRatePercent).toBeGreaterThan(reports[0].observedJobRatePercent)
    expect(alive(first.report.pid)).toBe(false)
    expect(db.prepare('SELECT value FROM checkpoints').get()!.value).toBe('retained-provider-result')
    cancelLocalStageRestart() // The actual cancel-all primitive revokes outstanding restart intent.
    second.child.kill(); await second.closed
    const deadline = Date.now() + 3000
    while (reports.some(r => alive(r.descendantPid)) && Date.now() < deadline) await pause(30)
    expect(reports.every(r => !alive(r.pid) && !alive(r.descendantPid))).toBe(true)
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get()!.n).toBe(0)
    // Also exercise cancellation while an actual owned worker is exiting: no third admission.
    const third = await admit()
    let admissions = 0
    const pending = restartLocalStageAfterExit('cancel-pending', {
      eligible: () => true, cancel: () => { third.child.kill() }, isOwned: () => !!owner,
      wait: () => third.closed, enqueue: () => { admissions++ }
    })
    cancelLocalStageRestart()
    await expect(pending).rejects.toThrow('Restart cancelled')
    expect(admissions).toBe(0)
    await pause(100)
    expect(alive(third.report.descendantPid)).toBe(false)
    const evidence = { testedAt: new Date().toISOString(), boundary: 'production restart coordinator + production Windows Job supervisor + isolated SQLite profile/ownership fixture',
      appUiExercised: false, modelInferenceExercised: false, checkpointPreserved: true, noReplacementAfterCancel: admissions === 0,
      allOwnedProcessesExited: reports.every(r => !alive(r.pid) && !alive(r.descendantPid)), runs: reports }
    const out = resolve('../../.diagnostics/spec013-cpu-restart')
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'owned-worker-chain.json'), JSON.stringify(evidence, null, 2))
  } finally {
    for (const worker of workers) if (worker.exitCode === null && worker.signalCode === null) worker.kill()
    await Promise.all(closures)
    db.close(); rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
