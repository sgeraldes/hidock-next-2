// @vitest-environment node
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'https'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
const state = vi.hoisted(() => ({ config: { transcription: { modelHostUrl: '', modelHostToken: 'test-only', modelHostCertificatePem: '' }, brains: { enabled: { 'model-host-generate': true }, modelHostGeneration: { modelVersion: 'fixture-version' } } } }))
vi.mock('../../config', () => ({ getConfig: () => state.config }))
import { ModelHostGenerateBrain } from '../model-host-generate-brain'
import { createHarnessUsageCollector } from '../harness-usage'
let server: Server, directory: string, requests: string[], version: string, status: number, unknownUsage: boolean, exclude: boolean
let ready: boolean, invalidJson: boolean, mutate: boolean
const brain = new ModelHostGenerateBrain()
const messages = [{role: 'user' as const, content: 'Synthetic fixture'}]
beforeAll(async () => {
 directory=mkdtempSync(join(tmpdir(),'hidock-generation-tls-'))
 execFileSync('python',[resolve('../model-host/src/provision_tls.py'),directory],{windowsHide:true})
 const cert=readFileSync(join(directory,'host-certificate.pem'),'utf8'); state.config.transcription.modelHostCertificatePem=cert
 server=createServer({cert,key:readFileSync(join(directory,'host-private-key.pem'))},async(req,res)=>{
  expect(req.headers.authorization).toBe('Bearer test-only');requests.push(req.method+' '+req.url);res.setHeader('content-type','application/json')
  if(req.url==='/health'){exclude=true;res.end(JSON.stringify({textGeneration:{ready,model:'fixture-model',modelVersion:version,maxContextTokens:8192,maxOutputTokens:2048}}));return}
  let body='';for await(const chunk of req)body+=chunk.toString();const input=JSON.parse(body)
  expect(input.expectedModelVersion).toBe('fixture-version');expect(input.messages).toEqual(messages)
  if(mutate)state.config.brains.modelHostGeneration.modelVersion='changed'
  res.statusCode=status;res.end(JSON.stringify({text:invalidJson?'not json':'{"answer":"fixture"}',model:'fixture-model',modelVersion:version,inputTokens:unknownUsage?null:12,outputTokens:unknownUsage?null:6,device:'cpu'}))
 });await new Promise<void>(r=>server.listen(0,r));state.config.transcription.modelHostUrl=`https://localhost:${(server.address() as {port:number}).port}`
})
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(directory,{recursive:true,force:true})})
beforeEach(()=>{requests=[];version='fixture-version';status=200;unknownUsage=false;exclude=false;ready=true;invalidJson=false;mutate=false;state.config.brains.enabled['model-host-generate']=true;state.config.brains.modelHostGeneration.modelVersion='fixture-version'})
it('uses authenticated pinned TLS and records measured usage',async()=>{const c=createHarnessUsageCollector();expect(await c.run(()=>brain.chat(messages,{json:true}))).toBe('{"answer":"fixture"}');expect(c.total()).toMatchObject({inputTokens:12,outputTokens:6,calls:1});expect(requests).toEqual(['GET /health','POST /v1/generate'])})
it('keeps missing usage unknown',async()=>{unknownUsage=true;const c=createHarnessUsageCollector();await c.run(()=>brain.generate(messages));expect(c.total()).toBeNull()})
it('refuses unavailable capability before upload',async()=>{ready=false;await expect(brain.generate(messages)).rejects.toThrow('not ready');expect(requests).toEqual(['GET /health'])})
it('refuses changed model before upload',async()=>{version='changed';await expect(brain.generate(messages)).rejects.toThrow('before text upload');expect(requests).toEqual(['GET /health'])})
it('requires explicit enablement',async()=>{state.config.brains.enabled['model-host-generate']=false;await expect(brain.generate(messages)).rejects.toThrow('Enable and bind');expect(requests).toEqual([])})
it('bounds input before network',async()=>{await expect(brain.generate([{role:'user',content:'x'.repeat(65537)}])).rejects.toThrow('bounded input');expect(requests).toEqual([])})
it('bounds output before upload',async()=>{await expect(brain.generate(messages,{maxTokens:2049})).rejects.toThrow('validated limits');expect(requests).toEqual(['GET /health'])})
it('rechecks eligibility after metadata',async()=>{expect(await brain.generate(messages,{shouldGenerate:()=>!exclude})).toBeNull();expect(requests).toEqual(['GET /health'])})
it('never retries failed HTTP requests',async()=>{status=503;await expect(brain.generate(messages)).rejects.toThrow('503');expect(requests).toEqual(['GET /health','POST /v1/generate'])})
it('rejects invalid JSON for structured callers',async()=>{invalidJson=true;await expect(brain.generate(messages,{json:true})).rejects.toThrow('invalid JSON')})
it('discards response after model binding changes',async()=>{mutate=true;await expect(brain.generate(messages)).rejects.toThrow('selection changed during inference')})
it('honors caller cancellation before network',async()=>{const c=new AbortController();c.abort();await expect(brain.generate(messages,{signal:c.signal})).rejects.toThrow();expect(requests).toEqual([])})
it('rejects an untrusted TLS certificate before transmitting messages',async()=>{
 const saved=state.config.transcription.modelHostCertificatePem
 state.config.transcription.modelHostCertificatePem=''
 try { await expect(brain.generate(messages)).rejects.toThrow();expect(requests).toEqual([]) }
 finally { state.config.transcription.modelHostCertificatePem=saved }
})
