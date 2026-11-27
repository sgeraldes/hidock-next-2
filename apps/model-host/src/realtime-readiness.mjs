import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asrRuntimeFingerprint } from './asr-readiness.mjs'
import { REALTIME_MODEL } from './realtime-gateway.mjs'
import { fingerprintBytes, fingerprintMatches } from './source-fingerprint.mjs'
const here=dirname(fileURLToPath(import.meta.url))
export function realtimeFingerprint(pythonPath, root, form = 'lf') {
  const hash=createHash('sha256').update(asrRuntimeFingerprint(pythonPath,REALTIME_MODEL,root,form))
  for(const file of ['realtime-gateway.mjs','realtime-native-runtime.mjs','realtime_native_supervisor.py'])
    hash.update(fingerprintBytes(join(here,file),form))
  hash.update(readFileSync(join(here,'..','node_modules','ws','package.json')))
  return hash.digest('hex')
}
export function readyRealtime(proof, pythonPath, root) {
  try { return Boolean(proof?.model===REALTIME_MODEL && proof.device==='cuda' && proof.testedAt &&
    proof.partialBeforeCommit===true && proof.cleanShutdown===true && fingerprintMatches(proof.fingerprint,form=>realtimeFingerprint(pythonPath,root,form))) }
  catch { return false }
}
