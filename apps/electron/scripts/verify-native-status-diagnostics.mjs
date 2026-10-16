/** Root-owned status observation. No command retry, deletion or firmware write. */
import { openValidationClient } from './device-validation-client.mjs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const c=await openValidationClient(),stamp=Date.now()
const result=await c.evaluate(`(async()=>{
  const j=window.electronAPI.jensen,wait=ms=>new Promise(ok=>setTimeout(ok,ms)),rows=[];
  if(!await j.isConnected()&&!await j.connect())throw Error('Device unavailable');
  const info=await j.getDeviceInfo();if(info?.versionNumber!==393986)throw Error('Installed custom393986 required');
  if((await j.getAudioDiagnostics()).session.status!=='idle'||(await j.getNativeRecordingStatus()).recording!==null)throw Error('Idle required');
  const format=await j.getCustomRecordingFormat(),profile=await j.getCustomRecordingProfile(),rules=await j.getCustomMarkerRules();
  if(!format||!profile||!rules||rules.enabled)throw Error('Known original config required');
  const e={version:info.versionNumber,rows,formatBefore:format,profileBefore:profile,rulesBefore:rules};let owned=null;
  async function observe(phase,index){const before=await j.getProtocolDiagnostics(),at=Date.now();let status=null,error=null;
    try{const s=await j.getNativeRecordingStatus();status={active:s.recording!==null,duration:s.duration,sampleCount:s.samples.length,type:s.type};if(phase==='active'&&s.recording!==owned)error='owned-recording-changed'}
    catch(cause){error=String(cause.message??cause).includes('idle status')?'idle-not-corroborated':'native-status-unknown'}
    const after=await j.getProtocolDiagnostics();rows.push({phase,index,elapsedMs:Date.now()-at,status,error,before,after});return error;
  }
  try{
    for(let i=0;i<8;i++){await observe('idle',i);await wait(150)}
    if((await j.setCustomRecordingFormat('wav'))?.result!=='success')throw Error('WAV setter not accepted');
    const start=await j.startNativeVerificationRecording({requestId:crypto.randomUUID(),expectedRecording:null});
    if(start.status!=='acknowledged'||!start.manualOnly||!start.recording)throw Error('Protected new start required');owned=start.recording;e.start=start.status;
    for(let i=0;i<36;i++){const error=await observe('active',i);if(error==='owned-recording-changed')throw Error(error);await wait(500)}
  }catch(cause){e.failure=String(cause.message??cause)}
  finally{
    if(owned){let current=null;for(let i=0;i<4&&!current;i++){try{current=await j.getNativeRecordingStatus()}catch{await wait(200)}}
      if(current?.recording===owned){e.stop=(await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:owned})).status;await wait(1800)}else e.stopSkipped='owned state unavailable or changed';}
    let idle=null;for(let i=0;i<4&&idle===null;i++){try{idle=(await j.getNativeRecordingStatus()).recording===null}catch{await wait(200)}}
    e.idleAfter=idle;
    if(idle){e.formatRestore=(await j.setCustomRecordingFormat(format.format))?.result;e.formatRestored=await j.getCustomRecordingFormat();}
  }
  e.passed=!e.failure&&e.idleAfter===true&&e.stop==='acknowledged'&&e.formatRestored?.format===format.format;e.unknownReads=rows.filter(r=>r.error).length;return e;
})()`,180000).finally(()=>c.close())
const evidence={at:new Date().toISOString(),boundary:'physical-installed393986/idle+owned-native-WAV/read-only-status-with-command-traces',firmwareWrites:0,providerRequests:0,existingRecordingsStopped:0,deviceDeletesRequested:0,...result}
const path=resolve('node_modules/.cache/completion630-runtime',`native-status-diagnostics-${stamp}.json`)
await writeFile(path,JSON.stringify(evidence,null,2),{flag:'wx'})
console.log(JSON.stringify({passed:evidence.passed,reads:evidence.rows.length,unknownReads:evidence.unknownReads,idleAfter:evidence.idleAfter,formatRestore:evidence.formatRestore,failure:evidence.failure??null,evidencePath:path},null,2))
if(!evidence.passed)process.exitCode=1
