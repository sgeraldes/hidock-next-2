/** Explicit operator validation; never called by health or startup. No downloads. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, updateConfigFile } from './config.mjs'
import { runSemanticEmbeddings, semanticFingerprint } from './semantic-embeddings.mjs'

const [root] = process.argv.slice(2)
if (!root) throw new Error('Expected host data root')
const install = join(dirname(fileURLToPath(import.meta.url)), '..')
const configFile = join(root, 'config.json')
const config = loadConfig(configFile)
const options = {
  pythonPath: config.pythonPath || join(root, 'runtime', 'python', 'python.exe'),
  modelDir: join(root, 'models', 'nemotron-3-embed-1b'),
  siteDir: join(root, 'runtime', 'semantic-embeddings', 'site'),
  workerPath: join(install, 'resources', 'speaker-linking', 'worker.py'),
  cpuPercent: config.cpuPercent || 50, timeoutMs: 120000
}
const query = await runSemanticEmbeddings({ purpose: 'query', texts: ['A short synthetic validation sentence.'] }, options)
const passage = await runSemanticEmbeddings({ purpose: 'passage', texts: ['A short synthetic validation sentence.'] }, options)
if (query.spaceId !== passage.spaceId || query.vectors[0].every((value, index) => value === passage.vectors[0][index])) {
  throw new Error('Semantic purpose separation validation failed')
}
const proof = { testedAt: new Date().toISOString(), modelVersion: query.spaceId, spaceId: query.spaceId,
  dimensions: 2048, device: 'cpu', runtimeVersion: query.runtimeVersion,
  fingerprint: semanticFingerprint(options.pythonPath, options.modelDir, options.siteDir) }
updateConfigFile({ semanticEmbeddingValidation: proof }, configFile)
console.log(JSON.stringify({ validated: true, ...proof,
  limitation: 'Synthetic finite vector and prefix checks; cross-runtime retrieval equivalence not yet measured' }))
