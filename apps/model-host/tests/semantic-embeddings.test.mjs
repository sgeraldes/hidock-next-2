import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { validateSemanticRequest, runSemanticEmbeddings, readySemanticEmbeddings } from '../src/semantic-embeddings.mjs'

it('rejects missing purpose, oversized input and unvalidated capability', () => {
  expect(() => validateSemanticRequest({ texts: ['text'] })).toThrow()
  expect(() => validateSemanticRequest({ purpose: 'query', texts: ['x'.repeat(16001)] })).toThrow()
  expect(readySemanticEmbeddings({}, {})).toBe(false)
})

it('uses bounded worker transport and rejects vector-space/count mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-test-'))
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
    const spaceId = 'nemotron-import-sha256:' + 'a'.repeat(64)
    await writeFile(join(root, 'hidock-semantic-manifest.json'), JSON.stringify({ model: 'local/nemotron-3-embed-1b', spaceId, files }))
    let result = { model: 'local/nemotron-3-embed-1b', spaceId, dimensions: 2048,
      purpose: 'query', device: 'cpu', vectors: [[1, ...Array(2047).fill(0)]] }
    const spawnFn = (_exe, args, options) => {
      expect(args).toContain('--request')
      expect(options.windowsHide).toBe(true)
      expect(options.env.HIDOCK_WORKER_PRIORITY).toBe('below-normal')
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', 1)
      setTimeout(() => { child.stdout.emit('data', JSON.stringify(result)); child.emit('close', 0) }, 0)
      return child
    }
    const options = { modelDir: root, siteDir: root, pythonPath: join(root, 'python.exe'), workerPath: join(root, 'worker.py'), spawnFn }
    expect((await runSemanticEmbeddings({ purpose: 'query', texts: ['hello'] }, options)).vectors).toHaveLength(1)
    const server = createServer(async (request, response) => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const value = await runSemanticEmbeddings(JSON.parse(Buffer.concat(chunks)), options)
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value))
      } catch { response.writeHead(400); response.end('{}') }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST',
        body: JSON.stringify({ purpose: 'query', texts: ['hello'] }) })
      expect(response.status).toBe(200)
      expect((await response.json()).spaceId).toBe(spaceId)
    } finally { await new Promise(resolve => server.close(resolve)) }
    result = { ...result, spaceId: 'other-space' }
    await expect(runSemanticEmbeddings({ purpose: 'query', texts: ['hello'] }, options)).rejects.toThrow('Invalid semantic')
  } finally { await rm(root, { recursive: true, force: true }) }
})
