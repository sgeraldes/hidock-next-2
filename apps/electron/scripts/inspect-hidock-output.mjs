import { openValidationClient } from './device-validation-client.mjs'
const client=await openValidationClient()
try{
  console.log(JSON.stringify(await client.evaluate(`(async()=>{
    const items=await navigator.mediaDevices.enumerateDevices();
    const sinks=items.filter(d=>d.kind==='audiooutput'&&/hidock/i.test(d.label));
    window.__ownedHiDockToneSink=sinks.find(d=>d.deviceId!=='default'&&d.deviceId!=='communications')?.deviceId??null;
    return {outputDeviceCount:items.filter(d=>d.kind==='audiooutput').length,hiDockLabelMatches:sinks.length,chosen:!!window.__ownedHiDockToneSink,
      setSinkIdAvailable:typeof AudioContext.prototype.setSinkId==='function',playbackStarted:false,rawDeviceIdsOrLabelsEmitted:false};
  })()`),null,2))
}finally{client.close()}
