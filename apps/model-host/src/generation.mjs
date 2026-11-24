import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, freemem, totalmem } from 'node:os'
import { readFile, stat, readdir } from 'node:fs/promises'
import { hasNativeCudaProcess } from './realtime-native-runtime.mjs'
export const GENERATION_MODEL = 'Qwen/Qwen3-8B-GGUF'
export const GENERATION_VERSION = '7c41481f57cb95916b40956ab2f0b139b296d974:Q4_K_M:llama-b11560'
export const GENERATION_SHA = 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785'
export function generationPaths(root) {
  return { model: join(root,'models','qwen3-8b-gguf','Qwen3-8B-Q4_K_M.gguf'),
    exe: join(root,'runtime','generation','llama-server.exe'), proof: join(root,'generation-ready.json') }
}
export function validateGenerationRequest(r) {
  if (!r || r.expectedModelVersion !== GENERATION_VERSION) throw Error('Generation model version mismatch')
  if (!Array.isArray(r.messages) || !r.messages.length || r.messages.length > 64 ||
      r.messages.some(m => !['system','user','assistant'].includes(m.role) || typeof m.content !== 'string') ||
      r.messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0)>64000) throw Error('Invalid or oversized generation messages')
  const max = r.maxOutputTokens ?? 1024
  const temperature = r.temperature ?? .7
  if (!Number.isInteger(max) || max<1 || max>2048 || !Number.isFinite(temperature) || temperature<0 || temperature>2 ||
      (r.jsonMode !== undefined && typeof r.jsonMode !== 'boolean')) throw Error('Invalid generation limits')
  return { messages:r.messages, max_tokens:max, temperature, stream:false, top_p:.8, top_k:20,
    min_p:0, presence_penalty:1.5, chat_template_kwargs:{enable_thinking:false},
    ...(r.jsonMode ? {response_format:{type:'json_object'}} : {}) }
}
export async function generationFingerprint(root) {
  const p=generationPaths(root), source=dirname(fileURLToPath(import.meta.url)), files=[p.model, ...((await readdir(dirname(p.exe))).filter(n=>/\.(dll|exe)$/i.test(n)).sort().map(n=>join(dirname(p.exe),n))),join(source,'generation_supervisor.py'),join(source,'generation.mjs')]
  return JSON.stringify(await Promise.all(files.map(async f=>{const s=await stat(f);return [f,s.size,s.mtimeMs]})))
}
export async function generationReadiness(root) {
  const base={ready:false,model:GENERATION_MODEL,modelVersion:GENERATION_VERSION,maxContextTokens:8192,maxOutputTokens:2048}
  try { const p=JSON.parse(await readFile(generationPaths(root).proof,'utf8'))
    return {...base,ready:p.modelVersion===GENERATION_VERSION && p.device==='cuda' && p.cleanShutdown===true && p.fingerprint===await generationFingerprint(root)}
  } catch {return base}
}
export async function generationJsonFetch(url, options, signal) {
  const response=await fetch(url,{...options,signal})
  const reader=response.body.getReader(); let bytes=0;const chunks=[]
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576){await reader.cancel();throw Error('Generation response exceeds limit')}chunks.push(Buffer.from(value))}
  if(!response.ok)throw Error(`Native generation HTTP ${response.status}`)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** Caller owns shared heavy lane. No resident model survives this request. */
export async function runGeneration(request,{root,pythonPath,workerPath,signal,cpuPercent=50,validation=false}) {
  const body=validateGenerationRequest(request)
  if(!validation && !(await generationReadiness(root)).ready)throw Error('Generation model is not prepared')
  if(process.platform!=='win32')throw Error('Windows Job enforcement required')
  const memoryMb=Math.floor(Math.min(16384,totalmem()/1048576*.25,freemem()/1048576*.5))
  if(memoryMb<8192)throw Error('Insufficient generation memory budget')
  const controller=new AbortController(), abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)controller.abort()
  const timer=setTimeout(abort,120000), p=generationPaths(root)
  let child, exited=false, stop=false, buffer='', diag={}, result, done
  try {
    const probe=createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(0,'127.0.0.1',r)})
    const port=probe.address().port;await new Promise(r=>probe.close(r));controller.signal.throwIfAborted()
    child=spawn(pythonPath,['-S',join(dirname(fileURLToPath(import.meta.url)),'generation_supervisor.py'),'--policy',join(dirname(workerPath),'resource_policy.py'),'--exe',p.exe,'--model',p.model,'--port',String(port)],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',HIDOCK_WORKER_MEMORY_MB:String(memoryMb),HIDOCK_DIARIZATION_THREADS:String(Math.max(1,Math.floor(cpus().length*Math.max(1,Math.min(50,Number.isFinite(cpuPercent)?cpuPercent:50))/100))),HIDOCK_WORKER_PRIORITY:'below-normal'}})
    done=new Promise(resolve=>{child.once('close',code=>{exited=true;diag.childExitCode=code;resolve()});child.once('error',e=>{diag.spawnError=e.message;resolve()})})
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{})
    child.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>16000){diag.protocolError=true;controller.abort();return}let i;while((i=buffer.indexOf('\n'))>=0){try{Object.assign(diag,JSON.parse(buffer.slice(0,i)))}catch{diag.protocolError=true;controller.abort()}buffer=buffer.slice(i+1)}})
    controller.signal.addEventListener('abort',()=>child.stdin.end(),{once:true})
    const base=`http://127.0.0.1:${port}`
    for(;;){controller.signal.throwIfAborted();if(exited||diag.spawnError)throw Error('Generation runtime exited during load');try{await generationJsonFetch(base+'/health',{},AbortSignal.any([controller.signal,AbortSignal.timeout(1000)]));break}catch(e){controller.signal.throwIfAborted();await new Promise(r=>setTimeout(r,150))}}
    const csv=await new Promise(resolve=>execFile('nvidia-smi',['--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader'],{windowsHide:true,timeout:2000,maxBuffer:65536},(e,out)=>resolve(e?'':out)))
    if(!hasNativeCudaProcess(csv,diag.nativePid))throw Error('Generation CUDA process attribution unavailable')
    // Actual tokenizer count includes chat template. Never truncate silently.
    const templated=await generationJsonFetch(base+'/apply-template',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:body.messages,chat_template_kwargs:{enable_thinking:false}})},controller.signal)
    const tokens=await generationJsonFetch(base+'/tokenize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:templated.prompt,add_special:true})},controller.signal)
    if(typeof templated.prompt!=='string')throw Error('Invalid native chat template response')
    if(!Array.isArray(tokens.tokens)||tokens.tokens.length+body.max_tokens>8192)throw Error('Generation context exceeds 8192 tokens')
    const data=await generationJsonFetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},controller.signal)
    const text=data.choices?.[0]?.message?.content, usage=data.usage
    if(typeof text!=='string'||!text.trim()||!Number.isInteger(usage?.prompt_tokens)||!Number.isInteger(usage?.completion_tokens)||usage.prompt_tokens<0||usage.completion_tokens<0||usage.completion_tokens>body.max_tokens)throw Error('Invalid native generation result/usage')
    if(request.jsonMode)JSON.parse(text)
    result={text,model:GENERATION_MODEL,modelVersion:GENERATION_VERSION,inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,device:'cuda'}
  } finally {
    stop=true;clearTimeout(timer);signal?.removeEventListener('abort',abort)
    if(child){child.stdin.end();const kill=setTimeout(()=>{diag.forcedTermination=true;child.kill()},2000);await done;clearTimeout(kill)}
  }
  if(!stop||diag.forcedTermination||diag.spawnError||diag.protocolError||diag.childExitCode!==0||diag.nativeTerminatedOnStop!==true)throw Error('Generation runtime teardown was not clean')
  return {...result,resourcePolicy:diag.resourcePolicy,cleanShutdown:true}
}
