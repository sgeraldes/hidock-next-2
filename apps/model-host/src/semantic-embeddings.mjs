import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiarization } from './diarize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const SEMANTIC_MODEL = 'local/nemotron-3-embed-1b'
export function validateSemanticRequest(request) {
  if (!request || !['query', 'passage'].includes(request.purpose) || !Array.isArray(request.texts)
    || request.texts.length < 1 || request.texts.length > 16
    || request.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 16000)
    || Buffer.byteLength(JSON.stringify(request)) > 262144
    || request.texts.reduce((n, text) => n + Buffer.byteLength(text), 0) > 131072) {
    throw new Error('Invalid or oversized semantic embedding request')
  }
  return { purpose: request.purpose, texts: request.texts }
}
export function semanticFingerprint(pythonPath, modelDir, siteDir) {
  const manifestPath = join(modelDir, 'hidock-semantic-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.model !== SEMANTIC_MODEL || !/^nemotron-import-sha256:[a-f0-9]{64}$/.test(manifest.spaceId)) throw new Error('Invalid semantic manifest')
  if (Object.keys(manifest.files || {}).length !== 5) throw new Error('Incomplete semantic manifest')
  for (const [name, item] of Object.entries(manifest.files)) {
    if (!['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model.onnx', 'onnx/model.onnx.data'].includes(name)) throw new Error('Unexpected manifest asset')
    const stat = statSync(join(modelDir, name), { bigint: true })
    if (stat.size !== BigInt(item.bytes) || stat.mtimeNs.toString() !== item.mtimeNs) throw new Error('Semantic assets changed')
  }
  const hash = createHash('sha256')
  for (const path of [pythonPath, manifestPath, join(here, 'semantic_embedding_worker.py'), join(here, 'prepare_semantic_embeddings.py'),
    join(siteDir, 'onnxruntime', '__init__.py')]) hash.update(readFileSync(path))
  const capi = join(siteDir, 'onnxruntime', 'capi')
  const binaries = readdirSync(capi).filter(name => /\.(pyd|dll|so)$/i.test(name)).sort()
  if (!binaries.length) throw new Error('ONNX Runtime native CPU extension missing')
  for (const name of binaries) {
    const stat = statSync(join(capi, name), { bigint: true })
    hash.update(name).update(String(stat.size)).update(String(stat.mtimeNs))
  }
  return hash.digest('hex')
}
export function readySemanticEmbeddings(proof, options) {
  try { return Boolean(proof?.testedAt && proof.device === 'cpu' && proof.dimensions === 2048 &&
    proof.fingerprint === semanticFingerprint(options.pythonPath, options.modelDir, options.siteDir)) } catch { return false }
}
export async function runSemanticEmbeddings(raw, options) {
  const request = validateSemanticRequest(raw)
  const manifest = JSON.parse(readFileSync(join(options.modelDir, 'hidock-semantic-manifest.json'), 'utf8'))
  semanticFingerprint(options.pythonPath, options.modelDir, options.siteDir)
  return runDiarization(Buffer.from(JSON.stringify(request)), { ...options, extension: '.json',
    timeoutMs: Math.min(120000, options.timeoutMs || 120000),
    workerArgs: path => [join(here, 'semantic_embedding_worker.py'), '--request', path,
      '--model-dir', options.modelDir, '--worker-dir', dirname(options.workerPath), '--site-dir', options.siteDir],
    parseOutput: stdout => {
      const result = JSON.parse(stdout)
      if (result.spaceId !== manifest.spaceId || result.model !== SEMANTIC_MODEL || result.dimensions !== 2048
        || result.purpose !== request.purpose || result.device !== 'cpu'
        || !Array.isArray(result.vectors) || result.vectors.length !== request.texts.length
        || result.vectors.some(vector => !Array.isArray(vector) || vector.length !== 2048
          || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
          || Math.abs(Math.hypot(...vector) - 1) > 0.001)) throw new Error('Invalid semantic embedding result')
      return result
    } })
}
