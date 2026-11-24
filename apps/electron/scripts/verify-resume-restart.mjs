import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
const phase=process.argv[2]
if(!['interrupt','resume'].includes(phase))throw Error('Use interrupt or resume')
const directory=resolve('node_modules/.cache/completion630-runtime'),profile=JSON.parse(await readFile(join(directory,'isolated-profile.private.json'),'utf8'))
if(!resolve(profile.dataPath).startsWith(directory+'\\'))throw Error('Isolated library required')
const recordings=join(profile.dataPath,'recordings'),planPath=join(directory,'resume-restart-plan.private.json')
const client=await openValidationClient()
const evidence={observedAt:new Date().toISOString(),phase,boundary:'real-app/physical-stock/persisted-disk/isolated-library',deviceWritesRequested:0,originalLibraryMutated:false}
try {
  if(phase==='interrupt') {
    const source=await client.evaluate(`(async()=>{const j=window.electronAPI.jensen,l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(v=>v.length>2097152&&v.length<4194304).sort((a,b)=>a.length-b.length)[1];if(!f)throw Error('No second source');const chunks=[];let bytes=0;const off=j.onDownloadChunk(x=>{if(x.filename===f.name){const v=new Uint8Array(x.data);chunks.push(v);bytes+=v.length}});let ok;try{ok=await j.downloadFile(f.name,f.length)}finally{off()}if(!ok||bytes!==f.length)throw Error('Incomplete baseline');const all=new Uint8Array(bytes);let p=0;for(const c of chunks){all.set(c,p);p+=c.length}window.__restartSource={filename:f.name,fileSize:f.length};return {filename:f.name,size:f.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all)),v=>v.toString(16).padStart(2,'0')).join('')}})()`)
    const db=new Database(join(profile.dataPath,'data','hidock.db'),{fileMustExist:true})
    try {db.transaction(()=>{for(const name of [source.filename,source.filename.replace(/\.hda$/i,'.wav'),source.filename.replace(/\.hda$/i,'.mp3')]){db.prepare('DELETE FROM synced_files WHERE original_filename=?').run(name);db.prepare('DELETE FROM download_queue WHERE filename=?').run(name);db.prepare("UPDATE recordings SET file_path=NULL,on_local=0,location='device-only' WHERE filename=? OR original_filename=?").run(name,name)}})()}finally{db.close()}
    const result=await client.evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen,f=window.__restartSource,q=await a.downloadService.queueDownloads([{filename:f.filename,size:f.fileSize}]);if(!q.queued.includes(f.filename))throw Error('Queue refused');let cancelled=false,pending;const off=a.downloadService.onStateUpdate(s=>{const v=s.queue.find(x=>x.filename===f.filename);if(v&&!cancelled&&v.progress>=Math.floor(1048576/f.fileSize*100)&&v.progress<100){cancelled=true;pending=j.cancelDownload()}});let value;try{value=await j.downloadResumableToLibrary(f.filename,f.fileSize)}catch{value={success:false}}finally{off();if(pending)await pending}return {cancelled,success:value.success,epoch:(await j.getProtocolDiagnostics()).connectionSessionId}})()`)
    const cp=(await readdir(recordings)).find(v=>/^\.hidock-resume-[a-f0-9]{64}\.json$/.test(v))
    if(!cp)throw Error('Checkpoint absent')
    const metadata=JSON.parse(await readFile(join(recordings,cp),'utf8'))
    await writeFile(planPath,JSON.stringify({source,cp,epoch:result.epoch,profile:profile.dataPath},null,2),{mode:0o600})
    evidence.interrupted={...result,committed:metadata.committed,diskBytes:(await stat(join(recordings,cp.replace(/\.json$/,'.partial')))).size}
    evidence.passed=result.cancelled&&!result.success&&metadata.committed===1048576
  } else {
    const plan=JSON.parse(await readFile(planPath,'utf8'))
    if(plan.profile!==profile.dataPath)throw Error('Wrong isolated profile')
    const name=JSON.stringify(plan.source.filename),size=plan.source.size
    const value=await client.evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen;if(!await j.isConnected())if(!await j.connect())throw Error('Connect failed');const q=await a.downloadService.queueDownloads([{filename:${name},size:${size}}]);if(!q.queued.includes(${name}))return {refused:true,skips:q.skipped.map(x=>x.skip)};const before=await j.getProtocolDiagnostics(),result=await j.downloadResumableToLibrary(${name},${size}),after=await j.getProtocolDiagnostics();return {result,inbound:after.inboundBytes-before.inboundBytes,idle:after.currentCommand===null&&!after.fileStreamPending}})()`)
    if(!value.result?.success||!resolve(value.result.filePath).startsWith(resolve(recordings)+'\\'))throw Error('Resume publication failed')
    const digest=createHash('sha256');for await(const bytes of createReadStream(value.result.filePath))digest.update(bytes)
    evidence.published={bytes:(await stat(value.result.filePath)).size,sha256:digest.digest('hex'),ownerIdle:value.idle,actualResumeInboundBytes:value.inbound}
    evidence.published.equalsBaseline=evidence.published.bytes===plan.source.size&&evidence.published.sha256===plan.source.sha256
    evidence.checkpointRemoved=!(await readdir(recordings)).includes(plan.cp)
    evidence.passed=evidence.published.equalsBaseline&&value.idle&&evidence.checkpointRemoved
  }
} catch {evidence.failure='Restart qualification failed';process.exitCode=1}
finally {await writeFile(join(directory,`resume-restart-${phase}-${Date.now()}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));client.close()}
if(!evidence.passed)process.exitCode=1
