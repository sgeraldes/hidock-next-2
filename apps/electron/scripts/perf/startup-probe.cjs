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
// --audio-check: after boot, wait for the audio check pass over the library,
// read the categories back through the Library's own IPC, search for one
// recording and screenshot its row. Verification only; nothing is timed.
const audioCheck = process.env.HIDOCK_BENCH_AUDIO_CHECK || ''
async function captureAudioCheck(message) {
  try {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'))
    const counts = await window.webContents.executeJavaScript(
      'window.electronAPI.recordings.getAll().then(rows => rows.reduce((acc, r) => { const k = r.audio_category || "unchecked"; acc[k] = (acc[k] || 0) + 1; return acc }, {}))')
    emit({ type: 'audio-check', summary: message.slice(0, 300), counts })
    // Type the filename into the Library search the way a person would.
    await window.webContents.executeJavaScript(`(() => {
      const input = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').startsWith('Search') && i.closest('main'))
        || Array.from(document.querySelectorAll('input')).filter(i => (i.placeholder || '').startsWith('Search')).pop()
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(audioCheck)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await new Promise(r => setTimeout(r, 3000))
    const labels = await window.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("[data-testid=audio-label]")).map(e => e.textContent)')
    emit({ type: 'audio-check-row', search: audioCheck, labels })
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(output, 'audio-check.png'), image.toPNG())
  } catch (error) {
    emit({ type: 'audio-check', error: String(error) })
  }
  setTimeout(finish, 1000)
}
let task
let completedEmbedding = false
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const message = String(args[0])
    if (message.startsWith('[LocalEmbedder] Worker completed ')) completedEmbedding = true
    if (audioCheck && message.startsWith('[AudioProfile] profiled ')) void captureAudioCheck(message)
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
      // What the owner would see at this moment: open dialogs and a screenshot.
      setTimeout(async () => {
        try {
          const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'))
          const dialogs = await window.webContents.executeJavaScript(
            'Array.from(document.querySelectorAll("[role=dialog]")).map(d => ({ testId: d.getAttribute("data-testid"), ' +
            'title: d.querySelector("h2")?.textContent ?? null, ' +
            'options: Array.from(d.querySelectorAll("input[type=radio]")).map(r => ({ engine: r.value, disabled: r.disabled, checked: r.checked })) }))')
          emit({ type: 'ui-dialogs', dialogs })
          const image = await window.webContents.capturePage()
          fs.writeFileSync(path.join(output, 'boot-settled.png'), image.toPNG())
        } catch (error) {
          emit({ type: 'ui-dialogs', error: String(error) })
        }
      }, 1500)
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
      } else if (!audioCheck) setTimeout(finish, 20000)
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
  // A window behind other windows gets its timers throttled to once a second,
  // which reads as a steady 750 ms renderer lateness that is not a freeze.
  // Measure the renderer the same way whether or not the window is on top.
  window.webContents.setBackgroundThrottling(false)
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
