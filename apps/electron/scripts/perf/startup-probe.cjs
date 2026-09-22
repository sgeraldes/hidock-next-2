// Run only through benchmark-startup.py against its isolated profile.
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const inspector = require('node:inspector')
const { app, BrowserWindow } = require('electron')
const output = process.env.HIDOCK_BENCH_OUTPUT
if (!output || !process.env.HIDOCK_DEV_USERDATA) throw new Error('Benchmark isolation is required')
const started = performance.now()
const now = () => performance.now() - started
const log = fs.openSync(path.join(output, 'events.jsonl'), 'w')
const emit = (event) => fs.writeSync(log, JSON.stringify({ ms: now(), ...event }) + '\n')
const profiler = new inspector.Session()
profiler.connect()
profiler.post('Profiler.enable')
profiler.post('Profiler.setSamplingInterval', { interval: 2000 })
profiler.post('Profiler.start')
let finishing = false
function finish() {
  if (finishing) return
  finishing = true
  profiler.post('Profiler.stop', (error, result) => {
    if (result) fs.writeFileSync(path.join(output, 'main.cpuprofile'), JSON.stringify(result.profile))
    emit({ type: 'finish', error: error?.message })
    app.exit(0)
  })
}
const original = { ...console }
let task
let completedEmbedding = false
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const message = String(args[0])
    if (message.startsWith('[LocalEmbedder] Worker completed ')) completedEmbedding = true
    const match = message.match(/\[BootScheduler\] starting "([^"]+)"/)
    if (message.startsWith('[BootTiming] ')) {
      emit({ type: 'task-duration', ...JSON.parse(message.slice(13)) })
    }
    if (match) {
      if (task) emit({ type: 'task-end-bound', name: task })
      task = match[1]
      emit({ type: 'task-start', name: task })
    }
    // Store operational milestones only, never transcript contents or credentials.
    if (/initialized|Recording watcher started|\[BootScheduler\]|\[VectorStore\]|\[Startup\]|\[LocalEmbedder\]/.test(message)) {
      emit({ type: 'milestone', message: message.slice(0, 500) })
    }
    if (message.includes('[BootScheduler] Complete')) {
      emit({ type: 'boot-settled' })
      if (process.env.HIDOCK_BENCH_INFERENCE === '1') {
        setTimeout(async () => {
          const name = 'local-semantic-query'
          const start = now()
          emit({ type: 'task-start', name })
          try {
            const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'))
            const count = await window.webContents.executeJavaScript(
              'window.electronAPI.rag.search("benchmark startup responsiveness", 5).then(rows => rows.length)')
            emit({ type: 'task-duration', name, elapsedMs: now() - start, ok: completedEmbedding,
              resultCount: count, embeddingCompleted: completedEmbedding })
          } catch (error) {
            emit({ type: 'task-duration', name, elapsedMs: now() - start, ok: false, error: String(error) })
          }
          setTimeout(finish, 10000)
        }, 3000)
      } else setTimeout(finish, 20000)
    }
    original[level](...args)
  }
}
let expected = performance.now() + 250
let previous = performance.eventLoopUtilization()
setInterval(() => {
  const current = performance.now()
  const usage = performance.eventLoopUtilization(previous)
  previous = performance.eventLoopUtilization()
  emit({ type: 'heartbeat', delayMs: Math.max(0, current - expected), elu: usage.utilization,
    rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed })
  expected = current + 250
}, 250).unref()
app.on('browser-window-created', (_, window) => {
  const id = window.id
  emit({ type: 'window-created', id })
  for (const event of ['did-start-loading', 'dom-ready', 'did-finish-load']) {
    window.webContents.on(event, () => emit({ type: event, id }))
  }
  window.webContents.on('did-finish-load', () => {
    window.webContents.executeJavaScript(`(() => {
      const samples = []; let expected = performance.now() + 250;
      setInterval(() => { const t = performance.now(); samples.push({ms:t,delayMs:Math.max(0,t-expected)}); expected=t+250 },250);
      window.__hidockBench = samples; return performance.timeOrigin;
    })()`).then(origin => emit({ type: 'renderer-origin', id, origin })).catch(() => {})
    const sample = setInterval(() => {
      if (window.isDestroyed()) return clearInterval(sample)
      window.webContents.executeJavaScript('window.__hidockBench?.splice(0) || []')
        .then(samples => emit({ type: 'renderer-heartbeats', id, samples })).catch(() => {})
    }, 1000)
  })
})
emit({ type: 'start', epoch: Date.now(), pid: process.pid })
require(path.resolve(__dirname, '../../out/main/index.js'))
