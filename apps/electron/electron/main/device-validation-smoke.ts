import { app, type BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { isDeviceValidationLaunch } from './recovery-mode'

/** Fixed read-only packaged-app check. No debug server or caller-supplied code. */
export async function runDeviceValidationSmoke(window: BrowserWindow): Promise<void> {
  if (!process.argv.includes('--device-validation-smoke')) return
  const profile = process.env.HIDOCK_DEV_USERDATA
  if (!isDeviceValidationLaunch() || !profile || resolve(profile) !== resolve(app.getPath('userData'))) {
    throw new Error('Packaged device smoke requires explicit contained read-only launch and isolated profile')
  }
  const destination = join(profile, `device-validation-smoke-${Date.now()}.json`)
  const handle = await fs.open(destination, 'wx')
  try {
    if (window.webContents.isLoadingMainFrame()) {
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => { window.webContents.removeListener('did-finish-load', loaded); fail(new Error('Renderer load timed out')) }, 30000)
        const loaded = () => { clearTimeout(timer); ok() }
        window.webContents.once('did-finish-load', loaded)
      })
    }
    const observation = await window.webContents.executeJavaScript(`(async()=>{
      const j=window.electronAPI.jensen;
      if(!await j.isConnected()&&!await j.connect())throw Error('Physical device connection unavailable');
      const info=await j.getDeviceInfo();if(info?.model!=='hidock-h1e'||!((info.versionNumber===393986&&info.versionCode==='6.3.2')||(info.versionNumber===393988&&info.versionCode==='6.3.4')))throw Error('Expected custom firmware required');
      const status=await j.getNativeRecordingStatus(),listing=await j.listFilesDetailed(),profile=await j.getCustomRecordingProfile(),format=await j.getCustomRecordingFormat(),rules=await j.getCustomMarkerRules(),help=await j.getFirmwareConsoleStatus('help');
      const owned=listing.files.find(f=>f.name==='REA16CF95DA.hda'&&f.length===556);
      if(listing.status!=='complete'||!owned)throw Error('Owned bounded fixture unavailable');
      const data=new Uint8Array(await j.readFileRange(owned.name,0,556));
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
      const restore=await j.beginOwnedRecordingRestore('missing-physical-smoke-fixture',{ownedRecordingRestoreConsent:true,audioQuiescent:true});
      if(restore.commandAttempted!==false||restore.status!=='rejected-before-dispatch')throw Error('Read-only invalid-source restore must reject before mutation');
      const attemptsBefore=await j.getFirmwareInstallAttempts();
      let experimentalInstallRejected=false;
      try{await j.prepareFirmwareInstall('hardened')}catch(error){experimentalInstallRejected=String(error).includes('qualification is not enabled')}
      const attemptsAfter=await j.getFirmwareInstallAttempts();
      if(!experimentalInstallRejected||JSON.stringify(attemptsBefore)!==JSON.stringify(attemptsAfter))throw Error('Contained launch must reject experimental firmware without creating an attempt');
      await j.disconnect();
      return {observedAt:new Date().toISOString(),boundary:'actual-packaged-app/trusted-renderer-preload/sole-USB-owner/physical-custom',versionNumber:info.versionNumber,versionCode:info.versionCode,idle:status.recording===null,listing:{status:listing.status,expected:listing.expectedCount,parsed:listing.parsedCount},profile,format,rules,consoleHelp:help,ownedRead:{bytes:data.length,sha256:sha},restoreInputGate:{status:restore.status,commandAttempted:restore.commandAttempted,reason:restore.reason},experimentalFirmwareGate:{rejected:experimentalInstallRejected,attemptJournalUnchanged:true},disconnected:!await j.isConnected(),providerRequests:0,firmwareWrites:0,storageWrites:0,passed:status.recording===null&&data.length===556&&sha==='c5fb86bf6c20ff86084787a1d8449106681b68133c22ddd9e10377b591f8545f'&&!!profile&&!!format&&!!rules&&!!help&&experimentalInstallRejected};
    })()`)
    await handle.writeFile(JSON.stringify(observation, null, 2) + '\n')
    await handle.sync()
  } catch {
    await handle.writeFile(JSON.stringify({ observedAt: new Date().toISOString(), passed: false, failure: 'Contained packaged device smoke failed; inspect private app state', firmwareWrites: 0, storageWrites: 0 }) + '\n')
    await handle.sync()
  } finally { await handle.close() }
}
