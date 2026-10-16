import { openValidationClient } from './device-validation-client.mjs'
import { readdir, stat, open, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const client=await openValidationClient()
const directory=resolve('node_modules/.cache/completion630-runtime')
await mkdir(directory,{recursive:true})
const evidence={observedAt:new Date().toISOString(),boundary:'app-IPC/Windows-drive/physical-stock',deviceMutationsRequested:0}
let mounted=false
try {
  const source=await client.evaluate(`(async()=>{const j=window.electronAPI.jensen,l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(v=>v.length>8192&&v.length<4194304).sort((a,b)=>a.length-b.length)[0];if(!f)throw Error('No bounded source');const chunks=[];let bytes=0;const off=j.onDownloadChunk(x=>{if(x.filename===f.name){const v=new Uint8Array(x.data);chunks.push(v);bytes+=v.length}});let ok;try{ok=await j.downloadFile(f.name,f.length)}finally{off()}if(!ok||bytes!==f.length)throw Error('Baseline did not complete');const all=new Uint8Array(bytes);let p=0;for(const c of chunks){all.set(c,p);p+=c.length}return {name:f.name,size:f.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all)),v=>v.toString(16).padStart(2,'0')).join('')}})()`)
  const status=await client.evaluate('window.electronAPI.jensen.mountDeviceDrive()')
  mounted=status.mounted
  if(!mounted||!/^\w:$/.test(status.drive))throw Error('Drive was not mounted')
  evidence.manager=status
  const names=await readdir(`${status.drive}\\`)
  evidence.entries=names.length
  const path=`${status.drive}\\${source.name}`,info=await stat(path)
  const file=await open(path,'r')
  try {const buffer=Buffer.alloc(52);const read=await file.read(buffer,0,52,info.size-52);evidence.seekBytes=read.bytesRead}finally{await file.close()}
  const copy=resolve(directory,'drive-copy-owned-test.bin')
  await copyFile(path,copy)
  const hash=createHash('sha256');for await(const chunk of createReadStream(copy))hash.update(chunk)
  evidence.copy={bytes:(await stat(copy)).size,sha256:hash.digest('hex'),equalsDeviceBaseline:false}
  evidence.copy.equalsDeviceBaseline=evidence.copy.bytes===source.size&&evidence.copy.sha256===source.sha256
  let written
  try {written=await open(`${status.drive}\\__owned_write_denial_test__`,'wx');await written.writeFile('owned test');await written.sync();evidence.nativeWriteDenied=false}
  catch {evidence.nativeWriteDenied=true}
  finally {await written?.close().catch(()=>undefined)}
  evidence.deviceFileCountAfter=(await client.evaluate('window.electronAPI.jensen.listFilesDetailed()')).parsedCount
} catch {evidence.failure='Drive manager or native filesystem verification failed';process.exitCode=1}
finally {
  if(mounted){try{evidence.after=await client.evaluate('window.electronAPI.jensen.unmountDeviceDrive()')}catch{evidence.unmountFailed=true;process.exitCode=1}}
  await writeFile(resolve(directory,`drive-app-${Date.now()}.json`),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2));client.close()
}
if(!evidence.copy?.equalsDeviceBaseline||!evidence.nativeWriteDenied||evidence.after?.mounted!==false)process.exitCode=1
