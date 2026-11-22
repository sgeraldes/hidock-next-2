// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { runRemoteWorkerJob, type RemoteJobIdentity } from '../remote-worker-jobs'

let server: Server | undefined
let directory: string | undefined
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('streams once across a lost upload response and reuses the completed durable identity on resume', async () => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-remote-client-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.alloc(2 * 1024 ** 2, 31)
  await writeFile(path, audio)
  const result = { model: 'voice', modelVersion: '1', device: 'cpu', speakers: [], segments: [] }
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  let uploads = 0, creations = 0, received = 0
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let status = 'awaiting-upload'
  server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer test')
    const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/v1/capabilities') return json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      creations++
      let metadata = ''
      for await (const chunk of req) metadata += chunk.toString()
      expect(JSON.parse(metadata).recordingId).toBe('recording-real-loopback')
      return json({ id, status, audioHash })
    }
    if (req.method === 'PUT') {
      uploads++
      for await (const chunk of req) received += chunk.length
      status = 'completed'
      req.socket.destroy() // Accepted bytes; desktop never receives an acknowledgement.
      return
    }
    return json({ id, status, audioHash, result, resultHash })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const entries = new Map<string, RemoteJobIdentity>()
  const store = { load: (key: string) => entries.get(key), save: (key: string, value: RemoteJobIdentity) => { entries.set(key, value) } }
  const options = { path, base: `http://127.0.0.1:${port}`, token: 'test', model: 'voice', recordingId: 'recording-real-loopback', timeoutMs: 5000, store }
  expect(await runRemoteWorkerJob(options)).toEqual({ ...result, hostJobId: id })
  expect(await runRemoteWorkerJob(options)).toEqual({ ...result, hostJobId: id })
  expect({ creations, uploads, received }).toEqual({ creations: 1, uploads: 1, received: audio.length })
})

it('rejects an unencrypted LAN endpoint before opening the input or sending credentials', async () => {
  await expect(runRemoteWorkerJob({ path: 'not-opened', base: 'http://gamestation:8765', token: 'test',
    model: 'voice', timeoutMs: 1000, store: { load: () => undefined, save: () => {} } })).rejects.toThrow('HTTPS')
})

it('reports a terminal host error without submitting or uploading another job', async () => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-remote-error-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.from('owned audio')
  await writeFile(path, audio)
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const identity = { key: 'original-key', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  const methods: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method || 'GET')
    if (String(url).endsWith('/capabilities')) {
      return Response.json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    }
    return Response.json({ id: identity.id, status: 'failed', audioHash,
      error: 'Remote ASR accepts at most 60 minutes per job' })
  }) as typeof fetch
  await expect(runRemoteWorkerJob({ path, base: 'http://127.0.0.1:8765', token: 'test',
    model: 'voice', timeoutMs: 1000, fetchFn, store: { load: () => identity, save: () => {} }
  })).rejects.toThrow('Remote worker failed: Remote ASR accepts at most 60 minutes per job; automatic retry disabled')
  expect(methods).toEqual(['GET', 'GET'])
})

it.each(['running', 'unreachable'] as const)('does not create or upload a replacement when existing job is %s', async status => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-remote-existing-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.from('owned audio')
  await writeFile(path, audio)
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let identity: RemoteJobIdentity = { key: 'original-key', id, restartTerminal: true }
  const methods: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method || 'GET')
    if (String(url).endsWith('/capabilities')) return Response.json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    if (status === 'unreachable') throw new Error('connection lost')
    return Response.json({ id, status, audioHash })
  }) as typeof fetch
  await expect(runRemoteWorkerJob({ path, base: 'http://127.0.0.1:8765', token: 'test', model: 'voice', timeoutMs: 0,
    fetchFn, store: { load: () => identity, save: (_key, value) => { identity = value } } })).rejects.toThrow()
  expect(methods).toEqual(['GET', 'GET'])
  expect(identity).toMatchObject({ id, key: 'original-key' })
  if (status === 'unreachable') expect(identity.restartTerminal).toBe(true)
})

it('retains the replacement idempotency key after its creation acknowledgement is lost', async () => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-remote-create-loss-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.from('owned audio')
  await writeFile(path, audio)
  const audioHash = createHash('sha256').update(audio).digest('hex')
  let identity: RemoteJobIdentity = { key: 'original-key', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', restartTerminal: true }
  const keys: string[] = []
  const result = { model: 'voice', modelVersion: '1', speakers: [], segments: [] }
  const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) return Response.json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    if (init?.method === 'POST') {
      const key = JSON.parse(String(init.body)).idempotencyKey
      expect(identity.key).toBe(key) // Intent must be durable before the request.
      keys.push(key)
      if (keys.length === 1) throw new Error('acknowledgement lost')
      return Response.json({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', status: 'completed', audioHash, result, resultHash })
    }
    return Response.json({ id: identity.id, status: 'failed', audioHash })
  }) as typeof fetch
  const options = { path, base: 'http://127.0.0.1:8765', token: 'test', model: 'voice', timeoutMs: 1000,
    fetchFn, store: { load: () => identity, save: (_key: string, value: RemoteJobIdentity) => { identity = value } } }
  await expect(runRemoteWorkerJob(options)).rejects.toThrow('acknowledgement lost')
  expect(identity.id).toBeUndefined()
  await expect(runRemoteWorkerJob(options)).resolves.toMatchObject({ model: 'voice' })
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe('original-key')
  expect(keys[1]).toBe(keys[0])
})

it.each([
  ['failed', true, 1], ['cancelled', true, 1], ['interrupted', true, 1], ['completed', true, 0],
  ['failed', false, 0], ['cleanup-failed', true, 0]
] as const)('restarts %s only with explicit intent (%s)', async (status, restartTerminal, expectedCreations) => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-remote-restart-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.from('test audio'); await writeFile(path, audio)
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const result = { model: 'voice', modelVersion: '1', device: 'cpu', speakers: [], segments: [] }
  const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  let identity: RemoteJobIdentity = { key: 'retained-original-key', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', restartTerminal }
  let creations = 0
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/v1/capabilities')) return Response.json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    if (init?.method === 'POST') {
      creations++
      expect(JSON.parse(String(init.body)).idempotencyKey).not.toBe('retained-original-key')
      return Response.json({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', status: 'completed', audioHash, result, resultHash })
    }
    return Response.json({ id: identity.id, status, audioHash, result, resultHash })
  }) as typeof fetch
  const operation = runRemoteWorkerJob({ path, base: 'http://127.0.0.1:8765', token: 'test', model: 'voice', timeoutMs: 1000,
    fetchFn, store: { load: () => identity, save: (_key, value) => { identity = value } } })
  if (expectedCreations || status === 'completed') await expect(operation).resolves.toMatchObject({ model: 'voice' })
  else await expect(operation).rejects.toThrow('automatic retry disabled')
  expect(creations).toBe(expectedCreations)
})


 it.each([false, true])('attributes new requests while preserving legacy uncertain intent (legacy=%s)', async legacy => {
  directory = await mkdtemp(join(tmpdir(), 'hidock-attribution-'))
  const path = join(directory, 'sample.wav')
  const audio = Buffer.from('attribution fixture')
  await writeFile(path, audio)
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const result = { model: 'voice', modelVersion: '1', speakers: [], segments: [] }
  const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  let identity: RemoteJobIdentity | undefined = legacy ? { key: 'legacy-uncertain-key' } : undefined
  const bodies: Record<string, unknown>[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) return Response.json({ protocolVersion: 1, stages: ['diarization'], models: ['voice'] })
    if (init?.method === 'POST') bodies.push(JSON.parse(String(init.body)))
    return Response.json({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'completed', audioHash, result, resultHash })
  }) as typeof fetch
  const options = { path, base: 'http://127.0.0.1:8765', token: 'test', model: 'voice', timeoutMs: 1000,
    recordingId: 'recording-123', fetchFn,
    store: { load: () => identity, save: (_key: string, value: RemoteJobIdentity) => { identity = value } } }
  await runRemoteWorkerJob(options)
  await runRemoteWorkerJob(options)
  expect(bodies).toHaveLength(1)
  expect(bodies[0].recordingId).toBe(legacy ? undefined : 'recording-123')
  if (legacy) expect(bodies[0].idempotencyKey).toBe('legacy-uncertain-key')
  else {
    await expect(runRemoteWorkerJob({ ...options, recordingId: 'different-recording' })).rejects.toThrow('recording identity mismatch')
    expect(bodies).toHaveLength(1)
  }
})
it('rejects invalid recording attribution before input or network access', async () => {
  await expect(runRemoteWorkerJob({ path: 'not-opened', base: 'http://127.0.0.1:8765', token: 'test',
    model: 'voice', timeoutMs: 1000, recordingId: '../private/name',
    store: { load: () => undefined, save: () => {} } })).rejects.toThrow('Invalid recording identity')
})
