// Isolated Electron: temporary userData and generated oscillator sources only.
const fs=require('fs'),path=require('path'),cp=require('child_process'),ts=require(path.resolve('node_modules/typescript')),esbuild=require(path.resolve('node_modules/esbuild'));
(async()=>{
const folder=fs.mkdtempSync(path.join(require('os').tmpdir(),'pc-recorder-unload-'));
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const codes={filename:compile('src/shared/pc-recording.ts'),recorder:compile('electron/main/services/pc-recorder.ts'),ipc:compile('electron/main/ipc/pc-recorder-handlers.ts'),app:compile('electron/main/ipc/app-handlers.ts')};
const built=await esbuild.build({stdin:{contents:"import {usePcRecorderStore,installPcRecorderCloseGuard} from './src/store/usePcRecorderStore';window.recorderStore=usePcRecorderStore;window.installGuard=installPcRecorderCloseGuard;",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife',alias:{'@':path.resolve('src')}});
const renderer=`(async()=>{
 const {ipcRenderer}=require('electron');window.electronAPI={pcRecorder:{start:()=>ipcRenderer.invoke('pc-recorder:start'),append:(...args)=>ipcRenderer.invoke('pc-recorder:append',...args),finish:(...args)=>ipcRenderer.invoke('pc-recorder:finish',...args),resumeUnload:()=>ipcRenderer.invoke('pc-recorder:resume-unload'),onStopRequested:cb=>{const f=()=>cb();ipcRenderer.on('pc-recorder:request-stop',f);return ()=>ipcRenderer.removeListener('pc-recorder:request-stop',f)}}};
 ${built.outputFiles[0].text}
 const context=new AudioContext();await context.resume();window.sources=[400,1000].map(f=>{const o=context.createOscillator();o.frequency.value=f;const d=context.createMediaStreamDestination();o.connect(d);o.start();return {o,stream:d.stream}});
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>window.sources[0].stream,getDisplayMedia:async()=>window.sources[1].stream}});
 window.installGuard();window.addEventListener('beforeunload',()=>console.log('BOUNDARY-beforeunload'));
 window.recorderStore.subscribe(s=>console.log('BOUNDARY-state '+s.status+' '+s.error));
 await window.recorderStore.getState().start();await new Promise(r=>setTimeout(r,1700));return window.recorderStore.getState().status;
})()`;
const main=`const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),path=require('path'),vm=require('vm');app.setPath('userData',${JSON.stringify(folder)});app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const events=[],imports=[];app.on('window-all-closed',()=>{});
function load(code,req){const m={exports:{}};vm.runInNewContext(code,{exports:m.exports,module:m,require:req,Uint8Array,performance,setTimeout,clearTimeout,console,process});return m.exports;}
const filename=load(${JSON.stringify(codes.filename)},require);
const recorder=load(${JSON.stringify(codes.recorder)},p=>p.includes('pc-recording')?filename:require(p));
const electron={app,BrowserWindow,desktopCapturer:{},ipcMain:{handle:(name,fn)=>ipcMain.handle(name,(e,...args)=>{events.push(name);return fn(e,...args)})}};
const handlers=load(${JSON.stringify(codes.ipc)},p=>p==='electron'?electron:p.includes('pc-recorder')?recorder:p.includes('external-recording-import')?{importExternalRecording:p=>{imports.push({bytes:fs.statSync(p).size});events.push('IMPORTED');return {success:true}}}:p.includes('pc-recording-duration')?{measurePcRecordingDuration:async()=>null}:require(p));
handlers.registerPcRecorderHandlers();
const appHandlers=load(${JSON.stringify(codes.app)},p=>p==='electron'?electron:p==='@electron-toolkit/utils'?{is:{dev:true}}:p.includes('qa-logs')?{setQaLogsEnabled:()=>{}}:require(p));appHandlers.registerAppHandlers();
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});
handlers.configurePcRecorderUnload(w);
w.webContents.on('console-message',e=>{if(e.message.startsWith('BOUNDARY-'))events.push(e.message);else if(e.level==='error')console.error(e.message)});
w.webContents.on('did-start-navigation',()=>events.push('NAVIGATION'));w.webContents.on('will-prevent-unload',()=>events.push('PREVENTED'));w.on('closed',()=>events.push('CLOSED'));
const html=path.join(${JSON.stringify(folder)},'blank.html');fs.writeFileSync(html,'<html><body></body></html>');await w.loadFile(html);
await w.webContents.executeJavaScript(${JSON.stringify(renderer)},true);events.push('OPERATION_REQUEST');${process.argv[2] === 'close' ? 'w.close()' : process.argv[2] === 'restart' ? `await w.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('app:restart')")` : 'w.webContents.reload()'};
setTimeout(()=>{const staging=path.join(${JSON.stringify(folder)},'pc-recordings');console.log('PC_UNLOAD_RESULT='+JSON.stringify({events,imports,files:fs.readdirSync(staging).map(n=>({name:n,size:fs.statSync(path.join(staging,n)).size})),destroyed:w.isDestroyed()}));app.exit(0)},4500);
}).catch(e=>{console.error(e);app.exit(1)});`;
const scriptPath=path.join(folder,'main.cjs');fs.writeFileSync(scriptPath,main);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const executable=path.resolve('node_modules/electron/dist',fs.readFileSync('node_modules/electron/path.txt','utf8').trim());
const result=cp.spawnSync(executable,[scriptPath],{env,windowsHide:true,stdio:['ignore','pipe','inherit'],encoding:'utf8',timeout:20000});console.log(result.stdout);if(result.status!==0) process.exitCode=1;fs.rmSync(folder,{recursive:true});
})().catch(e=>{console.error(e);process.exitCode=1});
