import { openValidationClient } from './device-validation-client.mjs'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const client = await openValidationClient()
const evidence = { observedAt: new Date().toISOString(), boundary: 'built-app/physical-stock/HTTP-and-Windows-map/lifecycle', deviceWritesRequested: 0 }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  evidence.stage = 'mount'
  const source = await client.evaluate(`(async()=>{const j=window.electronAPI.jensen,l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(x=>x.length>=1048576).sort((a,b)=>a.length-b.length)[0],m=await j.mountDeviceDrive(),s=await j.getFileSystemStatus();if(!m.mounted||!s.mountUrl)throw Error('Mount failed');return {url:s.mountUrl,name:f.name}})()`)
  const url = source.url.replace(/\/$/, '') + '/' + encodeURIComponent(source.name)
  evidence.stage = 'coalesced-read'
  const controller = new AbortController()
  const cancelledRead = fetch(url, { headers: { Range: 'bytes=0-1048575' }, signal: controller.signal })
  const survivingRead = fetch(url, { headers: { Range: 'bytes=0-1048575' } })
  const cancelledResponse = await cancelledRead
  controller.abort()
  try { await cancelledResponse.arrayBuffer() } catch {}
  const response = await survivingRead
  const bytes = Buffer.from(await response.arrayBuffer())
  const direct = await client.evaluate(`(async()=>{const v=await window.electronAPI.jensen.readFileRange(${JSON.stringify(source.name)},0,1048576);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',v)),x=>x.toString(16).padStart(2,'0')).join('')})()`)
  evidence.coalescedRead = { cancelledSubscriber: true, survivingStatus: response.status, survivingBytes: bytes.length, sha256: hash(bytes), equalsDeviceRange: hash(bytes) === direct }
  evidence.stage = 'disconnect'
  evidence.disconnect = await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;await j.disconnect();const d=await j.getDeviceDriveStatus(),s=await j.getFileSystemStatus();return {connected:await j.isConnected(),mounted:d.mounted,filesystemStopped:!s.running}})()`)
  try { const old = await fetch(url, { headers: { Range: 'bytes=0-51' } }); evidence.oldCapabilityRefused = old.status >= 400; await old.body?.cancel() } catch { evidence.oldCapabilityRefused = true }
  evidence.stage = 'reconnect'
  const fresh = await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;if(!await j.connect())throw Error('Reconnect failed');const m=await j.mountDeviceDrive(),s=await j.getFileSystemStatus(),l=await j.listFilesDetailed();return {mounted:m.mounted,url:s.mountUrl,complete:l.status==='complete',count:l.files.length}})()`)
  const next = await fetch(fresh.url.replace(/\/$/, '') + '/' + encodeURIComponent(source.name), { headers: { Range: 'bytes=0-1048575' } })
  evidence.reconnect = { mounted: fresh.mounted, newCapability: fresh.url !== source.url, catalogComplete: fresh.complete, count: fresh.count, bytesMatchPrior: hash(Buffer.from(await next.arrayBuffer())) === direct }
  await client.evaluate('window.electronAPI.jensen.unmountDeviceDrive()')
  const diagnostics = await client.evaluate('window.electronAPI.jensen.getProtocolDiagnostics()')
  evidence.ownerIdle = diagnostics.currentCommand === null && !diagnostics.fileStreamPending
  evidence.passed = evidence.coalescedRead.survivingStatus === 206 && bytes.length === 1048576 && evidence.coalescedRead.equalsDeviceRange && !evidence.disconnect.connected && !evidence.disconnect.mounted && evidence.disconnect.filesystemStopped && evidence.oldCapabilityRefused && evidence.reconnect.mounted && evidence.reconnect.newCapability && evidence.reconnect.catalogComplete && evidence.reconnect.bytesMatchPrior && evidence.ownerIdle
} catch { evidence.failure = 'Filesystem lifecycle qualification failed'; process.exitCode = 1 }
finally {
  await client.evaluate('window.electronAPI.jensen.unmountDeviceDrive()').catch(() => {})
  await writeFile('../../research/rea/completion630-lab/runtime/stock-filesystem-lifecycle.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  client.close()
}
if (!evidence.passed) process.exitCode = 1
