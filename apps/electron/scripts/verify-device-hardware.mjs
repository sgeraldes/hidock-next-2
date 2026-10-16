/** Exercise fixed developer APIs through the existing app/USB owner; no UI automation. */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
const mode = process.argv[2] ?? 'status'
if (!['status', 'capture', 'readback', 'wav-import'].includes(mode)) throw new Error('Use status, capture, readback or wav-import')
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
    const timer = setTimeout(() => { pending.delete(id); fail(new Error('Fixed API operation timed out')) }, 90000)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
try {
  const status = await evaluate(`(async()=>{const a=window.electronAPI,j=a.jensen,s=await j.getState();return {connected:s.connected,model:s.model,versionNumber:s.versionNumber,versionCode:s.versionCode,recordingActive:!!s.recording,handlersLoaded:typeof j.getAudioDiagnostics==='function',capabilities:typeof j.getRecordingCapabilities==='function'?await j.getRecordingCapabilities():null,diagnostics:typeof j.getAudioDiagnostics==='function'?await j.getAudioDiagnostics():null}})()`)
  console.log(JSON.stringify(status, null, 2))
  if (mode === 'status') process.exitCode = 0
  else if (mode === 'wav-import') {
    const privateRoot = resolve('node_modules', '.cache', 'device-hardware-verification')
    const evidence = JSON.parse(await readFile(resolve(privateRoot, 'hardware-capture-verification.private.json'), 'utf8'))
    if (!evidence.savedRecording?.id || !/-Capture-Live(?:-\d+)?\.wav$/i.test(evidence.savedRecording.file_path)) throw new Error('Expected registered test-owned live capture')
    const hashFile = async () => {
      const hash = createHash('sha256')
      for await (const block of createReadStream(evidence.savedRecording.file_path, { highWaterMark: 65536 })) hash.update(block)
      return hash.digest('hex')
    }
    const beforeHash = await hashFile(), id = JSON.stringify(evidence.savedRecording.id)
    const result = await evaluate(`(async()=>{const a=window.electronAPI,s={kind:'recording',id:${id}},before=await a.deviceRecordingMarkers.list(s),imported=await a.deviceRecordingMarkers.importNative(s),after=await a.deviceRecordingMarkers.list(s);return {beforeCount:before.length,afterCount:after.length,unchanged:JSON.stringify(before)===JSON.stringify(after),imported,live:(await a.jensen.getAudioDiagnostics()).session.status}})()`)
    if (result.imported.status !== 'absent' || result.beforeCount === 0 || !result.unchanged || result.live !== 'idle' || beforeHash !== await hashFile()) throw new Error('Deployed PCM16 WAV marker acceptance failed')
    const report = { at: new Date().toISOString(), status: 'observed_deployed_PCM16_WAV_marker_reader', importedStatus: result.imported.status, retainedLocalMarkers: result.afterCount, originalSha256: beforeHash, originalUnchanged: true, liveIdle: true, providerRequests: 0, testOwnedPreviouslySavedCapture: true }
    await writeFile(resolve(privateRoot, 'deployed-wav-marker-reader.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
  else if (mode === 'readback') {
    const output = resolve('node_modules', '.cache', 'device-hardware-verification', 'hardware-capture-verification.private.json')
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    if (!evidence.savedRecording?.id) throw new Error('Capture must be registered before readback')
    const hash = createHash('sha256')
    for await (const block of createReadStream(evidence.savedRecording.file_path, { highWaterMark: 65536 })) hash.update(block)
    evidence.sourceSha256BeforeExport = hash.digest('hex')
    const id = JSON.stringify(evidence.savedRecording.id)
    evidence.readback = await evaluate(`(async()=>{const a=window.electronAPI,s={kind:'recording',id:${id}};return {markers:await a.deviceRecordingMarkers.list(s),tracks:await a.deviceAudio.exportTracks(s.id)}})()`)
    await writeFile(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({markers:evidence.readback.markers.length,tracks:evidence.readback.tracks.tracks.length,frames:evidence.readback.tracks.frames,seconds:evidence.readback.tracks.seconds},null,2))
    if (!evidence.readback.markers.some(m=>m.id===evidence.observation.marker.marker.id)) process.exitCode=1
  } else {
    if (!status.connected || status.recordingActive || !status.handlersLoaded || status.diagnostics.session.status !== 'idle') throw new Error('Capture requires connected, idle device and deployed handlers')
    const observation = await evaluate(`(async()=>{
      const a=window.electronAPI,j=a.jensen,events=[],errors=[];
      const off=j.onRealtimeRecording(e=>events.push(e));
      let started=false,packets=0,bytes=0,marker=null,pause=null,resume=null,diagnostics=null,pausedObservation=null;
      try {
        const start=await j.startRealtime({transcribe:false,saveRecording:true});
        if(start?.result!=='success') throw Error('Start rejected: '+JSON.stringify(start));
        started=true;
        const drain=async(ms)=>{const until=Date.now()+ms;while(Date.now()<until){const p=await j.getRealtimeData(0);if(p?.data?.length){packets++;bytes+=Math.max(0,p.data.length-8)}await new Promise(r=>setTimeout(r,p?.rest>1?50:100))}};
        await drain(10000);
        diagnostics=await j.getAudioDiagnostics();
        marker=await a.deviceRecordingMarkers.add({subject:{kind:'session',id:diagnostics.session.sessionId},requestId:crypto.randomUUID(),label:'Hardware capture verification',source:'manual'});
        pause=await j.pauseRealtime();
        const pausedBefore=await j.getAudioDiagnostics(),readDuringPause=await j.getRealtimeData(0);
        await new Promise(r=>setTimeout(r,1500));
        const pausedAfter=await j.getAudioDiagnostics();
        pausedObservation={before:pausedBefore.session,after:pausedAfter.session,readBlocked:readDuringPause===null,framesBefore:pausedBefore.diagnostics.frames,framesAfter:pausedAfter.diagnostics.frames};
        resume=await j.startRealtime({transcribe:false,saveRecording:true});
        await drain(50000);diagnostics=await j.getAudioDiagnostics();
      } finally {if(started) await j.stopRealtime();await new Promise(r=>setTimeout(r,1500));off()}
      return {packets,bytes,marker,pause,resume,pausedObservation,diagnostics,events,errors,after:await j.getAudioDiagnostics()};
    })()`)
    const evidence = { observedAt: new Date().toISOString(), deployedApp: true, usbOpenedByExistingApp: true, firmwareFlashed: false, providerTranscriptionRequested: false, status, observation }
    const privateRoot = resolve('node_modules', '.cache', 'device-hardware-verification')
    await mkdir(privateRoot, { recursive: true })
    const output = resolve(privateRoot, 'hardware-capture-verification.private.json')
    // Events contain local filenames; retain the detailed result locally, not in public evidence.
    await writeFile(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({packets:observation.packets,pcmBytes:observation.bytes,markerStatus:observation.marker?.status,pause:observation.pause,resume:observation.resume,saved:observation.events.filter(e=>e.status==='saved').length,diagnostics:observation.diagnostics,after:observation.after.session}, null, 2))
    if (!observation.bytes || !observation.events.some(e=>e.status==='saved') || observation.marker?.status !== 'accepted-local') process.exitCode = 1
  }
} finally { socket.close() }
