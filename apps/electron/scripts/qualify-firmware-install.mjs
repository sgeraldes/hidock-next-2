/** Explicit one-attempt installation through the trusted development app owner.
 * No independent USB handle, automatic retry, reset, unplug or update fallback. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE } from '@hidock/jensen-protocol'
import { openValidationClient } from './device-validation-client.mjs'
const [mode, selected, confirmation] = process.argv.slice(2)
if (!['execute', 'observe'].includes(mode)) throw Error('Use execute <hardened|stock-forward> <exact-SHA256>, or observe <attempt-UUID>')
const descriptor = selected === 'hardened' ? ACCEPTED_H1E_FIRMWARE : selected === 'stock-forward' ? ACCEPTED_H1E_FORWARD_STOCK_RESTORE : null
if (mode === 'execute' && (!descriptor || confirmation !== descriptor.sha256)) throw Error('Explicit selected target and exact pinned SHA256 required')
if (mode === 'execute' && selected === 'stock-forward' && !process.argv.includes('--recovery-requested')) throw Error('Keep custom firmware installed; stock execution is reserved for an actual operator-requested recovery')
if (mode === 'observe' && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(selected ?? '')) throw Error('Exact existing attempt UUID required')
const client = await openValidationClient(), folder = resolve('node_modules/.cache/completion630-runtime')
await mkdir(folder, { recursive: true })
const path = resolve(folder, `firmware-${mode}-${Date.now()}.json`)
const result = { observedAt: new Date().toISOString(), boundary: 'built-app/trusted-preload/sole-USB-owner/durable-attempt/physical-dock', mode,
  resetCommandsIssued: 0, powerCyclesRequested: 0, automaticallyRetried: false }
try {
  if (mode === 'execute') {
    const prepared = await client.evaluate(`(async()=>{
      const j=window.electronAPI.jensen;
      if(!await j.isConnected() && !await j.connect()) throw Error('Expected dock unavailable');
      const diagnostics=await j.getAudioDiagnostics();
      if(diagnostics.session.status!=='idle') throw Error('Application audio is active');
      const p=await j.prepareFirmwareInstall(${JSON.stringify(selected)});
      if(p.state!=='prepared'||p.plan.imageSha256!==${JSON.stringify(descriptor.sha256)}||p.plan.targetVersion!==${descriptor.versionNumber}||p.plan.imageBytes!==${descriptor.bytes}) throw Error('Prepared exact image did not match');
      return {id:p.plan.id,sourceVersion:p.plan.sourceVersion,targetVersion:p.plan.targetVersion,imageSha256:p.plan.imageSha256,imageBytes:p.plan.imageBytes,state:p.state};
    })()`, 45000)
    result.prepared = prepared
    await writeFile(path, JSON.stringify(result,null,2)+'\n', {flag:'wx'})
    const outcome = await client.evaluate(`(async()=>{
      const j=window.electronAPI.jensen,a=await j.executeFirmwareInstall(${JSON.stringify(prepared.id)},${JSON.stringify(descriptor.sha256)});
      return {id:a.plan.id,state:a.state,events:a.events.map(e=>({state:e.state,at:e.at,reason:e.reason}))};
    })()`, 380000)
    result.outcome = outcome
    result.transferAcknowledged = outcome.state === 'awaiting-boot'
    result.physicalBootConfirmed = false
  } else {
    const outcome = await client.evaluate(`(async()=>{
      const j=window.electronAPI.jensen,a=await j.observeFirmwareInstall(${JSON.stringify(selected)});
      const s=await j.getState();
      return {id:a.plan.id,sourceVersion:a.plan.sourceVersion,targetVersion:a.plan.targetVersion,imageSha256:a.plan.imageSha256,state:a.state,
        events:a.events.map(e=>({state:e.state,at:e.at,reason:e.reason})),connected:s.connected,version:s.versionNumber};
    })()`, 200000)
    result.outcome = outcome
    result.physicalBootConfirmed = outcome.state === 'confirmed'
    result.imageBytesAttestedByDevice = false
  }
} catch {
  result.failure = 'Owner operation failed or outcome unavailable; inspect durable attempt before any further mutation'
  result.physicalBootConfirmed = false
  process.exitCode = 1
} finally {
  client.close()
  await writeFile(path, JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({...result,evidencePath:path},null,2))
}
if (mode === 'execute' && result.outcome?.state !== 'awaiting-boot') process.exitCode = 1
if (mode === 'observe' && result.outcome?.state !== 'confirmed') process.exitCode = 1
