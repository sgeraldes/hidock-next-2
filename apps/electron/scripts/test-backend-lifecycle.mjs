import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'hidock-backend-fixture-'))
mkdirSync(join(root, 'profile'))
writeFileSync(join(root, 'profile', 'config.json'), JSON.stringify({ storage: { dataPath: join(root, 'storage') }, device: { autoConnect: false, autoDownload: false }, transcription: { provider: 'vibevoice', autoTranscribe: false, speakerEngine: 'off' }, brains: { enabled: { 'gemini-api': false, ollama: false, 'local-onnx-embed': false } }, features: { preset: 'custom', flags: { calendar: false, 'device-sync': false, 'clipboard-capture': false, 'context-graph': false } } }))
async function run() {
  const env = { ...process.env, HIDOCK_BACKEND_FIXTURE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  // The requested test must exercise a real visible native UI, not SW_HIDE.
  const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('scripts/backend-lifecycle-fixture.cjs')], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const timer = setTimeout(() => child.kill(), 90000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer)
  writeFileSync(join(root, 'electron.log'), logs)
  assert.equal(code, 0, logs.slice(-6000))
  assert.equal(existsSync(join(root, 'profile', 'brain.json')), false, 'stop removes discovery lock')
  return JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
}
const first = await run()
const second = await run()
assert.notEqual(first.pid, second.pid)
assert.equal(second.samePid, true)
console.log(JSON.stringify({ root, first, restart: second, stopped: true, restarted: true }, null, 2))
