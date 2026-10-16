import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const sourcePath=process.argv[2]
if(!sourcePath?.startsWith('node_modules/.cache/completion630-runtime/owned-scratch-upload-'))throw Error('Owned fixture evidence required')
const source=JSON.parse(await readFile(sourcePath,'utf8'))
const afterAppRestart=process.argv.includes('--restart')
if(!source.passed||!source.status?.sessionId||!source.first1024MetadataMd5Matches)throw Error('Successful owned fixture required')
const client=await openValidationClient()
try{
  const result=await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen,before=await j.getProtocolDiagnostics();
    if(${afterAppRestart}){if(!await j.isConnected()&&!await j.connect())throw Error('Reconnection unavailable')}
    else{await j.disconnect();if(!await j.connect())throw Error('Reconnection unavailable')}
    const info=await j.getDeviceInfo(),status=await j.getOwnedScratchUploadStatus(${JSON.stringify(source.status.sessionId)});
    if(info?.versionNumber!==393986||!status.finished){const d=await j.getProtocolDiagnostics();return {observedAt:new Date().toISOString(),failure:'Owned status could not rebind',version:info?.versionNumber,status,
      connectionEpochChanged:before.connectionSessionId!==d.connectionSessionId,currentCommand:d.currentCommand,queuedCommands:d.queuedCommands,
      activeDownload:d.activeDownload,fileStreamPending:d.fileStreamPending,lastFault:d.lastFault,scratchMutationCommandsRequested:0};}
    const bytes=new Uint8Array(await j.readFileRange(${JSON.stringify(source.newFilename)},0,${source.fixtureBytes}));
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    const after=await j.getProtocolDiagnostics(),audio=await j.getAudioDiagnostics();
    return {observedAt:new Date().toISOString(),version:info.versionNumber,connectionEpochChanged:before.connectionSessionId!==after.connectionSessionId,
      explicitStatusRebound:status.finished,readbackSha256:sha,bytes:bytes.length,connected:await j.isConnected(),audioIdle:audio.session.status==='idle',
      scratchMutationCommandsRequested:0,resetCommandsRequested:0,powerCyclesRequested:0};
  })()`,90000)
  result.afterAppRestart=afterAppRestart
  result.expectedSha256=source.expectedSha256;result.passed=(afterAppRestart||result.connectionEpochChanged)&&result.explicitStatusRebound&&result.readbackSha256===source.expectedSha256&&result.bytes===source.fixtureBytes&&result.connected&&result.audioIdle
  result.boundary='physical-installed-upload2/app-owner/'+(afterAppRestart?'sealed-host-ownership-app-restart':'disconnect-reconnect')+'/same-serial-explicit-owned-STATUS/native-file-readback'
  const path=resolve('node_modules/.cache/completion630-runtime',`owned-scratch-reconnect-${Date.now()}.json`)
  await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,evidencePath:path},null,2));if(!result.passed)process.exitCode=1
}finally{client.close()}
