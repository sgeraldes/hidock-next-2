import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import Database from 'better-sqlite3'
const directory=resolve('node_modules/.cache/completion630-runtime')
const profile=JSON.parse(await readFile(join(directory,'isolated-profile.private.json'),'utf8'))
if(!resolve(profile.dataPath).startsWith(directory+'\\'))throw Error('Only the isolated test library is permitted')
const recordings=join(profile.dataPath,'recordings')
const normal=process.argv.includes('--normal')
const client=await openValidationClient()
const evidence={observedAt:new Date().toISOString(),boundary:'running-app/physical-stock/durable-disk/isolated-SQLite',publicDownloadPath:normal?'downloadToLibrary':'downloadResumableToLibrary',originalLibraryMutated:false,deviceWritesRequested:0}
try {
  evidence.stage='baseline'
  const source=await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;if(!await j.isConnected()&&!await j.connect())throw Error('Connection unavailable');const l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(v=>v.length>2097152&&v.length<4194304).sort((a,b)=>a.length-b.length)[${normal?2:0}];if(!f)throw Error('No bounded completed source');const chunks=[];let bytes=0;const off=j.onDownloadChunk(x=>{if(x.filename===f.name){const v=new Uint8Array(x.data);chunks.push(v);bytes+=v.length}});let ok;try{ok=await j.downloadFile(f.name,f.length)}finally{off()}if(!ok||bytes!==f.length)throw Error('Baseline did not complete');const all=new Uint8Array(bytes);let p=0;for(const c of chunks){all.set(c,p);p+=c.length}window.__resumeVerificationSource={filename:f.name,fileSize:f.length};return {name:f.name,size:f.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all)),v=>v.toString(16).padStart(2,'0')).join('')}})()`)
  // This is our independently backed-up test database. Remove only this test
  // source's prior sync/queue markers so the normal public manual-download path runs.
  evidence.stage='isolated-sync-markers'
  const db=new Database(join(profile.dataPath,'data','hidock.db'),{fileMustExist:true})
  try {const names=[source.name,source.name.replace(/\.hda$/i,'.mp3'),source.name.replace(/\.hda$/i,'.wav')];db.transaction(()=>{for(const name of names){db.prepare('DELETE FROM synced_files WHERE original_filename=?').run(name);db.prepare('DELETE FROM download_queue WHERE filename=?').run(name);db.prepare("UPDATE recordings SET file_path=NULL,on_local=0,location='device-only' WHERE filename=? OR original_filename=?").run(name,name)}})()}finally{db.close()}
  evidence.stage='interrupt'
  const first=await client.evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen,f=window.__resumeVerificationSource;const q=await a.downloadService.queueDownloads([{filename:f.filename,size:f.fileSize}]);if(!q.queued.includes(f.filename))throw Error('Manual queue refused');let requested=false,cancel=null;const off=a.downloadService.onStateUpdate(s=>{const item=s.queue.find(v=>v.filename===f.filename);if(item&&!requested&&item.progress>=Math.floor(1048576/f.fileSize*100)&&item.progress<100){requested=true;cancel=j.cancelDownload()}});let result;try{result=await j.${normal?'downloadToLibrary':'downloadResumableToLibrary'}(f.filename,f.fileSize)}catch{result={success:false,cancelled:true}}finally{off();if(cancel)await cancel}return {requested,result,owner:await j.getProtocolDiagnostics()}})()`)
  evidence.interrupted={cancelRequested:first.requested,success:first.result.success,ownerIdle:first.owner.currentCommand===null&&!first.owner.fileStreamPending}
  evidence.stage='checkpoint'
  const cpNames=(await readdir(recordings)).filter(v=>/^\.hidock-resume-[a-f0-9]{64}\.json$/.test(v))
  if(cpNames.length!==1)throw Error('Exactly one committed resume checkpoint is required')
  const checkpoint=JSON.parse(await readFile(join(recordings,cpNames[0]),'utf8'))
  const partial=join(recordings,cpNames[0].replace(/\.json$/,'.partial'))
  evidence.checkpoint={committed:checkpoint.committed,diskBytes:(await stat(partial)).size,sha256:checkpoint.sha256}
  const prefix=createHash('sha256');for await(const bytes of createReadStream(partial))prefix.update(bytes)
  evidence.checkpoint.diskHashMatches=prefix.digest('hex')===checkpoint.sha256
  evidence.stage='resume'
  const before=await client.evaluate('window.electronAPI.jensen.getProtocolDiagnostics()')
  const result=await client.evaluate(`(async()=>{const f=window.__resumeVerificationSource;return window.electronAPI.jensen.${normal?'downloadToLibrary':'downloadResumableToLibrary'}(f.filename,f.fileSize)})()`)
  if(!result.success||!resolve(result.filePath).startsWith(resolve(recordings)+'\\'))throw Error('Publication failed or escaped the isolated library')
  const hash=createHash('sha256');for await(const bytes of createReadStream(result.filePath))hash.update(bytes)
  const after=await client.evaluate('window.electronAPI.jensen.getProtocolDiagnostics()')
  evidence.published={success:result.success,bytes:(await stat(result.filePath)).size,sha256:hash.digest('hex')}
  evidence.published.equalsBaseline=evidence.published.bytes===source.size&&evidence.published.sha256===source.sha256
  evidence.resumeInboundBytes=after.inboundBytes-before.inboundBytes
  evidence.checkpointRemoved=!(await readdir(recordings)).some(v=>v===cpNames[0]||v===cpNames[0].replace(/\.json$/,'.partial'))
  evidence.stage='sqlite-readback'
  const verifyDb=new Database(join(profile.dataPath,'data','hidock.db'),{readonly:true,fileMustExist:true})
  try {const row=verifyDb.prepare('SELECT file_path,file_size FROM synced_files WHERE original_filename=?').get(source.name);evidence.sqliteReadback=!!row&&row.file_path===result.filePath&&row.file_size===source.size}finally{verifyDb.close()}
  evidence.ownerIdle=after.currentCommand===null&&!after.fileStreamPending
  evidence.passed=evidence.interrupted.cancelRequested&&!evidence.interrupted.success&&evidence.checkpoint.committed===1048576&&evidence.checkpoint.diskHashMatches&&evidence.published.equalsBaseline&&evidence.checkpointRemoved&&evidence.sqliteReadback&&evidence.ownerIdle
} catch {evidence.failure='Interrupted resume/publication qualification failed';process.exitCode=1}
finally {await writeFile(join(directory,`resume-app-${Date.now()}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));client.close()}
if(!evidence.passed)process.exitCode=1
