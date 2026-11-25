import { openValidationClient } from './device-validation-client.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const count=Number(process.argv[2]??8180)
if(![52,8179,8180,8181,16360].includes(count))throw Error('Only qualified boundary counts are accepted')
const client=await openValidationClient()
const directory=resolve('node_modules/.cache/completion630-runtime')
await mkdir(directory,{recursive:true})
const evidencePath=resolve(directory,`prefix-${count}-${Date.now()}.json`)
const evidence={observedAt:new Date().toISOString(),boundary:'physical-stock/app-owner',count,observations:[]}
try {
  await client.evaluate(`(async()=>{const j=window.electronAPI.jensen;await j.stopFileSystem();const l=await j.listFilesDetailed();if(l.status!=='complete')throw Error('Incomplete source listing');const f=l.files.find(v=>v.length>16360);if(!f)throw Error('No completed source');window.__prefixBoundary={count:${count},stage:'waiting',done:false};j.readFilePrefix(f.name,${count}).then(v=>{window.__prefixBoundary={count:${count},stage:'completed',done:true,bytes:new Uint8Array(v).length}},()=>{window.__prefixBoundary={count:${count},stage:'failed',done:true}});return {started:true}})()`)
  const observations=evidence.observations
  for(let step=0;step<9;step++){
    const observation=await client.evaluate(`({result:window.__prefixBoundary,diagnostics:window.electronAPI.jensen.getProtocolDiagnostics()})`)
    // getProtocolDiagnostics returns a promise through IPC.
    observation.diagnostics=await client.evaluate('window.electronAPI.jensen.getProtocolDiagnostics()')
    observations.push(observation)
    await writeFile(evidencePath,JSON.stringify(evidence,null,2))
    if(observation.result.done)break
    await new Promise(r=>setTimeout(r,1000))
  }
  const last=observations.at(-1)
  if(!last.result.done){await client.evaluate('(void window.electronAPI.jensen.cancelDownload().catch(()=>undefined),true)');await new Promise(r=>setTimeout(r,1000));observations.push({result:await client.evaluate('window.__prefixBoundary'),diagnostics:await client.evaluate('window.electronAPI.jensen.getProtocolDiagnostics()')})}
  await writeFile(evidencePath,JSON.stringify(evidence,null,2))
  const final=evidence.observations.at(-1)
  console.log(JSON.stringify({count,result:final.result,current:final.diagnostics.currentCommand,lastFault:final.diagnostics.lastFault,events:final.diagnostics.events.slice(-8)},null,2))
  if(!final.result.done||final.result.stage!=='completed')process.exitCode=1
} finally {client.close()}
