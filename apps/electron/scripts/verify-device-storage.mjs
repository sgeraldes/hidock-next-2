/** Fixed read-only storage qualification through the running development app owner. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const mode = process.argv[2] ?? 'list'
if (!['list', 'ranges', 'filesystem', 'prefix-pages'].includes(mode)) throw Error('Use list, ranges, prefix-pages or filesystem')
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
if (!target) throw Error('Expected development app is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }) })
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = pending.get(message.id)
  if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.fail(Error(message.error.message)) : request.ok(message.result) }
})
async function evaluate(expression) {
  const id = ++sequence
  const result = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { pending.delete(id); fail(Error('Storage qualification timed out')) }, 120000)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
try {
  const result = await evaluate(`(async()=>{
    const j=window.electronAPI.jensen;
    if(!await j.isConnected()) { if(!await j.connect()) throw Error('Device connect failed') }
    const info=await j.getDeviceInfo(), start=performance.now(), listing=await j.listFilesDetailed(), elapsed=performance.now()-start;
    const summary={observedAt:new Date().toISOString(),boundary:'running-app/sole-USB-owner',model:info?.model,version:info?.versionNumber,
      listing:{status:listing.status,expected:listing.expectedCount,parsed:listing.parsedCount,files:listing.files.length,reason:listing.reason,milliseconds:elapsed},mutationsRequested:0};
    if(listing.status!=='complete') return summary;
    if(${JSON.stringify(mode)}==='prefix-pages') {
      const pages=[], aggregate=[];
      for(let at=0;at<listing.files.length;at+=128){const t=performance.now(),value=await j.listFilesPage(at,Math.min(128,listing.files.length-at));pages.push({index:at,status:value.status,parsed:value.parsedCount,total:value.totalCount,milliseconds:performance.now()-t});aggregate.push(...value.files);if(value.status!=='complete')throw Error('Entry page is incomplete')}
      const records=new Map(listing.files.map(f=>[f.name,f]));
      const equal=aggregate.length===listing.files.length&&new Set(aggregate.map(f=>f.name)).size===aggregate.length&&aggregate.every(f=>{const original=records.get(f.name);return original&&f.length===original.length&&f.signature===original.signature&&f.version===original.version});
      if(!equal)throw Error('Paged catalog differs from full listing');
      const file=listing.files.find(f=>f.length>16360);if(!file)throw Error('No completed prefix fixture');
      const prefixes=[];
      for(const count of [52,8180,16360]){const a=new Uint8Array(await j.readFilePrefix(file.name,count)),b=new Uint8Array(await j.readFileRange(file.name,0,count));const identical=a.length===count&&b.length===count&&a.every((v,i)=>v===b[i]);prefixes.push({count,equal:identical});if(!identical)throw Error('Prefix differs from range')}
      return {...summary,pages,pagedCatalogEqualsFull:equal,prefixes,connectedAfter:await j.isConnected()};
    }
    if(${JSON.stringify(mode)}==='ranges') {
      const candidates=listing.files.filter(f=>f.length>8192&&f.length<=4194304).sort((a,b)=>a.length-b.length);
      const file=candidates.find(f=>f.length>1048576)||candidates[0];
      if(!file) return {...summary,rangeTest:'no-bounded-completed-file'};
      const chunks=[];let length=0;
      const off=j.onDownloadChunk(x=>{if(x.filename===file.name){const v=new Uint8Array(x.data);chunks.push(v);length+=v.length}});
      let full;const before=performance.now();
      try { full=await j.downloadFile(file.name,file.length) } finally {off()}
      if(!full||length!==file.length) throw Error('Whole-file baseline did not complete');
      const fullMilliseconds=performance.now()-before;
      const golden=new Uint8Array(length);let p=0;for(const c of chunks){golden.set(c,p);p+=c.length}
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',golden)),v=>v.toString(16).padStart(2,'0')).join('');
      const cases=[{offset:0,count:Math.min(length,8192)},{offset:Math.min(65535,length-1),count:Math.min(1048576,length-Math.min(65535,length-1))},{offset:Math.max(0,length-52),count:Math.min(52,length)}];
      const ranges=[];
      for(const c of cases){const t=performance.now();const v=new Uint8Array(await j.readFileRange(file.name,c.offset,c.count));const equal=v.length===c.count&&v.every((b,i)=>b===golden[c.offset+i]);ranges.push({...c,bytes:v.length,equal,milliseconds:performance.now()-t});if(!equal) throw Error('Device range differs from full baseline')}
      return {...summary,full:{bytes:length,sha256:hash,milliseconds:fullMilliseconds,bytesPerSecond:length*1000/fullMilliseconds},ranges,connectedAfter:await j.isConnected()};
    }
    if(${JSON.stringify(mode)}==='filesystem') { const s=await j.startFileSystem(); window.__hidockQualificationFs=s; return {...summary,filesystem:{running:s.running,port:s.port,files:s.files,readOnly:s.readOnly}} }
    return summary;
  })()`)
  const folder = resolve('node_modules/.cache/completion630-runtime')
  await mkdir(folder, { recursive: true })
  await writeFile(resolve(folder, `storage-${mode}-${Date.now()}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (result.listing.status !== 'complete') process.exitCode = 1
} finally { socket.close() }
