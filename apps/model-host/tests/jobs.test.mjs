import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { WorkerJobs } from '../src/jobs.mjs'
import { HostState, READY } from '../src/state.mjs'
import { createHostServer } from '../src/server.mjs'
import { HostTelemetry } from '../src/telemetry.mjs'

const owned = []
afterEach(async () => { for (const cleanup of owned.splice(0).reverse()) await cleanup() })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(execute) {
  const directory = await mkdtemp(join(tmpdir(), 'hidock-jobs-'))
  owned.push(() => rm(directory, { recursive: true, force: true }))
  const state = new HostState({ initial: READY })
  const jobs = new WorkerJobs({ directory, state, execute, options: () => ({}) })
  await jobs.initialize()
  owned.push(() => jobs.close())
  const audio = Buffer.from('representative test input')
  const request = { idempotencyKey: 'fixture-recording-one', audioHash: hash(audio), bytes: audio.length,
    model: 'pyannote/speaker-diarization-3.1', extension: '.wav', stage: 'diarization' }
  return { jobs, state, directory, audio, request }
}

describe('durable worker protocol', () => {
  it('dispatches the persisted ASR model, language and stage after a verified upload', async () => {
    let dispatched
    const f = await fixture(async (_path, options) => {
      dispatched = options
      return { model: options.model, modelVersion: 'fixture', text: 'Hello', segments: [], outputTokens: 12 }
    })
    const telemetry = new HostTelemetry()
    owned.push(() => telemetry.stop())
    f.jobs.telemetry = telemetry
    const request = { ...f.request, stage: 'transcription', language: 'en', model: 'microsoft/VibeVoice-ASR', recordingId: 'recording-fixture' }
    const job = await f.jobs.create(request, 'owner')
    await f.jobs.upload(job.id, 'owner', Readable.from([f.audio]))
    await expect.poll(() => f.jobs.get(job.id, 'owner').status).toBe('completed')
    expect(dispatched).toMatchObject({ stage: 'transcription', language: 'en', model: request.model })
    expect(dispatched.signal).toBeInstanceOf(AbortSignal)
    await expect.poll(() => telemetry.snapshot().recentJobs.length).toBe(1)
    expect(telemetry.snapshot().recentJobs[0]).toMatchObject({ hostJobId: job.id,
      recordingId: 'recording-fixture', outputTokens: 12 })
    await expect(f.jobs.create({ ...request, recordingId: 'other-recording' }, 'owner')).rejects.toThrow('different input')
  })

  it('binds transcription stage and language to the durable identity', async () => {
    const f = await fixture(async () => { throw new Error('no execution expected') })
    const request = { ...f.request, stage: 'transcription', model: 'CohereLabs/cohere-transcribe-03-2026' }
    const first = await f.jobs.create(request, 'owner')
    expect((await f.jobs.create({ ...request, language: 'es' }, 'owner')).id).toBe(first.id)
    await expect(f.jobs.create({ ...request, language: 'en' }, 'owner')).rejects.toThrow('different input')
    await expect(f.jobs.create({ ...request, stage: 'diarization' }, 'owner')).rejects.toThrow('different input')
    await expect(f.jobs.create({ ...request, language: '--invalid' }, 'owner')).rejects.toThrow('Invalid language')
  })

  it('survives a desktop HTTP reconnect, reuses one job and removes input before returning completion', async () => {
    let release
    let calls = 0
    const f = await fixture(async () => {
      calls++
      await new Promise(resolve => { release = resolve })
      return { device: 'test-cpu', model: 'fixture', modelVersion: '1', segments: [], speakers: [] }
    })
    const server = createHostServer({ state: f.state, jobs: f.jobs,
      pairing: { accepts: header => header === 'Bearer fixture' },
      capabilities: () => ({ capabilities: ['diarize'] }), jobOptions: () => ({}),
      })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    owned.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json', connection: 'close' }
    const create = async () => (await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify(f.request) })).json()
    const first = await create()
    expect((await create()).id).toBe(first.id)
    expect(first.owner).toBeUndefined()
    const upload = await fetch(`${base}/v1/jobs/${first.id}/audio`, { method: 'PUT', headers, body: f.audio })
    expect(upload.status).toBe(202)
    await upload.json()
    expect((await create()).id).toBe(first.id)
    expect(calls).toBe(1)
    release()
    await expect.poll(async () => {
      const response = await fetch(`${base}/v1/jobs/${first.id}`, { headers })
      return (await response.json()).status
    }).toBe('completed')
    const completed = await (await fetch(`${base}/v1/jobs/${first.id}`, { headers })).json()
    expect(completed.audioHash).toBe(f.request.audioHash)
    expect(completed.resultHash).toBe(hash(JSON.stringify(completed.result)))
    expect((await readdir(f.directory)).filter(file => file.endsWith('.audio'))).toEqual([])
    expect(() => f.jobs.get(first.id, 'Bearer stranger')).toThrow('No such job')
  })

  it('rejects changed bytes and records a failed job without executing a model', async () => {
    let calls = 0
    const f = await fixture(async () => { calls++ })
    const job = await f.jobs.create(f.request, 'owner')
    await expect(f.jobs.upload(job.id, 'owner', Readable.from([Buffer.alloc(f.audio.length)]))).rejects.toThrow('hash')
    expect(calls).toBe(0)
    expect(f.jobs.get(job.id, 'owner').status).toBe('failed')
    expect(f.state.activeJob).toBeNull()
    expect((await readdir(f.directory)).some(file => file.endsWith('.audio'))).toBe(false)
  })

  it('reopens durable job state without automatically restarting a model', async () => {
    const f = await fixture(async () => { throw new Error('must not execute') })
    const job = await f.jobs.create(f.request, 'owner')
    f.jobs.close()
    const restored = new WorkerJobs({ directory: f.directory, state: f.state, execute: () => {}, options: () => ({}) })
    await restored.initialize()
    owned.push(() => restored.close())
    expect(restored.get(job.id, 'owner').status).toBe('interrupted')
    expect((await restored.create(f.request, 'owner')).id).toBe(job.id)
  })
})
