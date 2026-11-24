import {openValidationClient} from './device-validation-client.mjs'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const folder=resolve('node_modules/.cache/completion630-runtime'),phase=process.argv[2]
if(!['stock','custom'].includes(phase))throw Error('Explicit phase required')
const baseline=JSON.parse(await readFile(resolve(folder,'before-forward-restore.private.json'),'utf8'))
const fixture=JSON.parse(await readFile(resolve(folder,'native-wav-upload2-1791814795351.private.json'),'utf8'))
const client=await openValidationClient(),evidence={observedAt:new Date().toISOString(),phase,boundary:'physical-forward-stock/return-custom/actual-SD-readback',providerRequests:0,deviceStorageMutations:0}
try{
const r=await client.evaluate(`(async()=>{const j=window.electronAPI.jensen,info=await j.getDeviceInfo(),status=await j.getNativeRecordingStatus(),list=await j.listFilesDetailed(),profile=await j.getCustomRecordingProfile(),format=await j.getCustomRecordingFormat(),rules=await j.getCustomMarkerRules();if(info?.versionNumber!==${phase==='stock'?393987:393986}||status.recording!==null||list.status!=='complete')throw Error('Exact idle target required');const name=${JSON.stringify(fixture.filename)},f=list.files.find(f=>f.name===name);if(f?.length!==1137952)throw Error('Owned source changed');const bytes=new Uint8Array(f.length);for(let at=0;at<bytes.length;at+=1048576)bytes.set(new Uint8Array(await j.readFileRange(name,at,Math.min(1048576,bytes.length-at))),at);return {versionNumber:info.versionNumber,versionCode:info.versionCode,idle:status.recording===null,list:list.files.map(f=>({name:f.name,length:f.length})),profile,format,rules,bytes:Array.from(bytes)}})()`)
const expected=new Map(baseline.catalogue.map(f=>[f.name,f.length])),actual=new Map(r.list.map(f=>[f.name,f.length]))
evidence.versionNumber=r.versionNumber;evidence.versionCode=r.versionCode;evidence.idle=r.idle
evidence.catalogue={before:expected.size,after:actual.size,allPreviousNamesAndSizesPreserved:[...expected].every(([name,length])=>actual.get(name)===length),allFileContentsHashed:false}
evidence.ownedPhysicalWav={bytes:r.bytes.length,sha256:createHash('sha256').update(Buffer.from(r.bytes)).digest('hex')}
evidence.controls={profile:r.profile,format:r.format,rules:r.rules}
evidence.passed=evidence.catalogue.allPreviousNamesAndSizesPreserved&&evidence.ownedPhysicalWav.sha256==='f2b2392a7e455cfc6800c696c0e93af517f59bc36aba235396bdec8bc781ff96'&&(phase==='stock'?r.profile===null&&r.format===null&&r.rules===null:r.profile?.profile===baseline.profile.profile&&r.profile.gainLeftQ15===baseline.profile.gainLeftQ15&&r.profile.gainRightQ15===baseline.profile.gainRightQ15&&r.format?.format===baseline.format.format&&r.rules?.enabled===baseline.rules.enabled&&r.rules.meanMagnitudeThreshold===baseline.rules.meanMagnitudeThreshold)
}catch(error){evidence.failure=String(error?.message??'preservation failed');evidence.passed=false}
finally{client.close();await writeFile(resolve(folder,`forward-stock-preservation-${phase}-${Date.now()}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence,null,2))}
if(!evidence.passed)process.exitCode=1
