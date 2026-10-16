/** Read-only developer preflight through the running app. Never opens USB itself. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
if (process.argv[2] !== 'preflight') throw new Error('Only the read-only preflight mode is available')
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
if (!target) throw new Error('Expected deployed app target is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => {
  socket.addEventListener('open', ok, { once: true })
  socket.addEventListener('error', fail, { once: true })
})
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data), request = pending.get(value.id)
  if (request) {
    pending.delete(value.id)
    clearTimeout(request.timer)
    value.error ? request.fail(new Error(value.error.message)) : request.ok(value.result)
  }
})
async function evaluate(expression) {
  const id = ++sequence
  const result = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { pending.delete(id); fail(new Error('Read-only preflight timed out')) }, 45000)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
try {
  const observation = await evaluate(`(async()=>{
    const j=window.electronAPI.jensen,s=await j.getState(),d=await j.getAudioDiagnostics();
    if(!s.connected||s.model!=='hidock-h1e'||s.versionNumber!==393984||s.recording||d.session.status!=='idle') throw Error('Expected idle stock H1E6.3.0');
    if(typeof j.getFirmwareUpdatePreflight!=='function') throw Error('Preflight API is not deployed');
    const preflight=await j.getFirmwareUpdatePreflight();
    if(!preflight) return {observedAt:new Date().toISOString(),preflight:null,failure:'strict-preflight-unavailable',legacyCardSnapshot:await j.getCardInfo(),firmwareUploaded:false,mutatingCommandsRequested:0};
    if(preflight.activeRecording) throw Error('Native recording active');
    const ordinaryCard=await j.getCardInfo();
    if(!ordinaryCard||ordinaryCard.capacity!==preflight.card.capacityMiB||ordinaryCard.free!==preflight.card.freeMiB||parseInt(ordinaryCard.status,16)!==preflight.card.statusCode) throw Error('Ordinary card reader was not restored after preflight');
    const after=await j.getState(),last=await j.getAudioDiagnostics();
    if(!after.connected||after.versionNumber!==393984||last.session.status!=='idle') throw Error('Device changed during preflight');
    return {observedAt:new Date().toISOString(),preflight,liveIdle:true,ordinaryCardReaderRestored:true,firmwareUploaded:false,mutatingCommandsRequested:0};
  })()`)
  const folder = resolve('node_modules', '.cache', 'firmware-update-verification')
  await mkdir(folder, { recursive: true })
  const output = resolve(folder, `preflight-${Date.now()}.json`)
  await writeFile(output, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ ...observation, evidencePath: output }, null, 2))
  if (observation.failure) process.exitCode = 1
} finally { socket.close() }
