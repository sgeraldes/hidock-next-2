/** Isolated runtime: real Electron/preload/IPC/services/files, fixture recording lookup. No USB or providers. */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'hidock-device-runtime-'))
const resultPath = resolve(appRoot, '../../research/rea/evidence/host-runtime-verification.json')
const mainSource = `
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'http'
import { promises as fs } from 'fs'
import { join } from 'path'
import assert from 'assert/strict'
import { createHash } from 'crypto'
import { registerDeviceRecordingHandlers } from ${JSON.stringify(join(appRoot, 'electron/main/ipc/device-recording-handlers.ts'))}
import { bindDeviceMarkerCapture } from ${JSON.stringify(join(appRoot, 'electron/main/services/device-recording-runtime.ts'))}
const root = ${JSON.stringify(root)}
const resultPath = ${JSON.stringify(resultPath)}
const serveUI = ${process.argv.includes('--serve-ui')}
app.setPath('userData', root)
app.on('window-all-closed', () => {})
const handlers = new Map()
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, handler) => { handlers.set(name, handler); originalHandle(name, handler) }
async function run() {
 await app.whenReady()
 const wav = Buffer.alloc(60)
 wav.write('RIFF'); wav.writeUInt32LE(52,4); wav.write('WAVEfmt ',8)
 wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(2,22)
 wav.writeUInt32LE(16000,24); wav.writeUInt32LE(64000,28); wav.writeUInt16LE(4,32); wav.writeUInt16LE(16,34)
 wav.write('data',36); wav.writeUInt32LE(16,40)
 ;[100,-200,300,-400,500,-600,700,-800].forEach((x,i)=>wav.writeInt16LE(x,44+i*2))
 await fs.writeFile(join(root,'capture.wav'),wav)
 const native = Buffer.alloc(20); native.write('HiDockVM'); native.writeUInt32LE(2,8); native.writeUInt32LE(0,12); native.writeUInt32LE(12345,16)
 const mp3 = Buffer.concat([Buffer.from('ID3'),Buffer.alloc(600),native])
 await fs.writeFile(join(root,'native.mp3'),mp3)
 registerDeviceRecordingHandlers()
 bindDeviceMarkerCapture(()=>({sessionId:'session-fixture',elapsedMs:12500}))
 const window = new BrowserWindow({show:false,webPreferences:{preload:join(root,'preload.cjs'),contextIsolation:true,sandbox:true}})
 await window.loadFile(join(root,'bridge.html'))
 const observations = await window.webContents.executeJavaScript(\`(async()=>{
  const api=window.electronAPI, subject={kind:'recording',id:'wav-fixture'}
  const marks=api.deviceRecordingMarkers
  const request={subject,requestId:crypto.randomUUID(),atMs:1500,label:'IPC marker',source:'manual'}
  const first=await marks.add(request), retry=await marks.add(request)
  const imported=await marks.importNative({kind:'recording',id:'mp3-fixture'})
  const unsupported=await marks.add({...request,requestId:crypto.randomUUID(),target:'native'})
  await marks.setAutomation(subject,true)
  const listed=await marks.list(subject)
  const tracks=await api.deviceAudio.exportTracks(subject.id)
  let pathRejected=false;try{await api.deviceAudio.exportTracks('arbitrary/path.wav')}catch{pathRejected=true}
  return {first,retry,imported,unsupported,listed,tracks,pathRejected}
 })()\`)
 assert.equal(observations.first.status,'accepted-local'); assert.equal(observations.retry.status,'duplicate')
 assert.equal(observations.first.marker.id,observations.retry.marker.id)
 assert.deepEqual(observations.imported.markers.map(x=>x.atMs),[0,12345])
 assert.equal(observations.unsupported.status,'unsupported'); assert.equal(observations.pathRejected,true)
 assert.equal(observations.listed.filter(x=>x.source==='action').length,1)
 for(let channel=0;channel<2;channel++) {
  const bytes=await fs.readFile(observations.tracks.tracks[channel].path)
  assert.equal(bytes.readUInt16LE(22),1); assert.equal(bytes.readUInt32LE(24),16000)
  for(let i=0;i<4;i++) assert.equal(bytes.readInt16LE(44+i*2),wav.readInt16LE(44+i*4+channel*2))
 }
 assert.deepEqual(await fs.readFile(join(root,'capture.wav')),wav)
 assert.deepEqual(await fs.readFile(join(root,'native.mp3')),mp3)
 const sidecars=await fs.readdir(join(root,'device-recording-markers'))
 for(const name of sidecars) JSON.parse(await fs.readFile(join(root,'device-recording-markers',name),'utf8'))
 const report={status:'passed',at:new Date().toISOString(),boundary:'real Electron contextBridge/preload/IPC and filesystem; fixture recording lookup and cached analysis',usbOpened:false,providerRequests:0,checks:['durable local marker','retry deduplication','native-file import milliseconds','unsupported native write','opt-in cached action event','ID-only export rejects arbitrary path','exact synchronized PCM channel samples','original WAV and MP3 unchanged','sidecar readback'],wavSha256:createHash('sha256').update(wav).digest('hex'),ui:'pending representative browser fixture'}
 await fs.writeFile(resultPath,JSON.stringify(report,null,2))
 console.log('ELECTRON_IPC_PASSED '+JSON.stringify(report))
 window.destroy()
 if (!serveUI) { app.quit(); return }
 const server=createServer(async(req,res)=>{
  try {
   if(req.method==='GET' && req.url==='/') {res.setHeader('Content-Type','text/html');res.end(await fs.readFile(join(root,'ui.html')));return}
   if(req.method==='GET' && req.url==='/ui.js') {res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(join(root,'ui.js')));return}
   if(req.method==='POST' && req.url==='/finish') {report.ui='observed through representative built React controls with production marker/export services over fixture HTTP transport';await fs.writeFile(resultPath,JSON.stringify(report,null,2));res.end('closed');server.close(()=>app.quit());return}
   if(req.method==='POST' && req.url==='/invoke') {
    let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('Too large')}
    const {channel,args}=JSON.parse(body); const handler=handlers.get(channel);if(!handler)throw Error('Unknown fixture channel')
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:await handler({},...args)}));return
   }
   res.statusCode=404;res.end('not found')
  } catch(error){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:error.message}))}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 console.log('FIXTURE_URL http://127.0.0.1:'+server.address().port+'/')
}
run().catch(async error=>{console.error(error);app.exit(1)})
`
const plugins = [{ name: 'isolated-recording-lookup', setup(builder) {
  builder.onResolve({ filter: /^\.\/(database|recording-eligibility|timeline-analysis)$/ }, args => ({ path: args.path, namespace: 'fixture-data' }))
  builder.onLoad({ filter: /.*/, namespace: 'fixture-data' }, args => ({ loader: 'js', contents:
    args.path === './database' ? `import {join} from 'path'; export function getRecordingById(id){const file=id==='wav-fixture'?'capture.wav':id==='mp3-fixture'?'native.mp3':null;return file?{id,on_local:1,file_path:join(${JSON.stringify(root)},file),duration_seconds:30,location:'local',deleted_at:null}:undefined}` :
    args.path === './recording-eligibility' ? 'export const isRecordingEligible=()=>true' :
    'export const getTimelineAnalysis=()=>({eventMarkers:[{id:"action-fixture",kind:"action",atSec:15,label:"Cached fixture action"}]})'
  }))
} }]
await build({ stdin: { contents: mainSource, resolveDir: appRoot, sourcefile: 'device-runtime-fixture.ts', loader: 'ts' }, outfile: join(root, 'main.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'], plugins })
await build({ entryPoints: [join(appRoot, 'electron/preload/index.ts')], outfile: join(root, 'preload.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] })
const uiSource = `import React from 'react';import{createRoot}from'react-dom/client';import{DeviceRecordingMarkers,DeviceRecordingTrackExport}from${JSON.stringify(join(appRoot,'src/components/DeviceRecordingMarkers.tsx'))};async function call(channel,...args){const r=await fetch('/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,args})});const x=await r.json();if(x.error)throw Error(x.error);return x.value}window.electronAPI={deviceRecordingMarkers:{list:s=>call('device-markers:list',s),importNative:s=>call('device-markers:import-native',s),getSettings:s=>call('device-markers:get-settings',s),setAutomation:(s,e)=>call('device-markers:set-automation',s,e),add:r=>call('device-markers:add',r)},deviceAudio:{exportTracks:id=>call('device-audio:export-tracks',id)}};createRoot(document.getElementById('root')).render(<main><h1>Isolated HiDock recording controls</h1><p>Fixture data. No USB connection or provider.</p><DeviceRecordingMarkers subject={{kind:'recording',id:'mp3-fixture'}} durationMs={30000} atMs={2500} nativeImportAvailable onSeek={ms=>document.getElementById('seek').textContent='Seek '+ms+' ms'}/><p id="seek">Playback position 2500 ms</p><DeviceRecordingTrackExport recordingId="wav-fixture"/></main>);`
await build({ stdin: { contents: uiSource, resolveDir: appRoot, loader: 'tsx', sourcefile: 'device-controls-fixture.tsx' }, outfile: join(root, 'ui.js'), platform: 'browser', format: 'iife', bundle: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
await writeFile(join(root,'bridge.html'),'<html><title>Isolated IPC fixture</title></html>')
await writeFile(join(root,'ui.html'),'<!doctype html><html><title>HiDock recording fixture</title><style>body{font-family:system-ui;background:#10151d;color:#eee;max-width:850px;margin:40px auto}section{border:1px solid #536078;padding:20px;margin:20px 0}input,button{font:inherit;margin:6px;padding:6px}li{margin:8px}p{line-height:1.5}button{cursor:pointer}</style><div id="root"></div><script src="/ui.js"></script></html>')
const fixtureEnvironment = { ...process.env }
delete fixtureEnvironment.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [join(root, 'main.cjs')], { cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnvironment })
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
const code = await new Promise(resolveExit => child.once('exit', resolveExit))
// Delete only the unique fixture directory created by this invocation.
if (resolve(root).startsWith(resolve(tmpdir()) + sep) && /^hidock-device-runtime-/.test(root.split(sep).at(-1))) await rm(root, { recursive: true, force: true })
process.exitCode = code ?? 1
