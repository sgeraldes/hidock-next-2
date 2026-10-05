// Isolated Chromium boundary test. Never loads the application's main process,
// config, database or hardware devices. All sources are generated oscillators.
const { app, BrowserWindow, desktopCapturer } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('fs')
const { join } = require('path')
app.setPath('userData', process.argv[2])
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Exercise hardware-free output at the hosted runner fallback sample rate.
app.commandLine.appendSwitch('disable-audio-output')
app.commandLine.appendSwitch('audio-output-sample-rate', '44100')
if (process.argv[4] === 'fake-devices') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  if (process.argv[4] === 'fake-devices') {
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(true))
    window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then(sources => callback({ video: sources[0], audio: 'loopback' }))
        .catch(error => { console.error(error); callback({}) })
    })
  }
  try {
    mkdirSync(process.argv[2], { recursive: true })
    const html = join(process.argv[2], 'blank.html')
    writeFileSync(html, '<!doctype html><html><head></head><body></body></html>')
    await window.loadFile(html)
    const payload = readFileSync(process.argv[3], 'utf8')
    let result
    if (process.argv[4] === 'ui-stages') {
      result = []
      for (const [index, script] of JSON.parse(payload).entries()) {
        result.push(await window.webContents.executeJavaScript(script, true))
        const screenshot = await window.webContents.capturePage()
        writeFileSync(join(process.argv[2], `stage-${index}.png`), screenshot.toPNG())
      }
    } else result = await window.webContents.executeJavaScript(payload, true)
    process.stdout.write(`PC_CAPTURE_RESULT=${JSON.stringify(result)}\n`)
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
