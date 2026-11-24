/** Protected new native capture only. No provider/transcription/delete calls. */
import { openValidationClient } from './device-validation-client.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const client=await openValidationClient(),folder=resolve('node_modules/.cache/completion630-runtime')
await mkdir(folder,{recursive:true})
const stamp=Date.now(),evidencePath=resolve(folder,`native-wav-upload2-${stamp}.json`)
const playHiDockTone=process.argv.includes('--tone'),automaticRules=process.argv.includes('--auto')
const gainArgument=process.argv.find(arg=>arg.startsWith('--gain-right='))
const gainRight=gainArgument?Number(gainArgument.slice('--gain-right='.length)):null
if(gainRight!==null&&(!Number.isInteger(gainRight)||gainRight<0||gainRight>65536))throw Error('Invalid bounded gain')
const gainLeftArgument=process.argv.find(arg=>arg.startsWith('--gain-left='))
const gainLeft=gainLeftArgument?Number(gainLeftArgument.slice('--gain-left='.length)):null
if(gainLeft!==null&&(!Number.isInteger(gainLeft)||gainLeft<0||gainLeft>65536))throw Error('Invalid bounded left gain')
const evidence={observedAt:new Date().toISOString(),boundary:'physical-installed-upload2/protected-new-native-recording/sole-Jensen-owner',providerRequests:0,existingRecordingStopsRequested:0,deviceDeletesRequested:0}
try{
  const capture=await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen,wait=ms=>new Promise(ok=>setTimeout(ok,ms));
    if(!await j.isConnected()&&!await j.connect())throw Error('Dock unavailable');
    const info=await j.getDeviceInfo();if(info?.versionNumber!==393986)throw Error('Installed custom version required');
    const before=await j.getNativeRecordingStatus();if(before.recording!==null)throw Error('Existing recording active');
    const format=await j.getCustomRecordingFormat(),profile=await j.getCustomRecordingProfile(),rules=await j.getCustomMarkerRules();
    if(!format||!profile||!rules||rules.enabled)throw Error('Known original controls and disabled automatic markers required');
    const result={formatBefore:format,profileBefore:profile,rulesBefore:rules};let owned=null,context=null;
    try{
      result.formatSet=await j.setCustomRecordingFormat('wav');if(result.formatSet?.result!=='success')throw Error('WAV setter not accepted');
      result.formatReadback=await j.getCustomRecordingFormat();if(result.formatReadback?.format!=='wav')throw Error('WAV readback mismatch');
      if(${gainRight!==null}){result.profileSet=await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:profile.gainLeftQ15,gainRightQ15:${gainRight??32768}});result.profileReadback=await j.getCustomRecordingProfile();if(result.profileSet?.result!=='success'||result.profileReadback?.gainRightQ15!==${gainRight??32768})throw Error('Gain setter/readback mismatch')}
      if(${gainLeft!==null}){result.leftProfileSet=await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:${gainLeft??32768},gainRightQ15:${gainRight??'profile.gainRightQ15'}});result.leftProfileReadback=await j.getCustomRecordingProfile();if(result.leftProfileSet?.result!=='success'||result.leftProfileReadback?.gainLeftQ15!==${gainLeft??32768})throw Error('Left gain setter/readback mismatch')}
      if(${automaticRules}){result.rulesSet=await j.setCustomMarkerRules({enabled:true,lane:2,meanMagnitudeThreshold:100});if(result.rulesSet?.result!=='success')throw Error('Automatic rules setter not accepted')}
      result.start=await j.startNativeVerificationRecording({requestId:crypto.randomUUID(),expectedRecording:null});
      if(result.start.status!=='acknowledged'||!result.start.manualOnly||!result.start.recording)throw Error('Protected native start unavailable');
      owned=result.start.recording;
      await wait(3500);result.active=await j.getNativeRecordingStatus();if(result.active.recording!==owned)throw Error('Owned recording changed');
      if(!${automaticRules}){const marker={requestId:crypto.randomUUID(),expectedRecording:owned};result.marker=await j.addNativeMarker(marker);result.duplicate=await j.addNativeMarker(marker)}
      // Native automatic rules have a10s session/marker cooldown. Keep the
      // known stimulus eligible and issue the manual marker afterwards.
      if(${automaticRules})await wait(7000);
      if(${playHiDockTone}){
        const devices=await navigator.mediaDevices.enumerateDevices(),sink=devices.find(d=>d.kind==='audiooutput'&&/hidock/i.test(d.label)&&d.deviceId!=='default'&&d.deviceId!=='communications');
        if(!sink||typeof AudioContext.prototype.setSinkId!=='function')throw Error('Explicit HiDock output unavailable');
        context=new AudioContext({sampleRate:48000});window.__ownedToneContext=context;await context.setSinkId(sink.deviceId);await context.resume();
        const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=1000;gain.gain.value=0.01;oscillator.connect(gain);gain.connect(context.destination);
        oscillator.start();result.stimulus={target:'explicit-HiDock-audiooutput',frequencyHz:1000,digitalGain:0.01,contextSampleRate:context.sampleRate,state:context.state,wallStartMs:Date.now()};
        await wait(6500);oscillator.stop();await context.close();context=null;window.__ownedToneContext=null;
      }else await wait(6500);
      result.finalActive=await j.getNativeRecordingStatus();
      if(${automaticRules}){const marker={requestId:crypto.randomUUID(),expectedRecording:owned};result.marker=await j.addNativeMarker(marker);result.duplicate=await j.addNativeMarker(marker)}
    }catch(error){result.failure=String(error?.message??'capture failed')}
    finally{
      if(context){await context.close().catch(()=>undefined);window.__ownedToneContext=null}
      if(owned){const current=await j.getNativeRecordingStatus();if(current.recording===owned){result.stop=await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:owned});await wait(1800)}else result.stopSkippedBecauseOwnerChanged=true}
      const idle=await j.getNativeRecordingStatus();result.idleAfter=idle.recording===null;
      if(result.idleAfter)result.formatRestore=await j.setCustomRecordingFormat(format.format);
      if(result.idleAfter&&${gainRight!==null}){result.profileRestore=await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:profile.gainLeftQ15,gainRightQ15:profile.gainRightQ15});result.profileRestored=await j.getCustomRecordingProfile()}
      if(result.idleAfter&&${gainLeft!==null}){result.leftProfileRestore=await j.setCustomRecordingProfile({profile:profile.profile,gainLeftQ15:profile.gainLeftQ15,gainRightQ15:profile.gainRightQ15});result.leftProfileRestored=await j.getCustomRecordingProfile()}
      if(result.idleAfter&&${automaticRules})result.rulesRestore=await j.setCustomMarkerRules({enabled:rules.enabled,lane:rules.lane,meanMagnitudeThreshold:rules.meanMagnitudeThreshold});
    }
    result.ownedFilename=owned;
    if(result.failure||!owned||!result.idleAfter)return result;
    const listing=await j.listFilesDetailed(),file=listing.files.find(f=>f.name===owned);
    if(listing.status!=='complete'||!file||file.length<120000||file.length>2097152){result.failure='Completed protected WAV was not listed within safe bounds';return result}
    const data=new Uint8Array(file.length);for(let at=0;at<data.length;at+=1048576){const part=new Uint8Array(await j.readFileRange(owned,at,Math.min(1048576,data.length-at)));data.set(part,at)}
    result.downloadBytes=Array.from(data);result.fileBytes=file.length;result.fileSignature=file.signature;return result;
  })()`,90000)
  const audio= capture.downloadBytes?Buffer.from(capture.downloadBytes):null
  delete capture.downloadBytes
  const filename=capture.ownedFilename;delete capture.ownedFilename
  // Request ownership names and payload remain in the isolated private fixture.
  await writeFile(resolve(folder,`native-wav-upload2-${stamp}.private.json`),JSON.stringify({filename,capture},null,2)+'\n',{flag:'wx'})
  evidence.capture={formatSet:capture.formatSet?.result,formatReadback:capture.formatReadback,protectedStart:capture.start?.status,manualOnly:capture.start?.manualOnly,
    marker:capture.marker?.status,duplicate:capture.duplicate,stop:capture.stop?.status,idleAfter:capture.idleAfter,formatRestore:capture.formatRestore?.result,
    stimulus:capture.stimulus??null,rulesSet:capture.rulesSet?.result??null,rulesRestore:capture.rulesRestore?.result??null,failure:capture.failure??null}
  if(gainRight!==null)evidence.gain={requestedRightQ15:gainRight,profileSet:capture.profileSet?.result,readback:capture.profileReadback,profileRestore:capture.profileRestore?.result,restored:capture.profileRestored}
  if(gainLeft!==null)evidence.leftGain={requestedLeftQ15:gainLeft,profileSet:capture.leftProfileSet?.result,readback:capture.leftProfileReadback,profileRestore:capture.leftProfileRestore?.result,restored:capture.leftProfileRestored}
  if(audio){
    await writeFile(resolve(folder,`native-wav-upload2-${stamp}.private.wav`),audio,{flag:'wx'})
    const magic=audio.subarray(0,4).toString('ascii'),wave=audio.subarray(8,12).toString('ascii')
    evidence.file={bytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex'),magic,wave,
      channels:audio.readUInt16LE(22),sampleRate:audio.readUInt32LE(24),bitsPerSample:audio.readUInt16LE(34),declaredDataBytes:audio.readUInt32LE(40),
      metadataMd5Matches:createHash('md5').update(audio.subarray(0,1024)).digest('hex')===capture.fileSignature}
    if(gainLeft===0){let nonzeroLeft=0,nonzeroRight=0;const end=44+audio.readUInt32LE(40);for(let i=44;i+4<=end;i+=4){if(audio.readInt16LE(i))nonzeroLeft++;if(audio.readInt16LE(i+2))nonzeroRight++}evidence.leftMute={nonzeroLeft,nonzeroRight,passed:nonzeroLeft===0&&nonzeroRight>0}}
    const trailerAt=audio.lastIndexOf(Buffer.from('HiDockVM')),markers=[]
    if(trailerAt>=44&&trailerAt+12<=audio.length){const n=audio.readUInt32LE(trailerAt+8);if(n<=512&&trailerAt+12+n*4===audio.length)for(let i=0;i<n;i++)markers.push(audio.readUInt32LE(trailerAt+12+i*4))}
    evidence.nativeTrailer={present:trailerAt>=0,markerCount:markers.length,timesMs:markers}
  }
  evidence.passed=!evidence.capture.failure&&capture.stop?.status==='acknowledged'&&capture.marker?.status==='acknowledged'&&capture.duplicate?.status==='duplicate'&&capture.idleAfter&&
    evidence.file?.magic==='RIFF'&&evidence.file.wave==='WAVE'&&evidence.file.channels===2&&evidence.file.sampleRate===16000&&evidence.file.bitsPerSample===16&&evidence.file.metadataMd5Matches&&
    (automaticRules?evidence.nativeTrailer?.markerCount>=2&&capture.rulesRestore?.result==='success':evidence.nativeTrailer?.markerCount===1)&&
    (gainRight===null||capture.profileRestore?.result==='success'&&capture.profileRestored?.gainRightQ15===capture.profileBefore.gainRightQ15)&&
    (gainLeft===null||capture.leftProfileRestore?.result==='success'&&capture.leftProfileRestored?.gainLeftQ15===capture.profileBefore.gainLeftQ15)&&
    (gainLeft!==0||evidence.leftMute?.passed===true)
}catch{evidence.failure='Native qualification failed; inspect owned private recording state before another command';evidence.passed=false}
finally{client.close();await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...evidence,evidencePath},null,2))}
if(!evidence.passed)process.exitCode=1
