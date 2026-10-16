/** Controlled synthetic speech fixture; sole app owner, no personal files or providers. */
import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const folder=resolve('node_modules/.cache/completion630-runtime'),stamp=Date.now()
const source=await readFile(resolve(folder,'controlled-device-voice.private.wav'))
if(source.length<1000||source.length>2097152)throw Error('Bounded synthetic source required')
const c=await openValidationClient()
try {
  const result=await c.evaluate(`(async()=>{
    const j=window.electronAPI.jensen,wait=ms=>new Promise(ok=>setTimeout(ok,ms));
    const info=await j.getDeviceInfo(),before=await j.getNativeRecordingStatus(),profile=await j.getCustomRecordingProfile(),format=await j.getCustomRecordingFormat(),rules=await j.getCustomMarkerRules();
    if(info?.versionNumber!==393986||before.recording!==null||(await j.getAudioDiagnostics()).session.status!=='idle'||!profile||!format||!rules||rules.enabled)throw Error('Idle known current custom controls required');
    const result={reportedFirmware:info.versionNumber,originalProfile:profile,originalFormat:format,originalRules:rules};let owned=null,ctx=null;
    try {
      if((await j.setCustomRecordingFormat('wav'))?.result!=='success')throw Error('WAV not accepted');
      if((await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:32768,gainRightQ15:32768}))?.result!=='success')throw Error('Unity gains not accepted');
      const start=await j.startNativeVerificationRecording({requestId:crypto.randomUUID(),expectedRecording:null});
      if(start.status!=='acknowledged'||!start.manualOnly||!start.recording)throw Error('Protected start unavailable');owned=start.recording;result.start=start.status;
      const sinks=await navigator.mediaDevices.enumerateDevices(),sink=sinks.find(d=>d.kind==='audiooutput'&&/hidock/i.test(d.label)&&d.deviceId!=='default'&&d.deviceId!=='communications');if(!sink)throw Error('Explicit dock output unavailable');
      ctx=new AudioContext({sampleRate:48000});await ctx.setSinkId(sink.deviceId);await ctx.resume();
      const raw=Uint8Array.from(atob(${JSON.stringify(source.toString('base64'))}),ch=>ch.charCodeAt(0));const audio=await ctx.decodeAudioData(raw.buffer);if(audio.duration<12||audio.duration>45)throw Error('Speech duration outside bounded fixture');
      await wait(2000);const play=ctx.createBufferSource(),gain=ctx.createGain();play.buffer=audio;gain.gain.value=0.2;play.connect(gain);gain.connect(ctx.destination);play.start();await new Promise(ok=>{play.onended=ok});await ctx.close();ctx=null;
      result.stimulus={kind:'Windows-offline-synthetic-English-speech',sink:'explicit-HiDock-audiooutput',digitalGain:0.2,durationSeconds:audio.duration};
      const state=await j.getNativeRecordingStatus();if(state.recording!==owned)throw Error('Owned recording changed');result.marker=(await j.addNativeMarker({requestId:crypto.randomUUID(),expectedRecording:owned})).status;await wait(1000);
    }catch(error){result.failure=String(error.message??error)}
    finally {
      if(ctx)await ctx.close().catch(()=>{});
      if(owned){const s=await j.getNativeRecordingStatus();if(s.recording===owned){result.stop=(await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:owned})).status;await wait(1800)}}
      result.idleAfter=(await j.getNativeRecordingStatus()).recording===null;
      if(result.idleAfter){await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:profile.gainLeftQ15,gainRightQ15:profile.gainRightQ15});await j.setCustomRecordingFormat(format.format);const p=await j.getCustomRecordingProfile(),f=await j.getCustomRecordingFormat();result.restored=p?.profile===profile.profile&&p.gainLeftQ15===profile.gainLeftQ15&&p.gainRightQ15===profile.gainRightQ15&&f?.format===format.format}
    }
    result.owned=owned;if(result.failure||!result.idleAfter||!owned)return result;
    const listing=await j.listFilesDetailed(),file=listing.files?.find(f=>f.name===owned);if(listing.status!=='complete'||!file||file.length<100000||file.length>4194304)throw Error('Owned voice file not available within bounds');
    const bytes=new Uint8Array(file.length);for(let i=0;i<bytes.length;i+=1048576)bytes.set(new Uint8Array(await j.readFileRange(owned,i,Math.min(1048576,bytes.length-i))),i);
    result.bytes=Array.from(bytes);result.catalogSignatureMd5=file.signature;return result;
  })()`,120000)
  const data=result.bytes?Buffer.from(result.bytes):null;delete result.bytes
  const path=resolve(folder,`controlled-native-voice-${stamp}.private.wav`)
  if(data)await writeFile(path,data,{flag:'wx'})
  const evidence={at:new Date().toISOString(),boundary:'physical-native-WAV/controlled-synthetic-speech/sole-USB-owner',providerRequests:0,firmwareWrites:0,personalRecordingsRead:0,...result,path:data?path:null,sha256:data?createHash('sha256').update(data).digest('hex'):null,totalBytes:data?.length??0,channels:data?.readUInt16LE(22),sampleRate:data?.readUInt32LE(24),metadataMd5Matches:data?createHash('md5').update(data.subarray(0,1024)).digest('hex')===result.catalogSignatureMd5:false}
  evidence.passed=!!data&&!result.failure&&result.restored&&result.idleAfter&&result.stop==='acknowledged'&&evidence.channels===2&&evidence.sampleRate===16000&&evidence.metadataMd5Matches
  const report=resolve(folder,`controlled-native-voice-${stamp}.private.json`);await writeFile(report,JSON.stringify(evidence,null,2),{flag:'wx'})
  console.log(JSON.stringify({passed:evidence.passed,report,path:evidence.path,totalBytes:evidence.totalBytes,sha256:evidence.sha256,channels:evidence.channels,sampleRate:evidence.sampleRate,restored:result.restored,failure:result.failure??null},null,2))
  if(!evidence.passed)process.exitCode=1
}finally{c.close()}
