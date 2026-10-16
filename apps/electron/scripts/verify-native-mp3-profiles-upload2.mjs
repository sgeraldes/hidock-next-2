/** Owned physical captures. Keeps personal recordings intact and restores controls. */
import { openValidationClient } from './device-validation-client.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const client = await openValidationClient(), stamp = Date.now()
const folder = resolve('node_modules/.cache/completion630-runtime')
await mkdir(folder, { recursive: true })
const evidence = { observedAt: new Date().toISOString(), boundary: 'physical-installed-upload2/native-MP3-profile-captures', providerRequests: 0, deletesRequested: 0, profiles: [] }
try {
  for (const profile of [2, 0, 1, 3]) {
    const capture = await client.evaluate(`(async()=>{
      const j=window.electronAPI.jensen,wait=ms=>new Promise(ok=>setTimeout(ok,ms));
      const info=await j.getDeviceInfo(),idle=await j.getNativeRecordingStatus(),original=await j.getCustomRecordingProfile(),format=await j.getCustomRecordingFormat(),rules=await j.getCustomMarkerRules();
      if(info?.versionNumber!==393986||idle.recording!==null||!original||!format||!rules||rules.enabled)throw Error('Known idle custom dock with disabled automatic rules required');
      const result={original,format,rules};let owned=null;
      try{
        result.formatSet=await j.setCustomRecordingFormat('mp3');
        result.profileSet=await j.setCustomRecordingProfile({profile:${profile},gainLeftQ15:32768,gainRightQ15:32768});
        result.profileReadback=await j.getCustomRecordingProfile();
        if(result.formatSet?.result!=='success'||result.profileSet?.result!=='success'||result.profileReadback?.profile!==${profile})throw Error('Profile setter/readback mismatch');
        result.start=await j.startNativeVerificationRecording({requestId:crypto.randomUUID(),expectedRecording:null});
        if(result.start.status!=='acknowledged'||!result.start.manualOnly||!result.start.recording)throw Error('Protected start unavailable');
        owned=result.start.recording;await wait(18000);
        if((await j.getNativeRecordingStatus()).recording!==owned)throw Error('Owned capture changed');
        result.marker=await j.addNativeMarker({requestId:crypto.randomUUID(),expectedRecording:owned});
      }catch(error){result.failure=String(error?.message??'capture failed')}
      finally{
        if(owned&&(await j.getNativeRecordingStatus()).recording===owned){result.stop=await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:owned});await wait(1800)}
        result.idleAfter=(await j.getNativeRecordingStatus()).recording===null;
        if(result.idleAfter){result.profileRestore=await j.setCustomRecordingProfile({profile:original.profile,gainLeftQ15:original.gainLeftQ15,gainRightQ15:original.gainRightQ15});result.formatRestore=await j.setCustomRecordingFormat(format.format);result.restoredProfile=await j.getCustomRecordingProfile();result.restoredFormat=await j.getCustomRecordingFormat()}
      }
      result.filename=owned;
      if(result.failure||!owned||!result.idleAfter)return result;
      const listing=await j.listFilesDetailed(),file=listing.files.find(f=>f.name===owned);
      if(listing.status!=='complete'||!file||file.length<120000||file.length>2097152)throw Error('Owned completed file unavailable within bounds');
      const bytes=new Uint8Array(file.length);for(let at=0;at<bytes.length;at+=1048576)bytes.set(new Uint8Array(await j.readFileRange(owned,at,Math.min(1048576,bytes.length-at))),at);
      result.bytes=Array.from(bytes);result.signature=file.signature;return result;
    })()`, 60000)
    const audio = capture.bytes ? Buffer.from(capture.bytes) : null
    delete capture.bytes
    await writeFile(resolve(folder, `native-mp3-${stamp}-p${profile}.private.json`), JSON.stringify(capture, null, 2)+'\n', { flag: 'wx' })
    const record = { profile, expectedBitrateKbps: [64,96,128,160][profile], failure: capture.failure??null, controls: { profileSet:capture.profileSet?.result, profileReadback:capture.profileReadback, start:capture.start?.status, marker:capture.marker?.status, stop:capture.stop?.status, idle:capture.idleAfter, profileRestore:capture.profileRestore?.result, formatRestore:capture.formatRestore?.result, restoredProfile:capture.restoredProfile, restoredFormat:capture.restoredFormat } }
    if (audio) {
      const path=resolve(folder, `native-mp3-${stamp}-p${profile}.private.hda`)
      await writeFile(path, audio, { flag: 'wx' })
      const decoded=spawnSync(ffmpeg,['-hide_banner','-v','info','-i',path,'-map','0:a:0','-f','null','-'],{encoding:'utf8',maxBuffer:1048576})
      // Only publish the scalar stream description; raw stderr can contain private paths.
      const stream=decoded.stderr?.split(/\r?\n/).find(line=>/Stream #0:0: Audio:/.test(line))?.trim()??null
      const trailerAt=audio.lastIndexOf(Buffer.from('HiDockVM')),markers=[]
      if(trailerAt>=0&&trailerAt+12<=audio.length){const count=audio.readUInt32LE(trailerAt+8);if(count<=512&&trailerAt+12+4*count===audio.length)for(let i=0;i<count;i++)markers.push(audio.readUInt32LE(trailerAt+12+4*i))}
      record.file={bytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex'),metadataMd5Matches:createHash('md5').update(audio.subarray(0,1024)).digest('hex')===capture.signature,decodeExitCode:decoded.status,stream,markersMs:markers}
      record.passed=!record.failure&&record.controls.start==='acknowledged'&&record.controls.marker==='acknowledged'&&record.controls.stop==='acknowledged'&&record.controls.idle&&record.controls.profileRestore==='success'&&record.controls.formatRestore==='success'&&record.file.metadataMd5Matches&&decoded.status===0&&!!stream?.includes('mp3')&&!!stream?.includes(`${record.expectedBitrateKbps} kb/s`)&&markers.length===1
    } else record.passed=false
    evidence.profiles.push(record)
    console.log(JSON.stringify(record,null,2))
    if(!record.passed)break
  }
  evidence.passed=evidence.profiles.length===4&&evidence.profiles.every(p=>p.passed)
} catch(error) { evidence.failure=String(error?.message??'qualification failed');evidence.passed=false }
finally { client.close();await writeFile(resolve(folder,`native-mp3-profiles-${stamp}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'}) }
if(!evidence.passed)process.exitCode=1
