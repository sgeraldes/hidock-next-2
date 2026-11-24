/** Fixed read-only maintenance checks through the running application owner.
 * Deliberately exercises the execution REFUSAL, never an update request. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ACCEPTED_H1E_FIRMWARE } from '@hidock/jensen-protocol'
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
if (!target) throw Error('Expected maintenance application unavailable')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }) })
try {
  const result = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(Error('Read-only preparation deadline exceeded')), 45000)
    ws.addEventListener('message', event => {
      const response = JSON.parse(event.data)
      if (response.id !== 1) return
      clearTimeout(timer)
      if (response.error || response.result.exceptionDetails) return fail(Error(response.error?.message ?? response.result.exceptionDetails.text))
      ok(response.result.result.value)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression: `(async()=>{
      const j=window.electronAPI.jensen,s=await j.getState();
      if(!s.connected||s.model!=='hidock-h1e'||s.versionNumber!==393984) throw Error('Expected connected official6.3.0 dock');
      const prepared=await j.prepareFirmwareInstall();
      if(prepared.state!=='prepared'||prepared.plan.imageSha256!==${JSON.stringify(ACCEPTED_H1E_FIRMWARE.sha256)}||prepared.plan.imageBytes!==${ACCEPTED_H1E_FIRMWARE.bytes}||prepared.plan.targetVersion!==${ACCEPTED_H1E_FIRMWARE.versionNumber}) throw Error('Wrong preparation');
      let refusal=false;
      try {await j.executeFirmwareInstall(prepared.plan.id,prepared.plan.imageSha256)}catch(e){refusal=String(e).includes('read-only')}
      if(!refusal) throw Error('Maintenance execution was not refused');
      const attempts=await j.getFirmwareInstallAttempts(),stored=attempts.find(a=>a.plan.id===prepared.plan.id);
      if(stored.state!=='prepared'||stored.events.length!==1) throw Error('Execution crossed durable request boundary');
      const after=await j.getState();
      if(!after.connected||after.versionNumber!==393984) throw Error('Device state changed');
      return {observedAt:new Date().toISOString(),boundary:'running-app-IPC/sole-USB-owner/real-journal',sourceVersion:prepared.plan.sourceVersion,targetVersion:prepared.plan.targetVersion,imageSha256:prepared.plan.imageSha256,imageBytes:prepared.plan.imageBytes,preparedState:stored.state,preparedRecordReadBack:true,maintenanceExecuteRefused:true,requestBoundaryCrossed:false,firmwareUploaded:false};
    })()` } }))
  })
  const folder = resolve('node_modules/.cache/firmware-update-verification'); await mkdir(folder, { recursive: true })
  const path = resolve(folder, `preparation-${Date.now()}.json`)
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ ...result, evidencePath: path }, null, 2))
} finally { ws.close() }
