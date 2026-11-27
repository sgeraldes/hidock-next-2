import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintBytes, fingerprintMatches, fingerprintMatchesAsync, isHostSource } from '../src/source-fingerprint.mjs'
import { readySemanticEmbeddings, semanticFingerprint } from '../src/semantic-embeddings.mjs'
import { readyAsrModels } from '../src/asr-readiness.mjs'
import { generationFingerprint, generationPaths, generationReadiness, GENERATION_VERSION } from '../src/generation.mjs'

// 0.5.x installers shipped the host scripts with LF; 0.6.0 and 0.6.1 were built from a
// checkout with core.autocrlf=true and shipped CRLF. Hashing raw bytes made that update
// drop every prepared model although no script changed (27-nov-2026).
const worker = fileURLToPath(new URL('../src/semantic_embedding_worker.py', import.meta.url))

describe('host script fingerprints ignore line endings', () => {
  it('hashes the host scripts with LF, and CRLF only as a legacy form', () => {
    const raw = readFileSync(worker)
    const lf = fingerprintBytes(worker, 'lf'), crlf = fingerprintBytes(worker, 'crlf')
    expect(isHostSource(worker)).toBe(true)
    expect(lf.includes('\r')).toBe(false)
    expect(crlf.toString('latin1')).toBe(lf.toString('latin1').replace(/\n/g, '\r\n'))
    expect(fingerprintBytes(worker, 'raw').equals(raw)).toBe(true)
    expect([lf.toString('latin1'), crlf.toString('latin1')]).toContain(raw.toString('latin1'))
  })

  it('keeps raw bytes for files that are not host scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fingerprint-test-'))
    try {
      const other = join(root, '__init__.py')
      await writeFile(other, 'a\r\nb\r\n')
      expect(isHostSource(other)).toBe(false)
      expect(fingerprintBytes(other, 'lf').toString()).toBe('a\r\nb\r\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed when the runtime cannot be read or the proof is empty', async () => {
    expect(fingerprintMatches('x', () => { throw new Error('missing') })).toBe(false)
    expect(fingerprintMatches('', () => '')).toBe(false)
    expect(fingerprintMatches(undefined, () => 'x')).toBe(false)
    expect(await fingerprintMatchesAsync('x', async () => { throw new Error('missing') })).toBe(false)
  })

  it('keeps a semantic proof recorded with either line ending, and drops a changed runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'semantic-fingerprint-'))
    try {
      await mkdir(join(root, 'onnx'))
      await mkdir(join(root, 'onnxruntime', 'capi'), { recursive: true })
      for (const name of ['python.exe', 'onnxruntime/__init__.py', 'onnxruntime/capi/onnxruntime_pybind11_state.pyd']) await writeFile(join(root, name), 'fixture')
      const files = {}
      for (const name of ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model.onnx', 'onnx/model.onnx.data']) {
        await writeFile(join(root, name), 'fixture')
        const info = await stat(join(root, name), { bigint: true })
        files[name] = { bytes: Number(info.size), mtimeNs: info.mtimeNs.toString(), sha256: 'a'.repeat(64) }
      }
      await writeFile(join(root, 'hidock-semantic-manifest.json'), JSON.stringify({ model: 'local/nemotron-3-embed-1b',
        spaceId: 'nemotron-import-sha256:' + 'a'.repeat(64), files }))
      const options = { modelDir: root, siteDir: root, pythonPath: join(root, 'python.exe') }
      const proof = form => ({ testedAt: 'fixture', device: 'cpu', dimensions: 2048,
        fingerprint: semanticFingerprint(options.pythonPath, root, root, form) })
      // Proved by an LF install (0.5.x), by a CRLF install (0.6.x), and by this version.
      expect(readySemanticEmbeddings(proof('lf'), options)).toBe(true)
      expect(readySemanticEmbeddings(proof('crlf'), options)).toBe(true)
      expect(semanticFingerprint(options.pythonPath, root, root)).toBe(proof('lf').fingerprint)
      const before = proof('lf')
      await writeFile(join(root, 'onnxruntime', '__init__.py'), 'changed')
      expect(readySemanticEmbeddings(before, options)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('passes each line-ending form to the ASR fingerprint', () => {
    const model = 'nvidia/parakeet-tdt-0.6b-v3'
    const config = { asrModels: [model], asrValidation: { [model]: { testedAt: 't', modelVersion: 'v', device: 'cpu', fingerprint: 'crlf-print' } } }
    const forms = []
    expect(readyAsrModels(config, 'python', (_python, _model, form) => { forms.push(form); return `${form}-print` })).toEqual([model])
    expect(forms).toEqual(['lf', 'crlf'])
  })

  it('keeps a generation proof across an update that rewrites the host scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-fingerprint-'))
    const p = generationPaths(root)
    try {
      await mkdir(join(p.model, '..'), { recursive: true }); await mkdir(join(p.exe, '..'), { recursive: true })
      await writeFile(p.model, 'model'); await writeFile(p.exe, 'exe')
      const crlf = await generationFingerprint(root, 'crlf')
      const scripts = JSON.parse(crlf).slice(-2)
      expect(scripts.map(entry => entry[0])).toEqual(['generation_supervisor.py', 'generation.mjs'])
      expect(scripts.every(entry => /^[0-9a-f]{64}$/.test(entry[1]))).toBe(true)
      await writeFile(p.proof, JSON.stringify({ modelVersion: GENERATION_VERSION, device: 'cuda', cleanShutdown: true, fingerprint: crlf }))
      expect((await generationReadiness(root)).ready).toBe(true)
      expect(await generationFingerprint(root)).toBe(await generationFingerprint(root, 'lf'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
