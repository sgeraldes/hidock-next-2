const fs = require('node:fs')
;(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9337/json')).json()
  const tab = tabs.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!tab) throw new Error('Benchmark window not found')
  const socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  let id = 0
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 5000)
    function receive(event) {
      const response = JSON.parse(event.data)
      if (response.id !== request) return
      clearTimeout(timer)
      socket.removeEventListener('message', receive)
      response.error ? reject(response.error) : resolve(response.result)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id: request, method, params }))
  })
  const screenshot = await call('Page.captureScreenshot')
  fs.writeFileSync(process.argv[2], Buffer.from(screenshot.data, 'base64'))
  const state = await call('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,ready:document.readyState,buttons:document.querySelectorAll("button").length})', returnByValue: true })
  console.log(state.result.value)
  socket.close()
})().catch(error => { console.error(error); process.exitCode = 1 })
