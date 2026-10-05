// Run after npm run build. This boots the shipped renderer and IPC in an isolated profile.
const { app } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { resolve, join } = require('path')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')

const root = resolve(__dirname, '../..')
const base = join(root, 'out', 'retrieval-smoke')
const profile = join(base, 'profile')
const data = join(base, 'data-root')
const appData = join(base, 'appdata')
for (const folder of [profile, data, appData, join(base, 'session')]) mkdirSync(folder, { recursive: true })
app.setPath('appData', appData)
app.setPath('userData', profile)
app.setPath('sessionData', join(base, 'session'))
app.disableHardwareAcceleration()
process.env.HIDOCK_DEV_USERDATA = profile
process.env.HIDOCK_DEV_CDP_PORT = '0'
writeFileSync(join(profile, 'config.json'), JSON.stringify({
  storage: { dataPath: data }, calendar: { syncEnabled: false }, device: { autoConnect: false, autoDownload: false },
  transcription: { autoTranscribe: false, speakerLinkingEnabled: false },
  brains: { enabled: { 'gemini-api': false, ollama: false, 'local-onnx-embed': false, 'claude-code': false,
    codex: false, 'gemini-cli': false, kiro: false, 'openai-compatible': false } },
  features: { preset: 'custom', flags: { 'device-sync': false, calendar: false, transcription: true,
    'meeting-intelligence': false, 'context-graph': false, assistant: true, explore: true } },
  chat: { recordQueries: true, keepQueryText: true }
}))

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(200) }
  throw new Error('Timed out waiting for the smoke-test state')
}
const timeout = setTimeout(() => { console.error('Retrieval smoke timed out'); app.exit(1) }, 60000)
let tested = false

app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  const hideWindow = () => window.hide()
  window.on('show', hideWindow)
  window.webContents.on('did-finish-load', () => {
    if (tested || !window.webContents.getURL().includes('/renderer/index.html')) return
    tested = true
    const js = code => window.webContents.executeJavaScript(code)
    void (async () => {
      await until(() => js('!!window.electronAPI'))
      const config = await js('window.electronAPI.config.get()')
      assert.equal(config.data.storage.dataPath, data)
      console.log('Smoke: isolated config verified')
      const result = await js("window.electronAPI.rag.globalSearch('retrieval smoke question')")
      assert.equal(result.success, true)
      console.log('Smoke: Explore IPC returned')
      const conversation = await js("window.electronAPI.assistant.createConversation('Retrieval trace smoke')")
      assert(conversation.id)
      const chat = await js(`window.electronAPI.rag.chat(${JSON.stringify({ sessionId: conversation.id, message: 'retrieval smoke question' })})`)
      assert.equal(chat.success, true)
      assert(chat.data.generationId)
      const answer = await js(`window.electronAPI.assistant.addMessage(${JSON.stringify(conversation.id)}, 'assistant', '', undefined, ${JSON.stringify(chat.data.generationId)})`)
      await delay(2200)
      await js("location.hash = '#/settings/assistant'")
      console.log('Smoke: Settings navigation requested')
      await delay(500)
      await js("Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent === 'Close')?.click()")
      await until(() => js("!document.querySelector('[role=dialog]')"))
      await until(() => js("!!document.getElementById('record-queries')"))
      assert.equal(await js("document.getElementById('record-queries').getAttribute('data-state')"), 'checked')
      assert.equal(await js("document.getElementById('keep-query-text').getAttribute('data-state')"), 'checked')
      await until(() => js("document.body.innerText.includes('Last 7 days:')"))
      const path = join(data, 'traces', 'retrieval-traces.db')
      const db = new Database(path, { readonly: true })
      const initial = db.prepare('SELECT COUNT(*) AS count FROM traces').get().count
      assert(initial >= 1)
      const textRow = db.prepare("SELECT query_text, text_state FROM traces WHERE consumer = 'explore' ORDER BY rowid DESC LIMIT 1").get()
      assert.equal(textRow.text_state, 'encrypted')
      assert(textRow.query_text && !textRow.query_text.includes('retrieval smoke question'))
      const chatRow = db.prepare('SELECT event, answer_message_id FROM traces WHERE trace_id = ?').get(chat.data.generationId)
      assert.equal(chatRow.answer_message_id, answer.id)
      assert.equal(JSON.parse(chatRow.event).status, 'error')
      assert.equal(JSON.parse(chatRow.event).error, 'generation-failed')
      console.log('Smoke: switches and real encrypted SQLite row verified')

      window.removeListener('show', hideWindow)
      window.showInactive()
      window.setSize(1280, 900)
      await js("document.getElementById('record-queries').scrollIntoView({block:'center'})")
      await delay(500)
      writeFileSync(join(base, 'desktop.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      window.setMinimumSize(900, 700)
      window.setSize(900, 700)
      await js("document.getElementById('record-queries').scrollIntoView({block:'center'})")
      await delay(500)
      writeFileSync(join(base, 'compact.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      window.hide()

      await js("document.getElementById('keep-query-text').click()")
      await until(async () => (await js('window.electronAPI.config.get()')).data.chat.keepQueryText === false)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traces WHERE query_text IS NOT NULL').get().count, 0)
      await js("document.getElementById('record-queries').click()")
      await until(async () => (await js('window.electronAPI.config.get()')).data.chat.recordQueries === false)
      await js("window.electronAPI.rag.globalSearch('disabled smoke question')")
      await delay(2200)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traces').get().count, initial)
      assert.equal(JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8')).chat.recordQueries, false)
      db.close()
      clearTimeout(timeout)
      console.log('RETRIEVAL_SMOKE_PASS: renderer switches, chat/Explore IPC, generation-failure trace, persisted answer link, real safeStorage, text erasure, recording off; 16 assertions passed')
      app.quit()
    })().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
  })
})
require(join(root, 'out', 'main', 'index.js'))
