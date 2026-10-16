import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile, stat, rename } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import Database from 'better-sqlite3'
const execute = promisify(execFile), directory = resolve('node_modules/.cache/completion630-runtime')
const profile = JSON.parse(await readFile(join(directory, 'isolated-profile.private.json'), 'utf8'))
if (!resolve(profile.dataPath).startsWith(directory + '\\')) throw Error('Only the isolated library is permitted')
const owner = JSON.parse(await readFile(join(directory, 'current-app.private.json'), 'utf8'))
if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('Invalid owned process')
const normalOnly = process.argv.includes('--normal-only')
const prior = JSON.parse(await readFile('../../research/rea/completion630-lab/runtime/stock-transfer-benchmark.json','utf8')).baseline
const client = await openValidationClient()
const evidence = { observedAt: new Date().toISOString(), boundary: 'physical-stock/whole-read/normal-resume-publication/Windows-process-memory', deviceWritesRequested: 0, originalLibraryMutated: false }
let monitor, stop
try {
  evidence.stage = 'baseline'
  const source = normalOnly ? await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;if(!await j.isConnected()&&!await j.connect())throw Error('Connect failed');const l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(v=>v.length>=33554432&&v.length<47185920).sort((a,b)=>a.length-b.length)[0];if(!f||f.length!==${prior.bytes})throw Error('Source size differs');window.__benchmarkSource={filename:f.name,fileSize:f.length};return {name:f.name,size:f.length,ms:${prior.elapsedMs},inbound:${prior.actualInboundBytes},sha256:${JSON.stringify(prior.sha256)}}})()`) : await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;if(!await j.isConnected()&&!await j.connect())throw Error('Connect failed');const l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete catalog');const f=l.files.filter(v=>v.length>=33554432&&v.length<47185920).sort((a,b)=>a.length-b.length)[0];if(!f)throw Error('No bounded long source');const before=await j.getProtocolDiagnostics(),chunks=[];let bytes=0;const off=j.onDownloadChunk(x=>{if(x.filename===f.name){const v=new Uint8Array(x.data);chunks.push(v);bytes+=v.length}}),t=performance.now();let ok;try{ok=await j.downloadFile(f.name,f.length)}finally{off()}const elapsed=performance.now()-t;if(!ok||bytes!==f.length)throw Error('Baseline incomplete');const all=new Uint8Array(bytes);let p=0;for(const c of chunks){all.set(c,p);p+=c.length}const after=await j.getProtocolDiagnostics();window.__benchmarkSource={filename:f.name,fileSize:f.length};return {name:f.name,size:f.length,ms:elapsed,inbound:after.inboundBytes-before.inboundBytes,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all)),v=>v.toString(16).padStart(2,'0')).join('')}})()`)
  evidence.baseline = { observedPreviously: normalOnly, bytes: source.size, elapsedMs: Math.round(source.ms), bytesPerSecond: Math.round(source.size * 1000 / source.ms), actualInboundBytes: source.inbound, sha256: source.sha256 }
  // Preserve earlier owned publications before repeating this manual transfer.
  // Never move any file unless its full bytes equal this observed device source.
  for (const name of [source.name, source.name.replace(/\.hda$/i, '.mp3'), source.name.replace(/\.hda$/i, '.wav')]) {
    const previous = resolve(profile.dataPath, 'recordings', name)
    if (!previous.startsWith(resolve(profile.dataPath, 'recordings') + '\\')) throw Error('Invalid source name')
    let info
    try { info = await stat(previous) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.size !== source.size) throw Error('Existing isolated publication differs')
    const checksum = createHash('sha256')
    for await (const chunk of createReadStream(previous)) checksum.update(chunk)
    if (checksum.digest('hex') !== source.sha256) throw Error('Existing isolated publication differs')
    await rename(previous, join(directory, `preserved-benchmark-publication-${Date.now()}.private.bin`))
  }
  const db = new Database(join(profile.dataPath, 'data', 'hidock.db'), { fileMustExist: true })
  try { db.transaction(() => { for (const name of [source.name, source.name.replace(/\.hda$/i, '.mp3'), source.name.replace(/\.hda$/i, '.wav')]) {
    db.prepare('DELETE FROM synced_files WHERE original_filename=?').run(name)
    db.prepare('DELETE FROM download_queue WHERE filename=?').run(name)
    db.prepare("UPDATE recordings SET file_path=NULL,on_local=0,location='device-only' WHERE filename=? OR original_filename=?").run(name, name)
  } })() } finally { db.close() }
  stop = join(directory, `benchmark-stop-${Date.now()}.private`)
  // The private stop path is a generated workspace path, never caller input.
  const psPath = stop.replace(/'/g, "''")
  monitor = execute('powershell.exe', ['-NoProfile', '-Command', `$taskRootPid=${owner.pid};$taskUntil=[DateTime]::UtcNow.AddSeconds(60);$taskSamples=@();while([DateTime]::UtcNow -lt $taskUntil -and -not (Test-Path -LiteralPath '${psPath}')){$taskProcesses=@(Get-CimInstance Win32_Process -Filter "name='electron.exe'");$taskIds=[System.Collections.Generic.HashSet[uint32]]::new();[void]$taskIds.Add($taskRootPid);do{$taskAdded=$false;foreach($taskProcess in $taskProcesses){if($taskIds.Contains($taskProcess.ParentProcessId) -and $taskIds.Add($taskProcess.ProcessId)){$taskAdded=$true}}}while($taskAdded);$taskMemory=[long]0;foreach($taskId in $taskIds){$taskP=Get-Process -Id $taskId -ErrorAction SilentlyContinue;if($taskP){$taskMemory+=$taskP.WorkingSet64}};$taskSamples+=$taskMemory;Start-Sleep -Milliseconds 200};$taskSamples | ConvertTo-Json -Compress`], { windowsHide: true, maxBuffer: 65536 })
  evidence.stage = 'normal-download'
  const downloaded = await client.evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen,f=window.__benchmarkSource,q=await a.downloadService.queueDownloads([{filename:f.filename,size:f.fileSize}]);if(!q.queued.includes(f.filename))throw Error('Queue refused');const memory=[await j.getValidationMemory()],timer=setInterval(()=>{void j.getValidationMemory().then(v=>memory.push(v))},250),before=await j.getProtocolDiagnostics(),t=performance.now();let result;try{result=await j.downloadToLibrary(f.filename,f.fileSize)}finally{clearInterval(timer)}const elapsed=performance.now()-t,after=await j.getProtocolDiagnostics();memory.push(await j.getValidationMemory());return {result,elapsed,memory,inbound:after.inboundBytes-before.inboundBytes,idle:after.currentCommand===null&&!after.fileStreamPending}})()`)
  await writeFile(stop, 'complete')
  evidence.mainMemory = { samples: downloaded.memory.length, first: downloaded.memory[0]?.main, last: downloaded.memory.at(-1)?.main,
    peakHeapUsed: Math.max(...downloaded.memory.map(v => v.main.heapUsed)), peakExternal: Math.max(...downloaded.memory.map(v => v.main.external)),
    processes: downloaded.memory.at(-1)?.processes }
  const monitored = await monitor
  const samples = JSON.parse(monitored.stdout)
  evidence.memory = { metric: 'sum of owned app process working sets', sampleCount: samples.length, intervalMs: 200, firstBytes: samples[0], peakBytes: Math.max(...samples), peakIncreaseBytes: Math.max(...samples) - samples[0], includesRendererAndDatabase: true, provesStrictHeapBound: false }
  if (!downloaded.result.success || !resolve(downloaded.result.filePath).startsWith(resolve(join(profile.dataPath, 'recordings')) + '\\')) throw Error('Publication failed or escaped isolated library')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(downloaded.result.filePath)) digest.update(chunk)
  evidence.normalDownload = { bytes: (await stat(downloaded.result.filePath)).size, sha256: digest.digest('hex'), elapsedMs: Math.round(downloaded.elapsed), bytesPerSecond: Math.round(source.size * 1000 / downloaded.elapsed), actualInboundBytes: downloaded.inbound, ownerIdle: downloaded.idle }
  evidence.normalDownload.equalsBaseline = evidence.normalDownload.bytes === source.size && evidence.normalDownload.sha256 === source.sha256
  evidence.passed = evidence.normalDownload.equalsBaseline && downloaded.idle && samples.length >= 2
} catch { evidence.failure = 'Long transfer qualification failed'; process.exitCode = 1 }
finally {
  if (stop) await writeFile(stop, 'complete')
  await monitor?.catch(() => {})
  await writeFile(normalOnly ? '../../research/rea/completion630-lab/runtime/stock-transfer-benchmark-normal-only.json' : '../../research/rea/completion630-lab/runtime/stock-transfer-benchmark-instrumented.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  client.close()
}
if (!evidence.passed) process.exitCode = 1
