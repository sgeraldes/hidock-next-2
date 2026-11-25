/** Root-run native source-separation matrix. Usage and limits: research/rea/completion630-lab/application/NATIVE-SOURCE-HELPER.md */
import { openValidationClient } from './device-validation-client.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2), inventory = args.includes('--inventory')
const external = args.filter(a => a.startsWith('--external-sink='))
if (args.some(a => a !== '--inventory' && !a.startsWith('--external-sink=')) || external.length > 1 || (inventory && args.length > 1)) throw Error('Usage: --inventory | [--external-sink=<deviceId>]')
const externalSink = external.length ? external[0].slice('--external-sink='.length) : null
if (externalSink !== null && (!/^[\w+\-=/.:{}%@]{1,512}$/.test(externalSink) || ['default', 'communications'].includes(externalSink))) throw Error('External sink must be an exact observed deviceId')

const CFG = { dockHz: 1000, extHz: 700, dockGain: 0.02, extGain: 0.08, marginMs: 400, riseDb: 20, isolationDb: 10, peakDb: 10, bothDb: 6 }
const FREQS = [700, 850, 1000, 1150], UNITY_Q15 = 32768, md5 = b => createHash('md5').update(b).digest('hex')

const inventoryCode = `(async()=>({setSinkId:typeof AudioContext.prototype.setSinkId==='function',outputs:(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput').map(d=>({deviceId:d.deviceId,groupId:d.groupId,label:d.label}))}))()`

const captureCode = `(async()=>{
  const j=window.electronAPI.jensen,wait=ms=>new Promise(ok=>setTimeout(ok,ms)),ext=${JSON.stringify(externalSink)},C=${JSON.stringify(CFG)},q=()=>crypto.randomUUID();
  if(!await j.isConnected())throw Error('Dock not connected');
  if((await j.getDeviceInfo())?.versionNumber!==393988)throw Error('Firmware 393988 required');
  if((await j.getNativeRecordingStatus()).recording!==null)throw Error('Native recording is not idle');
  const o={format:await j.getCustomRecordingFormat(),profile:await j.getCustomRecordingProfile(),rules:await j.getCustomMarkerRules()};
  if(!['mp3','wav'].includes(o.format?.format)||!Number.isInteger(o.profile?.gainLeftQ15)||!Number.isInteger(o.profile?.gainRightQ15)||typeof o.rules?.enabled!=='boolean')throw Error('Original controls are not all known');
  const orig={format:{format:o.format.format},profile:{profile:o.profile.profile,gainLeftQ15:o.profile.gainLeftQ15,gainRightQ15:o.profile.gainRightQ15},rules:{enabled:o.rules.enabled,lane:o.rules.lane,meanMagnitudeThreshold:o.rules.meanMagnitudeThreshold}};
  const want={format:{format:'wav'},profile:{...orig.profile,gainLeftQ15:${UNITY_Q15},gainRightQ15:${UNITY_Q15}},rules:{...orig.rules,enabled:false}};
  const ctl={
    format:{get:()=>j.getCustomRecordingFormat(),set:v=>j.setCustomRecordingFormat(v.format),key:r=>r&&r.format},
    profile:{get:()=>j.getCustomRecordingProfile(),set:v=>j.setCustomRecordingProfile(v),key:r=>r&&[r.profile,r.gainLeftQ15,r.gainRightQ15].join()},
    rules:{get:()=>j.getCustomMarkerRules(),set:v=>j.setCustomMarkerRules(v),key:r=>r&&[r.enabled,r.lane,r.meanMagnitudeThreshold].join()}};
  const changed=[],put=async(name,value)=>{const c=ctl[name],cur=await c.get();if(!cur)throw Error(name+' state unknown');if(c.key(cur)===c.key(value))return'unchanged';
    if(!changed.includes(name))changed.push(name);if((await c.set(value))?.result!=='success')throw Error(name+' setter not acknowledged');
    if(c.key(await c.get())!==c.key(value))throw Error(name+' readback mismatch');return'acknowledged'};
  const outs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications');
  const docks=outs.filter(d=>/hidock/i.test(d.label));if(docks.length!==1)throw Error('Exactly one explicit HiDock output is required');
  const extDev=ext===null?null:outs.find(d=>d.deviceId===ext);
  if(ext!==null&&(!extDev||/hidock/i.test(extDev.label)||extDev.groupId===docks[0].groupId))throw Error('External sink must be an observed non-HiDock output');
  if(typeof AudioContext.prototype.setSinkId!=='function')throw Error('setSinkId unavailable');
  const result={changed,restore:{},phases:[]},voices=[];let owned=null;
  try{
    for(const [dev,hz,gain] of [[docks[0],C.dockHz,C.dockGain],...(extDev?[[extDev,C.extHz,C.extGain]]:[])]){
      const ctx=new AudioContext({sampleRate:48000});voices.push({ctx,gain});await ctx.setSinkId(dev.deviceId);await ctx.resume();
      const osc=ctx.createOscillator(),g=ctx.createGain();osc.frequency.value=hz;g.gain.value=0;osc.connect(g);g.connect(ctx.destination);osc.start();voices[voices.length-1].g=g}
    for(const n of ['format','profile','rules'])result[n+'Apply']=await put(n,want[n]);
    const tCall=Date.now();result.start=await j.startNativeVerificationRecording({requestId:q(),expectedRecording:null});const t0=Date.now();
    if(result.start.status!=='acknowledged'||!result.start.manualOnly||!result.start.recording)throw Error('Protected start not acknowledged');
    owned=result.start.recording;result.startAckLatencyMs=t0-tCall;
    const plan=[['baseline',1000,[]],['dock',3000,[0]],...(extDev?[['external',3000,[1]],['both',3000,[0,1]]]:[]),['quiet',1000,[]]];
    for(const [name,ms,on] of plan){const s=Date.now()-t0;voices.forEach((v,i)=>v.g.gain.setTargetAtTime(on.includes(i)?v.gain:0,v.ctx.currentTime,0.02));await wait(ms);result.phases.push({name,startMs:s,endMs:Date.now()-t0})}
    const active=await j.getNativeRecordingStatus();result.activeDuration=active.duration;if(active.recording!==owned)throw Error('Owned recording changed')
  }catch(e){result.failure=String(e?.message??'capture failed').split('\\n')[0]}
  finally{
    try{
      result.contextsClosed=(await Promise.allSettled(voices.map(v=>v.ctx.close()))).every(r=>r.status==='fulfilled');
      if(owned){if((await j.getNativeRecordingStatus()).recording===owned){result.stop=await j.toggleNativeRecording({requestId:q(),expectedRecording:owned});await wait(1800)}else result.ownerChanged=true}
      result.idleAfter=(await j.getNativeRecordingStatus()).recording===null;
      if(result.idleAfter){for(const n of [...changed])try{result.restore[n]=await put(n,orig[n])}catch(e){result.restore[n]='FAILED: '+String(e?.message).split('\\n')[0]}}
      else if(changed.length)result.restore.skipped='device not idle; original controls NOT restored'
    }catch(e){result.finalFailure=String(e?.message).split('\\n')[0]}
  }
  if(!owned||!result.idleAfter)return result;
  const list=await j.listFilesDetailed(),f=list?.status==='complete'&&list.files.find(x=>x.name===owned);
  if(!f||f.length<44||f.length>2097152){result.readFailure='Owned file missing or outside 2 MiB bound';return result}
  const data=new Uint8Array(f.length);for(let at=0;at<data.length;at+=1048576)data.set(new Uint8Array(await j.readFileRange(owned,at,Math.min(1048576,data.length-at))),at);
  result.ownedFilename=owned;result.fileSignature=f.signature;result.bytes=Array.from(data);return result
})()`

function parseWav(b) {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw Error('Not RIFF/WAVE')
  let at = 12, fmt = null
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8, end = body + size
    if (end > b.length) throw Error('Chunk overruns file')
    if (id === 'fmt ' && size >= 16) fmt = { tag: b.readUInt16LE(body), ch: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), align: b.readUInt16LE(body + 12), bits: b.readUInt16LE(body + 14) }
    if (id === 'data') {
      if (!fmt || fmt.tag !== 1 || fmt.ch !== 2 || fmt.rate !== 16000 || fmt.bits !== 16 || fmt.align !== 4 || size % 4) throw Error('Not PCM16 stereo 16 kHz')
      return { dataAt: body, frames: size / 4, footerBytes: b.length - end, footerMd5: b.length > end ? md5(b.subarray(end)).slice(0, 8) : null }
    }
    at = end + (size & 1)
  }
  throw Error('No data chunk')
}

function measure(b, p, fromMs, toMs) {
  const i0 = Math.round(fromMs * 16), i1 = Math.round(toMs * 16), n = i1 - i0
  if (i0 < 0 || i1 > p.frames || n < 2400) throw Error('Measured window outside the file or too short')
  const win = Array.from({ length: n }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1))), ws = win.reduce((s, v) => s + v, 0)
  return [0, 1].map(c => {
    let sq = 0; const re = FREQS.map(() => 0), im = FREQS.map(() => 0)
    for (let k = 0; k < n; k++) {
      const x = b.readInt16LE(p.dataAt + (i0 + k) * 4 + c * 2); sq += x * x
      FREQS.forEach((f, m) => { const ph = 2 * Math.PI * f * k / 16000; re[m] += win[k] * x * Math.cos(ph); im[m] += win[k] * x * Math.sin(ph) })
    }
    return { rms: Math.sqrt(sq / n), amp: Object.fromEntries(FREQS.map((f, m) => [f, 2 * Math.hypot(re[m], im[m]) / ws])) }
  })
}

const r1 = x => Math.round(x * 10) / 10, db = x => 20 * Math.log10(x)
function lane(st, floor, hz) {
  const a = st.map(c => c.amp[hz]), d = a[0] >= a[1] ? 0 : 1, o = 1 - d
  const riseDb = db(a[d] / floor[hz][d]), isolationDb = db(a[d] / Math.max(a[o], 0.5))
  const peakDb = db(a[d] / Math.max(st[d].amp[850], st[d].amp[1150], 0.5))
  const status = riseDb < CFG.riseDb ? 'absent-or-weak' : peakDb < CFG.peakDb ? 'wrong-frequency' : isolationDb < CFG.isolationDb ? 'ambiguous-lane' : 'lane-' + 'LR'[d]
  return { status, dominant: 'LR'[d], riseDb: r1(riseDb), isolationDb: r1(isolationDb), peakDb: r1(peakDb), amp: a.map(r1) }
}

function analyze(b, cap) {
  const p = parseWav(b), win = {}
  for (const ph of cap.phases) win[ph.name] = { fromMs: ph.startMs + CFG.marginMs, toMs: ph.endMs - CFG.marginMs }
  const st = Object.fromEntries(Object.entries(win).map(([k, w]) => [k, measure(b, p, w.fromMs, w.toMs)]))
  const floor = Object.fromEntries(FREQS.map(f => [f, [0, 1].map(c => Math.max(0.5, (st.baseline[c].amp[f] + st.quiet[c].amp[f]) / 2))]))
  const dock = lane(st.dock, floor, CFG.dockHz), ext = st.external ? lane(st.external, floor, CFG.extHz) : null
  const ok = l => l?.status.startsWith('lane-')
  let both = null, verdict = 'INCONCLUSIVE', claim = 'none: excitation absent, weak or ambiguous'
  if (st.both) {
    const bd = lane(st.both, floor, CFG.dockHz), be = lane(st.both, floor, CFG.extHz), di = dock.dominant === 'L' ? 0 : 1, ei = ext.dominant === 'L' ? 0 : 1
    both = { dock: bd, external: be, dockDeltaDb: r1(db(st.both[di].amp[CFG.dockHz] / st.dock[di].amp[CFG.dockHz])), externalDeltaDb: r1(db(st.both[ei].amp[CFG.extHz] / st.external[ei].amp[CFG.extHz])) }
    both.consistent = Math.abs(both.dockDeltaDb) <= CFG.bothDb && Math.abs(both.externalDeltaDb) <= CFG.bothDb
  }
  if (ok(dock) && !st.external) { verdict = 'DOCK-RENDER-MAPPING-ONLY'; claim = `HiDock output tone landed in lane ${dock.dominant}; physical microphone identity NOT claimed` }
  else if (ok(dock) && ok(ext) && both?.consistent) {
    verdict = ext.dominant === dock.dominant ? 'SAME-LANE' : 'SOURCE-SEPARATION-OBSERVED'
    claim = verdict === 'SAME-LANE' ? 'HiDock output and external tone landed in the same lane; no separation' : `HiDock output tone in lane ${dock.dominant}, external tone in lane ${ext.dominant}, single capture, unity gains, WAV only`
  }
  const phases = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { window: win[k], rms: v.map(c => r1(c.rms)), amp700: v.map(c => r1(c.amp[700])), amp1000: v.map(c => r1(c.amp[1000])) }]))
  return { verdict, claim, dock, external: ext, both, phases, floor: Object.fromEntries(Object.entries(floor).map(([f, v]) => [f, v.map(r1)])), frames: p.frames, frameDurationS: p.frames / 16000, footerBytes: p.footerBytes, footerMd5Prefix: p.footerMd5 }
}

const client = await openValidationClient()
if (inventory) {
  try { console.log(JSON.stringify(await client.evaluate(inventoryCode, 30000), null, 2)) } finally { client.close() }
} else {
  const folder = resolve('node_modules/.cache/completion630-runtime'), stamp = Date.now()
  const report = { observedAt: new Date().toISOString(), boundary: 'root-run helper; real-boundary verification NOT claimed', mode: externalSink ? 'dock+external' : 'dock-only', providerRequests: 0, deviceDeletes: 0, externalAudibility: 'UNKNOWN', config: CFG }
  let cap = null
  try {
    await mkdir(folder, { recursive: true })
    try { cap = await client.evaluate(captureCode, 90000) } finally { client.close() }
    const audio = cap.bytes ? Buffer.from(cap.bytes) : null, filename = cap.ownedFilename
    delete cap.bytes; delete cap.ownedFilename
    await writeFile(resolve(folder, `source-separation-${stamp}.private.json`), JSON.stringify({ filename, capture: cap }, null, 2) + '\n', { flag: 'wx' })
    report.capture = { start: cap.start?.status, startAckLatencyMs: cap.startAckLatencyMs, phases: cap.phases, deviceDurationReported: cap.activeDuration, stop: cap.stop?.status, idleAfter: cap.idleAfter, contextsClosed: cap.contextsClosed, changedControls: cap.changed, restore: cap.restore, failure: cap.failure ?? cap.finalFailure ?? cap.readFailure ?? null }
    const restored = cap.changed.every(n => ['acknowledged', 'unchanged'].includes(cap.restore[n]))
    if (audio) {
      await writeFile(resolve(folder, `source-separation-${stamp}.private.wav`), audio, { flag: 'wx' })
      report.file = { bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex'), metadataMd5Prefix: md5(audio.subarray(0, 1024)).slice(0, 8), metadataMd5Matches: md5(audio.subarray(0, 1024)) === cap.fileSignature }
      if (!cap.failure && restored && cap.idleAfter && cap.contextsClosed && cap.stop?.status === 'acknowledged') report.analysis = analyze(audio, cap)
    }
    report.restored = restored
  } catch (e) {
    const why = String(e?.message).split('\n')[0]
    report.failure = cap ? `Analysis or file write failed (${why}); capture and restore results are in this report` : `Helper failed (${why}); device state unknown, inspect before another command`
  }
  report.verdict = report.analysis?.verdict ?? 'INCONCLUSIVE'
  await writeFile(resolve(folder, `source-separation-${stamp}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }).catch(() => undefined)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.failure || report.capture?.failure || report.restored === false ? 1 : report.verdict === 'INCONCLUSIVE' ? 2 : 0
}
