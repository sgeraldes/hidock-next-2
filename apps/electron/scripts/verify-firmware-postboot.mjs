import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const baseline=JSON.parse(await readFile('node_modules/.cache/completion630-runtime/stock-before-upload2.private.json','utf8'))
const client=await openValidationClient()
try {
  const observed=await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen,info=await j.getDeviceInfo();
    if(info?.model!=='hidock-h1e'||info.versionNumber!==393986||info.versionCode!=='6.3.2')throw Error('Exact custom version unavailable');
    const help=await j.getFirmwareConsoleStatus('help'),version=await j.getFirmwareConsoleStatus('version'),first=await j.getFirmwareConsoleStatus('uptime');
    await new Promise(ok=>setTimeout(ok,250));
    const second=await j.getFirmwareConsoleStatus('uptime'),profile=await j.getCustomRecordingProfile(),format=await j.getCustomRecordingFormat(),rules=await j.getCustomMarkerRules();
    const listing=await j.listFilesDetailed(),preflight=await j.getFirmwareUpdatePreflight(),audio=await j.getAudioDiagnostics();
    return {observedAt:new Date().toISOString(),versionNumber:info.versionNumber,versionCode:info.versionCode,console:{help,version,first,second},profile,format,rules,
      listing:{status:listing.status,expectedCount:listing.expectedCount,parsedCount:listing.parsedCount,files:listing.files.map(f=>({name:f.name,length:f.length}))},preflight,audioIdle:audio.session.status==='idle',connected:await j.isConnected()};
  })()`)
  const before=new Map(baseline.catalog.map(f=>[f.name,f.length])),after=new Map(observed.listing.files.map(f=>[f.name,f.length]))
  const catalogueMatches=before.size===after.size&&[...before].every(([name,length])=>after.get(name)===length)
  const c=observed.console,uptimeDelta=c.first&&c.second?(c.second.uptimeMs32-c.first.uptimeMs32)>>>0:null
  const result={observedAt:observed.observedAt,boundary:'physical-installed-upload2/built-app/sole-USB-owner',versionNumber:observed.versionNumber,versionCode:observed.versionCode,
    console:{...c,uptimeDeltaMs:uptimeDelta},profile:observed.profile,format:observed.format,rules:observed.rules,
    catalogue:{before:before.size,after:after.size,status:observed.listing.status,namesAndSizesEqual:catalogueMatches,allFileBytesIndependentlyChecked:false},
    preflight:observed.preflight,audioIdle:observed.audioIdle,connected:observed.connected,storageMutationsRequested:0,
    passed:!!c.help&&!!c.version&&uptimeDelta>=250&&uptimeDelta<10000&&!!observed.profile&&!!observed.format&&!!observed.rules&&catalogueMatches&&observed.audioIdle&&observed.connected&&!!observed.preflight&&!observed.preflight.activeRecording}
  const path=resolve('node_modules/.cache/completion630-runtime',`firmware-postboot-${Date.now()}.json`)
  await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,evidencePath:path},null,2))
  if(!result.passed)process.exitCode=1
}finally{client.close()}
