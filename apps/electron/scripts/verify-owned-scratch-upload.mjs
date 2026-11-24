/** One new owned synthetic WAV, no existing names/recordings or delete command. */
import { openValidationClient } from './device-validation-client.mjs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const frameCount=process.argv.includes('--small')?128:512
const bytes=Buffer.alloc(44+frameCount*4)
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22)
bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(64000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40)
for(let i=0;i<frameCount;i++){bytes.writeInt16LE((i%31-15)*100,44+i*4);bytes.writeInt16LE((i%19-9)*170,46+i*4)}
let crc=0xffffffff;for(const b of bytes){crc^=b;for(let bit=0;bit<8;bit++)crc=crc>>>1^((crc&1)?0xedb88320:0)}crc=(crc^0xffffffff)>>>0
const client=await openValidationClient(),path=resolve('node_modules/.cache/completion630-runtime',`owned-scratch-upload-${Date.now()}.json`)
try {
  const result=await client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen,info=await j.getDeviceInfo();
    if(info?.model!=='hidock-h1e'||info.versionNumber!==393986||info.versionCode!=='6.3.2')throw Error('Exact installed upload2 required');
    const initial=await j.listFilesDetailed();if(initial.status!=='complete')throw Error('Complete baseline required');
    const source=Uint8Array.from(${JSON.stringify([...bytes])}),assurance={ownedScratchWriteConsent:true,audioQuiescent:true},events=[];
    const begin=await j.beginOwnedScratchUpload({totalBytes:source.length,wholeCrc32:${crc}},assurance);events.push(begin);
    window.__ownedScratchVerification={sessionId:begin.sessionId,filename:begin.filename,totalBytes:source.length};
    if(begin.status!=='reply'||begin.reply?.acknowledgement!=='accepted'||!begin.sessionId) return {events,failure:'begin-not-accepted'};
    for(let offset=0;offset<source.length;offset+=512){
      const step=await j.appendOwnedScratchUpload(begin.sessionId,{offset,data:source.slice(offset,Math.min(offset+512,source.length))},assurance);events.push(step);
      if(step.status!=='reply'||step.reply?.acknowledgement!=='accepted'||step.reply.progressBytes!==Math.min(offset+512,source.length))return {events,failure:'append-not-confirmed'};
    }
    let finished=false;
    for(let n=0;n<8;n++){
      const step=await j.commitOwnedScratchUpload(begin.sessionId,assurance);events.push(step);
      if(step.status!=='reply'||step.reply?.acknowledgement!=='accepted')return {events,failure:'commit-not-confirmed'};
      if(step.finished){finished=true;break}
      if(![2,3,5].includes(step.reply.stateCode))return {events,failure:'unexpected-commit-state'};
    }
    if(!finished)return {events,failure:'bounded-commit-not-finished'};
    const status=await j.getOwnedScratchUploadStatus(begin.sessionId),listing=await j.listFilesDetailed(),entry=listing.files.find(f=>f.name===begin.filename);
    if(listing.status!=='complete'||!entry)return {events,status,failure:'final-listing-not-confirmed',listingStatus:listing.status,listingReason:listing.reason};
    const actual=new Uint8Array(await j.readFileRange(begin.filename,0,source.length));
    const equal=actual.length===source.length&&actual.every((v,i)=>v===source[i]);
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',actual)),v=>v.toString(16).padStart(2,'0')).join('');
    return {observedAt:new Date().toISOString(),version:info.versionNumber,events,status,fixtureBytes:source.length,fixtureWholeCrc32:${crc},
      countBefore:initial.files.length,countAfter:listing.files.length,entryBytes:entry.length,entrySignature:entry.signature,exactReadbackEqual:equal,readbackSha256:sha,
      oldNamesAndSizesPreserved:initial.files.every(f=>listing.files.some(g=>g.name===f.name&&g.length===f.length)),newFilename:begin.filename,
      originalNamesAccepted:false,largeFilesVerified:false,existingFileOverwritesRequested:0,deleteCommandsRequested:0,
      passed:finished&&status.finished&&equal&&entry.length===source.length&&listing.files.length===initial.files.length+1};
  })()`,120000)
  result.expectedSha256=createHash('sha256').update(bytes).digest('hex');result.expectedFirst1024Md5=createHash('md5').update(bytes.subarray(0,1024)).digest('hex')
  result.first1024MetadataMd5Matches=result.entrySignature===result.expectedFirst1024Md5
  result.boundary='physical-installed-upload2/built-app/sole-USB-owner/native-SD/new-owned-file'
  await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,evidencePath:path},null,2))
  if(!result.passed||result.readbackSha256!==result.expectedSha256||!result.first1024MetadataMd5Matches)process.exitCode=1
}finally{client.close()}
