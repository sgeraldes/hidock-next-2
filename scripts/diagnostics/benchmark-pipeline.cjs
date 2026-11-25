// Observe a running job through the real application's authenticated preload bridge.
// Bounded five-second sampling; no USB access or additional transcription requests.
const { chromium } = require('playwright')
const { writeFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('index.html'))
  if (!page) throw new Error('HiDock main window unavailable')
  const samples = []
  const sampleLimit = Number(process.argv[3] || 60)
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 60) throw new Error('Invalid sample limit')
  let observedActive = false
  try {
    for (let i = 0; i < sampleLimit; i++) {
      const started = performance.now()
      const snapshot = await page.evaluate(() => window.electronAPI.modelHost.telemetry())
      samples.push({ ipcResponseMs: performance.now() - started, ...snapshot })
      writeFileSync(process.argv[2], JSON.stringify({ samples }, null, 2))
      const active = snapshot.jobs.find(job => job.active)
      console.log(JSON.stringify({ sample: i, cpu: snapshot.client.systemCpuPercent,
        delayMs: snapshot.client.eventLoopDelayMs, peakDelayMs: snapshot.client.peakEventLoopDelayMs,
        queue: snapshot.queue, hostJobs: snapshot.host.telemetry?.activeJobs,
        stage: active?.spans.filter(span => span.status === 'running').map(span => span.stage) }))
      if (snapshot.queue.processingCount > 0) observedActive = true
      if (observedActive && snapshot.queue.processingCount === 0 && snapshot.queue.pendingCount === 0) break
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  } finally { await browser.close() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
