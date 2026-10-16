/** Read-only real app/stock-dock gate test. Never opens USB independently. */
import { openValidationClient } from './device-validation-client.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const client = await openValidationClient()
try {
  const result = await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen;
    if(!await j.isConnected() && !await j.connect()) throw Error('Dock unavailable');
    const info=await j.getDeviceInfo();
    if(info?.model!=='hidock-h1e'||info.versionNumber!==393984) throw Error('Expected original stock dock');
    // Connect broadcasts trigger the renderer's normal initial read refresh.
    // Measure after it settles; don't attribute that refresh to the refusal.
    let quiet=0;
    for(let i=0;i<50 && quiet<3;i++){
      const d=await j.getProtocolDiagnostics();
      quiet=d.queuedCommands===0&&d.currentCommand===null&&!d.activeDownload&&!d.fileStreamPending ? quiet+1:0;
      await new Promise(ok=>setTimeout(ok,100));
    }
    if(quiet<3) throw Error('Application initial reads did not settle');
    const before=await j.getProtocolDiagnostics();
    const value=await j.beginOwnedScratchUpload({totalBytes:2048,wholeCrc32:0},{ownedScratchWriteConsent:true,audioQuiescent:true});
    const status=await j.getOwnedScratchUploadStatus('00000000-0000-0000-0000-000000000000');
    const after=await j.getProtocolDiagnostics();
    const passed=value.status==='rejected-before-dispatch'&&value.commandAttempted===false&&value.sessionId===null&&
      status.status==='rejected-before-dispatch'&&status.commandAttempted===false&&before.events.length===after.events.length&&
      before.inboundBytes===after.inboundBytes;
    return {observedAt:new Date().toISOString(),boundary:'built-app/preload/IPC/physical-stock/sole-USB-owner',
      version:info.versionNumber,beginRejectedBeforeDispatch:value.status==='rejected-before-dispatch',statusRejectedBeforeDispatch:status.status==='rejected-before-dispatch',
      noUsbEventsAdded:before.events.length===after.events.length,inboundBytesUnchanged:before.inboundBytes===after.inboundBytes,
      firmwareUploaded:false,storageMutationsRequested:0,passed};
  })()`)
  const folder=resolve('node_modules/.cache/completion630-runtime'); await mkdir(folder,{recursive:true})
  const path=resolve(folder,`owned-scratch-stock-gate-${Date.now()}.json`)
  await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({...result,evidencePath:path},null,2))
  if(!result.passed) process.exitCode=1
} finally { client.close() }
