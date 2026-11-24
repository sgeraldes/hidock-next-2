import { openValidationClient } from './device-validation-client.mjs'
import { writeFile } from 'node:fs/promises'
const client = await openValidationClient()
try {
  const result = await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen;
    if(!await j.isConnected()&&!await j.connect())throw Error('Dock connection unavailable');
    const info=await j.getDeviceInfo(),listing=await j.listFilesDetailed(),preflight=await j.getFirmwareUpdatePreflight(),audio=await j.getAudioDiagnostics();
    if(info?.versionNumber!==393984||listing.status!=='complete'||!preflight||preflight.activeRecording||audio.session.status!=='idle'){
      const d=await j.getProtocolDiagnostics();
      return {failure:'Stock idle baseline unavailable',version:info?.versionNumber??null,listingStatus:listing.status,listingReason:listing.reason,
        expectedCount:listing.expectedCount,parsedCount:listing.parsedCount,preflightAvailable:!!preflight,activeRecording:preflight?.activeRecording??null,audioStatus:audio.session.status,
        protocol:{connected:d.connected,current:d.currentCommand,poisoned:d.poisoned,lastFault:d.lastFault,lastPageFault:d.lastPageFault,inboundBytes:d.inboundBytes,
          events:d.events.map(e=>({kind:e.kind,commandId:e.commandId,sequence:e.sequence,bodyBytes:e.bodyBytes,correlated:e.correlated,code:e.code}))}};
    }
    return {observedAt:new Date().toISOString(),version:info.versionNumber,catalog:listing.files.map(f=>({name:f.name,length:f.length,signature:f.signature})),preflight,audioIdle:true};
  })()`)
  if(result.failure){console.log(JSON.stringify(result,null,2));process.exitCode=1}
  else {
    await writeFile('node_modules/.cache/completion630-runtime/stock-before-upload2.private.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'})
    console.log(JSON.stringify({observedAt:result.observedAt,version:result.version,catalogCount:result.catalog.length,preflight:result.preflight,audioIdle:result.audioIdle,privateBaselineSaved:true}))
  }
} finally { client.close() }
