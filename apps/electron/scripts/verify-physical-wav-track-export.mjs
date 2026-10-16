/** Publish one already-owned physical WAV into the isolated library and export its lanes. */
import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join, sep } from 'node:path'
import Database from 'better-sqlite3'
const folder=resolve('node_modules/.cache/completion630-runtime')
const input=resolve(process.argv[2]??'')
if(!input.startsWith(folder+sep)||!/^native-wav-upload2-\d+\.private\.wav$/.test(input.slice(folder.length+1)))throw Error('Owned physical fixture required')
const profile=JSON.parse(await readFile(join(folder,'isolated-profile.private.json'),'utf8'))
if(!resolve(profile.dataPath).startsWith(folder+sep))throw Error('Isolated library required')
const audio=await readFile(input),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
if(audio.subarray(0,4).toString()!=='RIFF'||audio.readUInt16LE(22)!==2||audio.readUInt16LE(34)!==16)throw Error('Paired16-bit WAV required')
const frames=audio.readUInt32LE(40)/4,rate=audio.readUInt32LE(24),id=randomUUID(),filename=`owned-physical-wav-${id}.wav`,path=join(profile.dataPath,'recordings',filename)
if(!Number.isInteger(frames)||44+frames*4>audio.length)throw Error('Invalid bounded PCM extent')
await copyFile(input,path,1)
const db=new Database(join(profile.dataPath,'data','hidock.db'),{fileMustExist:true})
try{db.prepare("INSERT INTO recordings(id,filename,file_path,file_size,duration_seconds,date_recorded,location,on_local,on_device,source,is_imported,transcription_status) VALUES(?,?,?,?,?,?,'local',1,0,'device',1,'none')").run(id,filename,path,audio.length,frames/rate,new Date().toISOString())}finally{db.close()}
const client=await openValidationClient(),evidence={observedAt:new Date().toISOString(),boundary:'physical-dock-WAV/running-app-IPC/isolated-SQLite/exported-files',sourceSha256:hash(audio),providerRequests:0,deviceMutations:0,originalLibraryMutated:false,fixturePublication:'owned physical bytes copied into isolated library',channels:[]}
try{
 const result=await client.evaluate(`(async()=>{const a=window.electronAPI,subject={kind:'recording',id:${JSON.stringify(id)}},native=await a.deviceRecordingMarkers.importNative(subject),tracks=await a.deviceAudio.exportTracks(subject.id);return {native,tracks}})()`)
 evidence.markerImport={status:result.native.status,timesMs:result.native.markers.map(m=>m.atMs)}
 evidence.export={frames:result.tracks.frames,sampleRate:result.tracks.sampleRate,physicalSourceMapping:result.tracks.physicalSourceMapping}
 for(const track of result.tracks.tracks){
  if(!resolve(track.path).startsWith(resolve(join(profile.profile,'device-audio-exports'))+sep))throw Error('Export escaped isolated profile')
  const mono=await readFile(track.path),expected=Buffer.alloc(frames*2)
  for(let frame=0;frame<frames;frame++)audio.copy(expected,frame*2,44+frame*4+track.channelIndex*2,46+frame*4+track.channelIndex*2)
  evidence.channels.push({channelIndex:track.channelIndex,bytes:mono.length,pcmSha256:hash(expected),sampleExact:mono.readUInt16LE(22)===1&&mono.readUInt32LE(24)===rate&&mono.subarray(44).equals(expected)})
 }
 evidence.originalUnchanged=hash(await readFile(path))===hash(audio)
 evidence.passed=evidence.originalUnchanged&&evidence.export.frames===frames&&evidence.channels.length===2&&evidence.channels.every(c=>c.sampleExact)&&result.native.status==='imported'
}catch(error){evidence.failure=String(error?.message??'physical track export failed');evidence.passed=false}
finally{client.close();await writeFile('../../research/rea/completion630-lab/runtime/upload2-physical-wav-track-export.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence,null,2))}
if(!evidence.passed)process.exitCode=1
