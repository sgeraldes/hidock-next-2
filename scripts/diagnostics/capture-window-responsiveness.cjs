// Observe renderer scheduling and input without starting work or accessing USB.
const { chromium } = require('playwright')
const fs = require('node:fs')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html'))
  if (!page) throw new Error('HiDock window unavailable')
  const samples = []
  const output = process.argv[2]
  await page.evaluate(() => {
    const state = { started: Date.now(), longTasks: [], gaps: [], inputs: [], previous: performance.now() }
    window.__hidockWindowDiagnostic = state
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ start: entry.startTime, duration: entry.duration })
        if (state.longTasks.length > 200) state.longTasks.shift()
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
    const timer = setInterval(() => {
      const now = performance.now()
      const gap = now - state.previous
      if (gap > 350) {
        state.gaps.push({ time: now, duration: gap, visibility: document.visibilityState })
        if (state.gaps.length > 200) state.gaps.shift()
      }
      state.previous = now
    }, 100)
    const input = event => {
      state.inputs.push({ type: event.type, time: performance.now(), lag: performance.now() - event.timeStamp })
      if (state.inputs.length > 200) state.inputs.shift()
    }
    for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, input, true)
    state.cleanup = () => {
      clearInterval(timer); observer.disconnect()
      for (const type of ['pointerdown', 'click', 'keydown']) document.removeEventListener(type, input, true)
    }
  })
  try {
    for (let i = 0; i < 60; i++) {
      const started = performance.now()
      const value = await Promise.race([
        page.evaluate(() => {
          const s = window.__hidockWindowDiagnostic
          return { started: s.started, longTasks: s.longTasks, gaps: s.gaps, inputs: s.inputs,
            visibility: document.visibilityState, heapBytes: performance.memory?.usedJSHeapSize }
        }),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1500))
      ])
      samples.push({ at: new Date().toISOString(), responseMs: performance.now() - started, ...value })
      fs.writeFileSync(output, JSON.stringify({ samples }, null, 2))
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } finally {
    await page.evaluate(() => window.__hidockWindowDiagnostic?.cleanup()).catch(() => {})
    await browser.close()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
