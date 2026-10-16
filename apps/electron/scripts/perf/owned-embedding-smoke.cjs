// Real Electron/ONNX boundary, isolated from HiDock's profile, database and USB.
const { app, utilityProcess } = require('electron')
const { spawn } = require('child_process')
const { join, resolve } = require('path')
const { mkdtempSync, appendFileSync } = require('fs')
const { tmpdir, availableParallelism, freemem } = require('os')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'hidock-embedding-smoke-')))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
const root = resolve(__dirname, '../..')
const reportPath = join(root, 'out', 'embedding-smoke.jsonl')
function report(value) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value })
  appendFileSync(reportPath, line + '\n')
}
const model = process.argv[2]
if (!model || freemem() < 12 * 1024 ** 3) throw new Error('Explicit model directory and 12 GB free RAM required')
const threads = Math.max(1, Math.floor(availableParallelism() / 2))
let worker, guard, sample, completed = false, peakMiB = 0, peakCpu = 0, maxDelayMs = 0
const began = Date.now()
process.on('uncaughtException', error => finish(1, { error: String(error) }))
process.on('unhandledRejection', error => finish(1, { error: String(error) }))
function finish(code, result) {
  if (completed) return
  completed = true
  clearInterval(sample)
  guard?.kill()
  worker?.kill()
  report({ ...result, elapsedMs: Date.now() - began, peakMiB, peakCpu, maxDelayMs })
  setTimeout(() => app.exit(code), 300)
}
app.whenReady().then(() => {
  worker = utilityProcess.fork(join(root, 'out/spec013-staged/main/local-embedder-worker.js'),
    [model, '50', String(threads)], { serviceName: 'HiDock isolated benchmark', stdio: 'pipe' })
  worker.stdout.on('data', () => {})
  worker.stderr.on('data', data => appendFileSync(reportPath + '.stderr', data))
  worker.on('exit', code => finish(1, { error: 'Worker exited', code }))
  worker.on('spawn', () => {
    guard = spawn('python', [join(root, 'resources/speaker-linking/resource_policy.py'), String(worker.pid), String(process.pid)], {
      windowsHide: true, env: { ...process.env, HIDOCK_DIARIZATION_THREADS: String(threads),
        HIDOCK_WORKER_MEMORY_MB: '8192', HIDOCK_WORKER_PRIORITY: 'below-normal' } })
    let output = '', ready = false
    guard.stderr.on('data', data => appendFileSync(reportPath + '.stderr', data))
    guard.on('error', error => finish(1, { error: String(error) }))
    guard.on('exit', code => { if (!completed) finish(1, { error: 'Guard exited', code }) })
    guard.stdout.on('data', data => {
      if (ready) return
      output += data
      if (!output.includes('\n')) return
      try {
        const policy = JSON.parse(output.split('\n')[0]); ready = true
        report({ policy, workerPid: worker.pid })
        worker.postMessage({ id: 1, texts: ['A bounded resource policy keeps foreground applications responsive.'], purpose: 'query' })
      } catch (error) { finish(1, { error: String(error) }) }
    })
  })
  worker.on('message', message => {
    if (message.type === 'timing') { report(message); return }
    const vector = message.vectors?.[0]
    const valid = Array.isArray(vector) && vector.length === 2048 && vector.every(Number.isFinite)
    finish(valid ? 0 : 1, { success: valid, dimensions: vector?.length, backend: message.backend,
      cpuThreads: message.cpuThreads, error: message.error })
  })
  let previous = Date.now()
  sample = setInterval(() => {
    const now = Date.now(); maxDelayMs = Math.max(maxDelayMs, now - previous - 250); previous = now
    const metric = app.getAppMetrics().find(row => row.pid === worker.pid)
    peakMiB = Math.max(peakMiB, (metric?.memory.workingSetSize || 0) / 1024)
    peakCpu = Math.max(peakCpu, metric?.cpu.percentCPUUsage || 0)
    if (now - began > 90000 || freemem() < 4 * 1024 ** 3) finish(1, { error: 'Benchmark resource/deadline stop' })
  }, 250)
})
