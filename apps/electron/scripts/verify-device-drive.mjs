/** Actual Windows WebClient mount/copy boundary. Token and remote names stay private. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat, open, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const run = promisify(execFile)
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
if (!target || process.platform !== 'win32') throw Error('Windows development application is required')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }) })
const result = await new Promise((ok, fail) => {
  socket.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.id===1) m.result?.exceptionDetails ? fail(Error('Filesystem API failed')) : ok(m.result.result.value) }, { once: true })
  socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'window.electronAPI.jensen.getFileSystemStatus()',awaitPromise:true,returnByValue:true}}))
})
socket.close()
if (!result.running || !result.mountUrl) throw Error('Start the read-only filesystem first')
const used = await run('powershell.exe', ['-NoProfile','-Command', 'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name'])
const letters = new Set(used.stdout.split(/\s+/).filter(Boolean).map(x=>x.toUpperCase()))
const drive = ['R','H','I','J','K','L','P','Q','S','T','U','V','W','X'].find(x=>!letters.has(x))
if (!drive) throw Error('No unused test drive is available')
let mounted=false
const evidence={observedAt:new Date().toISOString(),boundary:'Windows-WebClient/actual-device-provider',readOnly:true,deviceMutationsRequested:0}
try {
  try { await run('net.exe',['use',`${drive}:`,result.mountUrl,'/persistent:no'],{timeout:20000,windowsHide:true}); mounted=true }
  catch(error) { evidence.mount='failed';evidence.exitCode=error.code;evidence.systemError=Number((String(error.stderr).match(/\b(\d+)\b/)??[])[1])||null }
  if(mounted) {
    const root=`${drive}:\\`, names=await readdir(root)
    evidence.mount='passed';evidence.entries=names.length
    const selected=names[0], path=root+selected, info=await stat(path), file=await open(path,'r')
    try {
      const count=Math.min(8192,info.size), bytes=Buffer.alloc(count)
      const read=await file.read(bytes,0,count,Math.max(0,info.size-count))
      const remote=new URL(encodeURIComponent(selected),result.mountUrl)
      const response=await fetch(remote,{headers:{Range:`bytes=${Math.max(0,info.size-count)}-${info.size-1}`}})
      const expected=Buffer.from(await response.arrayBuffer())
      evidence.seek={bytes:read.bytesRead,equal:bytes.equals(expected),sha256:createHash('sha256').update(bytes).digest('hex')}
    } finally { await file.close() }
    const denied=await fetch(new URL('__qualification_write_refused__',result.mountUrl),{method:'PUT',body:'owned-test'})
    evidence.httpWriteDenied=denied.status===403
  }
} finally {
  if(mounted) { await run('net.exe',['use',`${drive}:`,'/delete','/y'],{timeout:20000,windowsHide:true});evidence.unmounted=true }
  const directory=resolve('node_modules/.cache/completion630-runtime');await mkdir(directory,{recursive:true})
  await writeFile(resolve(directory,`drive-${Date.now()}.json`),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2))
}
if(evidence.mount!=='passed'||!evidence.seek?.equal||!evidence.httpWriteDenied) process.exitCode=1
