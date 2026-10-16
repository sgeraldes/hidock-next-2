/** Fixed developer API verification through the existing deployed app and USB owner. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const mode = process.argv[2] ?? 'preflight'
if (!['preflight', 'capture', 'download', 'restart-readback', 'live-probe', 'custom-guard'].includes(mode)) throw new Error('Use preflight, capture, download, restart-readback, live-probe or custom-guard')
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
if (!target) throw new Error('Expected deployed app target is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }) })
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data), request = pending.get(value.id)
  if (request) { pending.delete(value.id); clearTimeout(request.timer); value.error ? request.fail(new Error(value.error.message)) : request.ok(value.result) }
})
async function evaluate(expression) {
  const id = ++sequence
  const result = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { pending.delete(id); fail(new Error('Fixed API operation timed out')) }, 45000)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const root = resolve('node_modules', '.cache', 'device-hardware-verification')
await mkdir(root, { recursive: true })
const output = resolve(root, 'native-marker-verification.private.json')
try {
  const preflight = await evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen,s=await j.getState(),c=await a.config.get(),d=await j.getAudioDiagnostics();return {connected:s.connected,model:s.model,version:s.versionCode,live:d.session.status,autoDownload:c.success?c.data.device?.autoDownload===true:null,nativeAPI:typeof j.getNativeRecordingStatus==='function',native:s.connected&&s.versionCode==='6.3.0'&&typeof j.getNativeRecordingStatus==='function'?await j.getNativeRecordingStatus():null}})()`)
  console.log(JSON.stringify({ ...preflight, native: preflight.native ? { active: !!preflight.native.recording, duration: preflight.native.duration, type: preflight.native.type, samples: preflight.native.samples.length } : null }, null, 2))
  if (mode === 'custom-guard') {
    if (!preflight.connected || preflight.model !== 'hidock-h1e' || preflight.version !== '6.3.0' || preflight.live !== 'idle' || preflight.native?.recording !== null) throw new Error('Custom guard requires verified idle stock device')
    const result = await evaluate(`(async()=>{
      const j=window.electronAPI.jensen;
      if(typeof j.getCustomRecordingProfile!=='function'||typeof j.setCustomRecordingProfile!=='function')throw Error('New custom profile APIs not deployed');
      const read=await j.getCustomRecordingProfile();
      const write=await j.setCustomRecordingProfile({profile:2,gainLeftQ15:32768,gainRightQ15:32768});
      if(typeof j.getCustomRecordingFormat!=='function'||typeof j.setCustomRecordingFormat!=='function'||typeof j.getCustomMarkerRules!=='function'||typeof j.setCustomMarkerRules!=='function')throw Error('Optional extension APIs not deployed');
      const formatRead=await j.getCustomRecordingFormat(),formatWrite=await j.setCustomRecordingFormat('wav');
      const rulesRead=await j.getCustomMarkerRules(),rulesWrite=await j.setCustomMarkerRules({enabled:false,lane:2,meanMagnitudeThreshold:1000});
      const diagnostics=await j.getAudioDiagnostics();
      return {read,write,formatRead,formatWrite,rulesRead,rulesWrite,liveAfter:diagnostics.session.status,nativeIdleAfter:(await j.getNativeRecordingStatus())?.recording===null};
    })()`)
    if([result.read,result.write,result.formatRead,result.formatWrite,result.rulesRead,result.rulesWrite].some(value=>value!==null)||result.liveAfter!=='idle'||!result.nativeIdleAfter)throw Error('Stock custom-extension guard failed')
    const evidence={at:new Date().toISOString(),status:'observed_deployed_stock_custom_profile_guard',model:preflight.model,version:preflight.version,autoDownload:preflight.autoDownload,...result,modifiedFirmwareInstalled:false};
    await writeFile(resolve(root,'custom-profile-stock-guard.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence,null,2));
  } else if (mode === 'live-probe') {
    if (!preflight.connected || preflight.model !== 'hidock-h1e' || preflight.version !== '6.3.0' || preflight.live !== 'idle' || preflight.native?.recording !== null) throw new Error('Live probe requires verified idle stock device')
    const probe = await evaluate(`(async()=>{
      const j=window.electronAPI.jensen,result={packets:0,pcmBytes:0,providerTranscriptionRequested:false,savedRecordingRequested:false};let started=false;
      try {
        result.start=await j.startRealtime({transcribe:false,saveRecording:false});
        if(result.start?.result!=='success')throw Error('Live start rejected');
        started=true;await new Promise(r=>setTimeout(r,750));const until=Date.now()+10000;
        while(Date.now()<until){const p=await j.getRealtimeData(0);if(p?.data?.length>8){result.packets++;result.pcmBytes+=p.data.length-8}await new Promise(r=>setTimeout(r,100))}
        const d=await j.getAudioDiagnostics();result.captureDiagnostics=d.diagnostics;
      } finally {if(started)result.stop=await j.stopRealtime()}
      result.liveAfter=(await j.getAudioDiagnostics()).session.status;
      result.nativeIdleAfter=(await j.getNativeRecordingStatus())?.recording===null;return result;
    })()`)
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    const attempt = { at: new Date().toISOString(), ...probe }
    evidence.finalDeployedLiveProbeAttempts = [...(evidence.finalDeployedLiveProbeAttempts ?? []), attempt]
    const passed = probe.start?.result === 'success' && probe.pcmBytes > 0 && probe.liveAfter === 'idle' && probe.nativeIdleAfter
    if (passed) evidence.finalDeployedLiveProbe = attempt
    await writeFile(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(attempt, null, 2))
    if (!passed) throw new Error('Final deployed live probe failed')
  } else if (mode === 'capture') {
    if (!preflight.connected || preflight.model !== 'hidock-h1e' || preflight.version !== '6.3.0' || preflight.live !== 'idle' || !preflight.nativeAPI || preflight.native?.recording !== null) throw new Error('Test requires verified idle stock device and deployed guarded API')
    const observation = await evaluate(`(async()=>{
      const j=window.electronAPI.jensen,wait=ms=>new Promise(r=>setTimeout(r,ms)),result={};
      const before=await j.getNativeRecordingStatus();if(before.recording!==null)throw Error('An existing recording is active');
      result.start=await j.startNativeVerificationRecording({requestId:crypto.randomUUID(),expectedRecording:null});
      if(result.start.status!=='acknowledged')return result;
      await wait(1800);result.active=await j.getNativeRecordingStatus();
      if(!result.active.recording)return result;
      const owned=result.active.recording;
      try {
        result.manualOnly=result.start.manualOnly;
        if(!result.manualOnly)throw Error(result.start.error||'Verification recording protection failed');
        result.liveGuard=await j.startRealtime({transcribe:false,saveRecording:false});
        if(result.liveGuard.result==='success')throw Error('Live guard unexpectedly allowed native interruption');
        await wait(2600);result.beforeMarker=await j.getNativeRecordingStatus();
        if(result.beforeMarker.recording!==owned)throw Error('The test recording changed');
        const request={requestId:crypto.randomUUID(),expectedRecording:owned};
        result.markerRequest=request;
        result.marker=await j.addNativeMarker(request);result.duplicate=await j.addNativeMarker(request);
        // Native auto-record cleanup deletes files below120,000 bytes. Preserve
        // enough actual stock64kbps output for finalized-file/footer readback.
        await wait(20000);result.afterMarker=await j.getNativeRecordingStatus();
      } catch(error) { result.error=error.message
      } finally {
        const status=await j.getNativeRecordingStatus();
        if(status.recording===owned){result.stop=await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:owned});await wait(1700)}
        else result.stopSkippedBecauseRecordingChanged=true;
      }
      result.after=await j.getNativeRecordingStatus();return result;
    })()`)
    await writeFile(output, JSON.stringify({ at: new Date().toISOString(), preflight, observation, firmwareFlashed: false, providerRequests: 0 }, null, 2))
    console.log(JSON.stringify({ start: observation.start?.status, manualOnly: observation.start?.manualOnly, active: !!observation.active?.recording, liveGuard: observation.liveGuard, marker: observation.marker, duplicate: observation.duplicate, stop: observation.stop, idleAfter: observation.after?.recording === null }, null, 2))
    if (!observation.active?.recording || observation.marker?.status !== 'acknowledged' || observation.stop?.status !== 'acknowledged' || observation.after?.recording !== null) process.exitCode = 1
  } else if (mode === 'restart-readback') {
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    if (!evidence.observation.markerRequest || preflight.native?.recording !== null) throw new Error('An idle device and saved marker request are required')
    const duplicate = await evaluate(`window.electronAPI.jensen.addNativeMarker(${JSON.stringify(evidence.observation.markerRequest)})`)
    if (duplicate.status !== 'duplicate' || duplicate.previousStatus !== 'acknowledged') throw new Error('Durable marker deduplication failed')
    const deviceAutoRecord = await evaluate(`(async()=>{const s=await window.electronAPI.jensen.getSettings();return typeof s?.autoRecord==='boolean'?s.autoRecord:null})()`)
    const libraryTestRows = await evaluate(`(async()=>{const name=${JSON.stringify(evidence.observation.active.recording)}.replace(/[.](mp3|hda|wav)$/i,'').toLowerCase();return (await window.electronAPI.recordings.getAll()).filter(r=>[r.filename,r.original_filename].some(v=>typeof v==='string'&&v.replace(/[.](mp3|hda|wav)$/i,'').toLowerCase()===name)).length})()`)
    evidence.restartReadback = { at: new Date().toISOString(), duplicate, autoDownloadUnchanged: preflight.autoDownload === evidence.preflight.autoDownload, deviceAutoRecord, libraryTestRows, idle: true }
    await writeFile(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence.restartReadback, null, 2))
  } else if (mode === 'download') {
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    const filename = evidence.observation?.active?.recording
    if (!filename || evidence.observation.after?.recording !== null) throw new Error('A stopped, owned test recording is required')
    const listing = await evaluate(`(async()=>{const j=window.electronAPI.jensen,s=await j.getNativeRecordingStatus();if(s.recording!==null)throw Error('Device recording active');const reply=await j.listFiles();const files=Array.isArray(reply)?reply:reply?.files;return {reply, file:files?.find(f=>f.name===${JSON.stringify(filename)}||f.filename===${JSON.stringify(filename)})??null}})()`)
    await writeFile(resolve(root,'native-test-filelist.private.json'), JSON.stringify(listing,null,2))
    const file = listing.file
    if (!file) { console.log(JSON.stringify({array:Array.isArray(listing.reply),count:Array.isArray(listing.reply)?listing.reply.length:null,keys:listing.reply?Object.keys(listing.reply).slice(0,5):null})); throw new Error('Owned test file was not listed') }
    await writeFile(output, JSON.stringify({ ...evidence, listedTestFile: file }, null, 2))
    console.log(JSON.stringify({ listed: true, keys: Object.keys(file) }, null, 2))
    // Download receives fixed existing IPC chunk events; no database/library/provider path.
    const fileSize = file.length ?? file.size ?? file.fileSize
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 4 * 1024 * 1024) throw new Error('Owned test file size is invalid or exceeds the bounded test limit')
    const downloaded = await evaluate(`(async()=>{const j=window.electronAPI.jensen,name=${JSON.stringify(filename)},chunks=[];let bytes=0;
      const off=j.onDownloadChunk(e=>{if(e.filename===name){bytes+=e.data.length;if(bytes<=4194304)chunks.push(Array.from(e.data))}});
      try {const ok=await j.downloadFile(name,${fileSize});if(!ok||bytes!==${fileSize})throw Error('Incomplete test recording download');return chunks.flat()}finally{off()}
    })()`)
    const bytes = Buffer.from(downloaded)
    const destination = resolve(root, 'native-marker-stock-6.3.0.private.mp3')
    await writeFile(destination, bytes, { flag: 'wx' })
    evidence.download = { path: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    await writeFile(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ downloaded: true, bytes: bytes.length, sha256: evidence.download.sha256 }, null, 2))
  }
} finally { socket.close() }
