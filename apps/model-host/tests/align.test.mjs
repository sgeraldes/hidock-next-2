import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { ALIGN_MODEL, alignmentModels, parseAlignOutput, runAlignment } from '../src/align.mjs'
import { createHandler } from '../src/server.mjs'
import { HostState, READY } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { WorkerJobs } from '../src/jobs.mjs'
import { request, response } from './helpers.mjs'

const owned = []
afterEach(async () => { for (const cleanup of owned.splice(0).reverse()) await cleanup() })

const RESULT = {
  model: ALIGN_MODEL, modelVersion: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/sherpa-onnx-1.12.0', device: 'cpu',
  audioSeconds: 4, timestampSource: 'parakeet-tdt-token',
  words: [{ word: 'Hola,', start: 0.32, end: 0.6 }, { word: 'Manuel.', start: 0.64, end: 1.1 }],
}

function routeFixture(ready) {
  const pairing = new PairingStore()
  const token = pairing.redeem(pairing.openPairing()).token
  const created = []
  const handler = createHandler({
    state: new HostState({ initial: READY }), pairing,
    capabilities: () => ({ capabilities: ['vad'], asrModels: ready ? [ALIGN_MODEL] : [],
      alignmentModels: ready ? [ALIGN_MODEL] : [] }),
    jobs: { create: async value => { created.push(value); return { id: 'fixture' } } },
  })
  async function call(url, { method = 'GET', body } = {}) {
    const req = request({ method, url, local: false, headers: { authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : '' })
    req.socket.encrypted = true
    const res = response()
    await handler(req, res)
    return res
  }
  return { call, created }
}

describe('alignment capability', () => {
  it('is offered only when Parakeet passed its spoken test on this host', () => {
    expect(alignmentModels([ALIGN_MODEL, 'CohereLabs/cohere-transcribe-03-2026'])).toEqual([ALIGN_MODEL])
    expect(alignmentModels(['CohereLabs/cohere-transcribe-03-2026'])).toEqual([])
    expect(alignmentModels(undefined)).toEqual([])
  })

  it.each([true, false])('advertises the alignment stage only when ready: %s', async ready => {
    const { call } = routeFixture(ready)
    const body = JSON.parse((await call('/v1/capabilities')).body)
    expect(body.stages.includes('alignment')).toBe(ready)
    expect(body.alignmentModels).toEqual(ready ? [ALIGN_MODEL] : [])
  })

  it.each([true, false])('admits an alignment job only when ready: %s', async ready => {
    const { call, created } = routeFixture(ready)
    const res = await call('/v1/jobs', { method: 'POST', body: { stage: 'alignment', model: ALIGN_MODEL } })
    expect(res.statusCode).toBe(ready ? 200 : 503)
    expect(created.length).toBe(ready ? 1 : 0)
  })

  it('refuses another model for alignment, and alignment-only use of the transcription stage stays separate', async () => {
    const { call, created } = routeFixture(true)
    expect((await call('/v1/jobs', { method: 'POST', body: { stage: 'alignment', model: 'CohereLabs/cohere-transcribe-03-2026' } })).statusCode).toBe(400)
    expect(created).toEqual([])
  })
})

describe('alignment jobs', () => {
  it('accept the alignment stage and dispatch it after a verified upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-align-jobs-'))
    owned.push(() => rm(directory, { recursive: true, force: true }))
    let dispatched
    const jobs = new WorkerJobs({ directory, state: new HostState({ initial: READY }), options: () => ({}),
      execute: async (_path, options) => { dispatched = options; return RESULT } })
    await jobs.initialize()
    owned.push(() => jobs.close())
    const audio = Buffer.from('section audio')
    const job = await jobs.create({ idempotencyKey: 'fixture-alignment-one', audioHash: createHash('sha256').update(audio).digest('hex'),
      bytes: audio.length, model: ALIGN_MODEL, extension: '.wav', stage: 'alignment', recordingId: 'recording-fixture' }, 'owner')
    await jobs.upload(job.id, 'owner', Readable.from([audio]))
    await expect.poll(() => jobs.get(job.id, 'owner').status).toBe('completed')
    expect(dispatched).toMatchObject({ stage: 'alignment', model: ALIGN_MODEL })
    expect(jobs.get(job.id, 'owner').result.words).toHaveLength(2)
  })
})

describe('alignment worker output', () => {
  it('accepts ordered word timestamps', () => {
    expect(parseAlignOutput(JSON.stringify(RESULT))).toEqual(RESULT)
  })

  it.each([
    ['another model', { ...RESULT, model: 'other' }],
    ['no version', { ...RESULT, modelVersion: undefined }],
    ['no words', { ...RESULT, words: undefined }],
    ['a negative start', { ...RESULT, words: [{ word: 'a', start: -1, end: 0.2 }] }],
    ['an end before its start', { ...RESULT, words: [{ word: 'a', start: 1, end: 0.5 }] }],
    ['words out of order', { ...RESULT, words: [{ word: 'a', start: 2, end: 2.2 }, { word: 'b', start: 1, end: 1.2 }] }],
    ['an empty word', { ...RESULT, words: [{ word: ' ', start: 1, end: 1.2 }] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseAlignOutput(JSON.stringify(value))).toThrow(/Alignment worker/)
  })
})

describe('runAlignment', () => {
  it('runs the alignment worker on the prepared Parakeet model and runtime', async () => {
    let args
    const spawnFn = (_python, given) => {
      args = given
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
      child.kill = () => {}
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(RESULT)); child.emit('close', 0) })
      return child
    }
    const result = await runAlignment(Buffer.from('audio'), { pythonPath: 'py', workerPath: join('C:', 'host', 'resources', 'worker.py'),
      hostRoot: join('C:', 'root'), cpuPercent: 50, timeoutMs: 5000, spawnFn })
    expect(result.words).toHaveLength(2)
    expect(args[0]).toMatch(/align_worker\.py$/)
    expect(args).toContain(join('C:', 'root', 'models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))
    expect(args).toContain(join('C:', 'root', 'runtime', 'asr-onnx', 'site'))
    expect(args[args.indexOf('--worker-dir') + 1]).toBe(join('C:', 'host', 'resources'))
  })

  it('gives the worker a scratch folder it owns, and removes it even when the worker is killed (CodeRabbit review of #198)', async () => {
    let scratch
    const spawnFn = (_python, given) => {
      scratch = given[given.indexOf('--temp-dir') + 1]
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
      child.kill = () => { queueMicrotask(() => child.emit('close', null)) }
      return child
    }
    const controller = new AbortController()
    const run = runAlignment(Buffer.from('audio'), { pythonPath: 'py', workerPath: join('C:', 'w', 'worker.py'), hostRoot: join('C:', 'root'),
      cpuPercent: 50, timeoutMs: 5000, spawnFn, signal: controller.signal })
    await expect.poll(() => scratch).toBeTruthy()
    expect(existsSync(scratch)).toBe(true)
    controller.abort()
    await expect(run).rejects.toThrow()
    expect(existsSync(scratch)).toBe(false)
  })
})
