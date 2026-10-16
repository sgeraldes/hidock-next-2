/** Root-owned UI acceptance through the running app's sole device owner. */
import { openValidationClient } from './device-validation-client.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const c = await openValidationClient(), stamp = Date.now()
const folder = resolve('node_modules/.cache/completion630-runtime')
const evidence = { at: new Date().toISOString(), boundary: 'rendered-Device-panel/preload/sole-USB-owner/current-custom-393986', firmwareWrites: 0, providerRequests: 0, deletes: 0, cases: [] }
const wait = ms => new Promise(ok => setTimeout(ok, ms))
async function click(id) {
  await c.evaluate(`(()=>{const el=document.querySelector('[data-testid="${id}"]');if(!el||el.disabled)throw Error('Control unavailable: ${id}');el.click()})()`)
}
async function settled() {
  for(let i=0;i<60;i++) {
    if(await c.evaluate(`!!document.querySelector('[data-testid="native-refresh"]')&&!document.querySelector('[data-testid="native-refresh"]').disabled`)) return
    await wait(200)
  }
  throw Error('Panel did not settle')
}
async function input(id, value) {
  await c.evaluate(`(()=>{const el=document.querySelector('[data-testid="${id}"]');if(!el||el.disabled)throw Error('Input unavailable');const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})()`)
}
let original, owned = null
try {
  await mkdir(folder,{recursive:true})
  original = await c.evaluate(`(async()=>{const j=window.electronAPI.jensen,s=await j.getState(),cfg=await window.electronAPI.config.get();if(!s.connected||s.versionNumber!==393986||(await j.getNativeRecordingStatus()).recording!==null||cfg.data?.device?.autoDownload!==false)throw Error('Expected isolated idle custom dock required');return {profile:await j.getCustomRecordingProfile(),format:await j.getCustomRecordingFormat(),rules:await j.getCustomMarkerRules()}})()`)
  await c.evaluate(`location.hash='/sync'`)
  await wait(1500);await settled();await click('native-refresh');await wait(300);await settled()
  for(const spec of [
    {mode:'mp3',gain1:100,gain2:100,auto:false},
    {mode:'wav',gain1:100,gain2:0,auto:true},
    {mode:'wav',gain1:0,gain2:100,auto:false}
  ]) {
    const {mode,auto}=spec,caseId=`${mode}-g${spec.gain1}-${spec.gain2}`
    await input('native-format',mode)
    if(mode==='mp3') await input('native-bitrate','0')
    await input('native-gain-1',spec.gain1);await input('native-gain-2',spec.gain2)
    await input('native-rule-lane','2');await input('native-rule-threshold','1')
    if(await c.evaluate(`document.querySelector('[data-testid="native-rules-enabled"]').checked`)!==auto) await click('native-rules-enabled')
    await click('native-apply');await wait(300);await settled()
    const read = await c.evaluate(`(async()=>{const j=window.electronAPI.jensen;return {profile:await j.getCustomRecordingProfile(),format:await j.getCustomRecordingFormat(),rules:await j.getCustomMarkerRules()}})()`)
    if(read.format?.format!==mode||read.profile?.profile!==0||read.profile?.gainLeftQ15!==spec.gain1*32768/100||read.profile?.gainRightQ15!==spec.gain2*32768/100||read.rules?.enabled!==auto) throw Error('Rendered settings did not reach dock')
    await click('native-toggle');await wait(1000);await settled()
    owned = await c.evaluate(`(async()=>{const j=window.electronAPI.jensen,s=await j.getNativeRecordingStatus();if(!s.recording)throw Error('UI start did not create recording');await j.protectNativeVerificationRecording(s.recording);return s.recording})()`)
    await writeFile(resolve(folder,`native-panel-${stamp}-${caseId}.ownership.private.json`),JSON.stringify({owned,read,at:new Date().toISOString()}),{flag:'wx'})
    const settingsDisabled=await c.evaluate(`document.querySelector('[data-testid="native-apply"]').disabled`)
    if(!settingsDisabled) throw Error('Settings not disabled during recording')
    if(mode==='wav') {
      if(auto)await wait(10000)
      await c.evaluate(`(async()=>{const devices=await navigator.mediaDevices.enumerateDevices(),sink=devices.find(d=>d.kind==='audiooutput'&&/hidock/i.test(d.label)&&d.deviceId!=='default'&&d.deviceId!=='communications');if(!sink)throw Error('Explicit dock output unavailable');const ctx=new AudioContext({sampleRate:48000});window.__nativePanelTone=ctx;await ctx.setSinkId(sink.deviceId);await ctx.resume();const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=1000;g.gain.value=0.01;o.connect(g);g.connect(ctx.destination);o.start();await new Promise(ok=>setTimeout(ok,4500));o.stop();await ctx.close();window.__nativePanelTone=null})()`)
      await wait(auto?4000:14000)
    }else await wait(18000)
    await click('native-marker');await wait(400);await settled()
    await c.evaluate(`document.querySelector('[data-testid="native-recording-panel"]').scrollIntoView({block:'start'})`)
    const clip=await c.evaluate(`(()=>{const r=document.querySelector('[data-testid="native-recording-panel"]').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`)
    const screenshot=await c.call('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true})
    await writeFile(resolve(folder,`native-panel-${stamp}-${caseId}.png`),Buffer.from(screenshot.data,'base64'),{flag:'wx'})
    await click('native-toggle');await wait(1800);await settled()
    if(!(await c.evaluate(`(async()=> (await window.electronAPI.jensen.getNativeRecordingStatus()).recording===null)()`))) throw Error('UI stop did not finalize recording')
    const download=await c.evaluate(`(async()=>{const j=window.electronAPI.jensen,n=${JSON.stringify(owned)},l=await j.listFilesDetailed(),f=l.files?.find(f=>f.name===n);if(l.status!=='complete'||!f||f.length<1000||f.length>2097152)throw Error('Owned file unavailable: listing='+l.status+',matched='+!!f+',bytes='+(f?.length??0));const b=new Uint8Array(f.length);for(let i=0;i<b.length;i+=1048576)b.set(new Uint8Array(await j.readFileRange(n,i,Math.min(1048576,b.length-i))),i);return {bytes:Array.from(b),signature:f.signature}})()`)
    const bytes=Buffer.from(download.bytes),path=resolve(folder,`native-panel-${stamp}-${caseId}.private.${mode}`)
    await writeFile(path,bytes,{flag:'wx'})
    const at=bytes.lastIndexOf(Buffer.from('HiDockVM')),markers=[]
    if(at>=0&&at+12<=bytes.length){const n=bytes.readUInt32LE(at+8);if(n<=512&&at+12+n*4===bytes.length)for(let i=0;i<n;i++)markers.push(bytes.readUInt32LE(at+12+i*4))}
    const decoded=spawnSync(ffmpeg,['-hide_banner','-v','info','-i',path,'-map','0:a:0','-f','null','-'],{encoding:'utf8',maxBuffer:1048576})
    const stream=decoded.stderr?.split(/\r?\n/).find(line=>/Stream #0:0: Audio:/.test(line))?.trim()
    const record={caseId,format:mode,readback:read,settingsDisabled,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),metadataMd5Matches:createHash('md5').update(bytes.subarray(0,1024)).digest('hex')===download.signature,markersMs:markers,decodeExit:decoded.status,stream}
    if(mode==='wav') {let nonzero1=0,nonzero2=0;const end=44+bytes.readUInt32LE(40);for(let i=44;i+4<=end;i+=4){if(bytes.readInt16LE(i))nonzero1++;if(bytes.readInt16LE(i+2))nonzero2++}record.channelSamples={nonzero1,nonzero2};record.passed=bytes.readUInt16LE(22)===2&&(spec.gain1===0?nonzero1===0&&nonzero2>0:nonzero1>0&&nonzero2===0)&&(auto?markers.length>=2:markers.length===1)}
    else record.passed=stream?.includes('mp3')&&stream.includes('stereo')&&stream.includes('64 kb/s')&&markers.length===1
    record.passed=!!record.passed&&record.metadataMd5Matches&&decoded.status===0
    evidence.cases.push(record);owned=null
    if(!record.passed)throw Error('Produced audio failed acceptance')
  }
  evidence.passed=true
}catch(e){evidence.failure=e.message;evidence.passed=false}
finally {
  if(owned) await c.evaluate(`(async()=>{const j=window.electronAPI.jensen,s=await j.getNativeRecordingStatus();if(s.recording===${JSON.stringify(owned)})await j.toggleNativeRecording({requestId:crypto.randomUUID(),expectedRecording:s.recording})})()`).catch(()=>{})
  await wait(1500)
  if(original) evidence.restored=await c.evaluate(`(async()=>{const j=window.electronAPI.jensen,o=${JSON.stringify(original)};if((await j.getNativeRecordingStatus()).recording!==null)return false;await j.setCustomRecordingProfile({profile:o.profile.profile,gainLeftQ15:o.profile.gainLeftQ15,gainRightQ15:o.profile.gainRightQ15});await j.setCustomRecordingFormat(o.format.format);await j.setCustomMarkerRules({enabled:o.rules.enabled,lane:o.rules.lane,meanMagnitudeThreshold:o.rules.meanMagnitudeThreshold});const p=await j.getCustomRecordingProfile(),f=await j.getCustomRecordingFormat(),r=await j.getCustomMarkerRules();return p?.profile===o.profile.profile&&p.gainLeftQ15===o.profile.gainLeftQ15&&p.gainRightQ15===o.profile.gainRightQ15&&f?.format===o.format.format&&r?.enabled===o.rules.enabled&&r.lane===o.rules.lane&&r.meanMagnitudeThreshold===o.rules.meanMagnitudeThreshold})()`).catch(()=>false)
  evidence.passed=!!evidence.passed&&evidence.restored===true
  if(evidence.restored)await click('native-refresh').catch(()=>{})
  c.close();const out=resolve(folder,`native-audio-panel-${stamp}.json`);await writeFile(out,JSON.stringify(evidence,null,2),{flag:'wx'});console.log(JSON.stringify({...evidence,evidencePath:out},null,2))
}
if(!evidence.passed)process.exitCode=1
