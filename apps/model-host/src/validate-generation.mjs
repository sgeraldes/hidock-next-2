import {readFile,writeFile,open,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {generationPaths,generationFingerprint,runGeneration,GENERATION_VERSION} from './generation.mjs'
const root=process.argv[2]
if(!root)throw Error('Host root required')
const externallyLocked=process.argv.includes('--preparation-locked')
const lock=externallyLocked?null:await open(join(root,'asr-preparing.lock'),'wx')
try {
 const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'))
 await unlink(generationPaths(root).proof).catch(e=>{if(e.code!=='ENOENT')throw e})
 const result=await runGeneration({expectedModelVersion:GENERATION_VERSION,messages:[{role:'user',content:'Devuelve un objeto JSON con la clave idioma y el valor español.'}],maxOutputTokens:64,jsonMode:true},{root,pythonPath:config.pythonPath,workerPath:config.workerPath,validation:true})
 if(JSON.parse(result.text).idioma!=='español')throw Error('Spanish structured generation verification failed')
 await writeFile(generationPaths(root).proof,JSON.stringify({modelVersion:GENERATION_VERSION,device:result.device,cleanShutdown:result.cleanShutdown,inputTokens:result.inputTokens,outputTokens:result.outputTokens,fingerprint:await generationFingerprint(root),verifiedAt:new Date().toISOString()},null,2))
 console.log('Managed generation Spanish JSON and clean teardown passed')
}finally{if(lock){await lock.close();await unlink(join(root,'asr-preparing.lock'))}}
