/** One same-value CMD12 through the sole trusted app owner. No toggle or retry. */
import { openValidationClient } from './device-validation-client.mjs'
import { writeFile } from 'node:fs/promises'
if (!process.argv.includes('--confirm-same-value')) throw Error('Explicit same-value settings test required')
const client = await openValidationClient()
try {
  const observation = await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen;
    if(!await j.isConnected()&&!await j.connect())throw Error('Expected dock unavailable');
    const info=await j.getDeviceInfo(),native=await j.getNativeRecordingStatus(),audio=await j.getAudioDiagnostics();
    if(info?.model!=='hidock-h1e'||!((info.versionNumber===393986&&info.versionCode==='6.3.2')||(info.versionNumber===393988&&info.versionCode==='6.3.4'))||native?.recording!==null||audio?.session?.status!=='idle')throw Error('Expected custom idle owner required');
    const before=await j.getSettings();if(typeof before?.autoRecord!=='boolean'||typeof before?.autoPlay!=='boolean')throw Error('Fresh boolean settings required');
    const diagnosticsBefore=await j.getProtocolDiagnostics(),started=Date.now();
    const ack=await j.setAutoRecord(before.autoRecord);
    const elapsedMs=Date.now()-started,after=await j.getSettings(),nativeAfter=await j.getNativeRecordingStatus(),diagnostics=await j.getProtocolDiagnostics();
    const outs=diagnostics.events.filter(e=>e.kind==='out'&&e.commandId===12&&e.atMs>=started&&e.connectionSessionId===diagnosticsBefore.connectionSessionId);
    const same=JSON.stringify(before)===JSON.stringify(after);
    return {observedAt:new Date().toISOString(),boundary:'actual-running-app/trusted-preload/sole-USB-owner/current-custom/native-CMD12',versionNumber:info.versionNumber,settingsBefore:before,settingsAfter:after,sameValueRequested:true,acknowledgement:ack,elapsedMs,nativeIdleBefore:true,nativeIdleAfter:nativeAfter?.recording===null,requestCount:outs.length,payloadBytes:outs.map(e=>e.payloadBytes),settingsUnchanged:same,resetOrStorageCommands:0,passed:ack?.result==='success'&&same&&nativeAfter?.recording===null&&outs.length===1&&outs[0].payloadBytes===8};
  })()`, 45000)
  const path = `../../research/rea/completion630-lab/runtime/guarded-settings-same-value-${Date.now()}.json`
  await writeFile(path, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ ...observation, evidencePath: path }, null, 2))
  if (!observation.passed) process.exitCode = 1
} finally { client.close() }
