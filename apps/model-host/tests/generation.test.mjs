import { execFileSync } from 'node:child_process'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {validateGenerationRequest,generationJsonFetch,generationReadiness,generationFingerprint,generationPaths,GENERATION_VERSION} from '../src/generation.mjs'
const request={expectedModelVersion:GENERATION_VERSION,messages:[{role:'user',content:'Resume la reunión'}],maxOutputTokens:64,jsonMode:true}
test('generation is separately pinned; bounds cannot be changed by request',()=>{
 const body=validateGenerationRequest({...request,exe:'evil',device:'cpu'})
 assert.equal(body.max_tokens,64);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.exe,undefined)
 for(const change of [{expectedModelVersion:'other'},{maxOutputTokens:2049},{temperature:NaN},{jsonMode:'yes'},{messages:[{role:'tool',content:'x'}]},{messages:[{role:'user',content:'x'.repeat(64001)}]}])assert.throws(()=>validateGenerationRequest({...request,...change}))
})
test('actual loopback protocol caps native responses and honors cancellation',async()=>{
 const server=createServer((req,res)=>{if(req.url==='/huge'){res.end('x'.repeat(1048577))}else if(req.url==='/slow'){setTimeout(()=>res.end('{}'),100)}else if(req.url==='/bad'){res.writeHead(503);res.end('{}')}else res.end(JSON.stringify({usage:{prompt_tokens:4,completion_tokens:2}}))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
 try{assert.equal((await generationJsonFetch(base,{},AbortSignal.timeout(1000))).usage.prompt_tokens,4)
 await assert.rejects(generationJsonFetch(base+'/huge',{},AbortSignal.timeout(1000)),/limit/)
 await assert.rejects(generationJsonFetch(base+'/bad',{},AbortSignal.timeout(1000)),/503/)
 await assert.rejects(generationJsonFetch(base+'/slow',{},AbortSignal.timeout(10)))
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})
test('readiness requires CUDA clean teardown and includes runtime DLL changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'generation-test-'));const p=generationPaths(root)
 try{assert.equal((await generationReadiness(root)).ready,false)
 await mkdir(dirname(p.model),{recursive:true});await mkdir(dirname(p.exe),{recursive:true});await writeFile(p.model,'model');await writeFile(p.exe,'exe');const dll=join(dirname(p.exe),'ggml-cuda.dll');await writeFile(dll,'dll')
 const proof={modelVersion:GENERATION_VERSION,device:'cuda',cleanShutdown:true,fingerprint:await generationFingerprint(root)}
 await writeFile(p.proof,JSON.stringify(proof));assert.equal((await generationReadiness(root)).ready,true)
 await writeFile(p.proof,JSON.stringify({...proof,device:null}));assert.equal((await generationReadiness(root)).ready,false)
 await writeFile(p.proof,JSON.stringify(proof));await writeFile(dll,'changed-dll');assert.equal((await generationReadiness(root)).ready,false)
 }finally{await rm(root,{recursive:true,force:true})}
})

// A Python subprocess: its start-up alone took 5.6 s on the CI Windows runner
// on 27-oct-2026, past vitest's 5 s default.
test('pinned downloader resumes and preserves transient partials',{timeout:60_000},()=>{execFileSync('python',['tests/test_prepare_generation.py'],{cwd:new URL('..',import.meta.url),stdio:'pipe',windowsHide:true})})
