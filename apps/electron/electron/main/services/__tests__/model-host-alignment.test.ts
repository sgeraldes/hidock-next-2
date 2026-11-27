// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { validateRemoteResult, type RemoteJobIdentity, type RemoteJobStore } from '../remote-worker-jobs'
import {
  ALIGN_MODEL, alignWordsOnModelHost, modelHostCanAlign, ModelHostUnavailableError, resetModelHostHealthCache
} from '../model-host-client'

const words = [{ word: 'Hola,', start: 0.3, end: 0.6 }, { word: 'Manuel.', start: 0.64, end: 1.1 }]
const result = { model: ALIGN_MODEL, modelVersion: 'parakeet-int8/sherpa-onnx-1.12', device: 'cpu', words }

describe('alignment results from the host', () => {
  it('accepts ordered words from the alignment model', () => {
    expect(() => validateRemoteResult(result, 'alignment', ALIGN_MODEL)).not.toThrow()
  })
  it.each([
    ['another model', { ...result, model: 'other' }],
    ['no words', { ...result, words: undefined }],
    ['a word without times', { ...result, words: [{ word: 'a', start: 1 }] }],
    ['an end before its start', { ...result, words: [{ word: 'a', start: 1, end: 0.5 }] }],
  ])('rejects %s', (_name, value) => {
    expect(() => validateRemoteResult(value as Record<string, unknown>, 'alignment', ALIGN_MODEL)).toThrow(/alignment/)
  })
})

describe('modelHostCanAlign', () => {
  it('needs a durable host that offers Parakeet alignment', () => {
    expect(modelHostCanAlign({ protocolVersion: 1, alignmentModels: [ALIGN_MODEL] } as never)).toBe(true)
    expect(modelHostCanAlign({ protocolVersion: 1, alignmentModels: [] } as never)).toBe(false)
    expect(modelHostCanAlign({ protocolVersion: 1 } as never)).toBe(false)
    expect(modelHostCanAlign({ alignmentModels: [ALIGN_MODEL] } as never)).toBe(false)
    expect(modelHostCanAlign(null)).toBe(false)
  })
})

describe('alignWordsOnModelHost', () => {
  let directory: string
  let clip: string
  const audio = Buffer.from('RIFF section audio')
  const audioHash = createHash('sha256').update(audio).digest('hex')
  const memory = (): RemoteJobStore => {
    const identities = new Map<string, RemoteJobIdentity>()
    const results = new Map<string, unknown>()
    return { load: (k) => identities.get(k), save: (k, v) => { identities.set(k, v) },
      loadResult: (k) => results.get(k), saveResult: (k, v) => { results.set(k, v) } }
  }
  beforeEach(async () => {
    resetModelHostHealthCache()
    directory = await mkdtemp(join(tmpdir(), 'hidock-align-client-'))
    clip = join(directory, 'section.wav')
    await writeFile(clip, audio)
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  /** A mocked host: no network, no model. */
  function host(options: { health?: unknown; status?: string; running?: boolean; busyUploads?: number; refuseUploadWith?: number } = {}) {
    const seen: string[] = []
    // The host refuses this many uploads with 429 while its single slot runs another job.
    let busyLeft = options.busyUploads ?? 0
    let accepted = false
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      seen.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/health') return json(options.health ?? { protocolVersion: 1, state: 'ready', capabilities: ['vad'], alignmentModels: [ALIGN_MODEL] })
      if (path === '/v1/capabilities') return json({ protocolVersion: 1, stages: ['alignment'], models: [ALIGN_MODEL] })
      if (path === '/v1/jobs') {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({ stage: 'alignment', model: ALIGN_MODEL, audioHash, bytes: audio.length, recordingId: 'rec-1' })
        expect(body.text).toBeUndefined()
        return json({ id, status: 'awaiting-upload', audioHash })
      }
      if (path === `/v1/jobs/${id}/cancel`) return json({ id, status: 'cancelled', audioHash })
      if (path === `/v1/jobs/${id}`) return json({ id, status: accepted || (!options.busyUploads && !options.refuseUploadWith) ? 'running' : 'awaiting-upload', audioHash })
      if (path === `/v1/jobs/${id}/audio`) {
        if (options.refuseUploadWith) return json({ error: 'refused' }, options.refuseUploadWith)
        if (busyLeft > 0) { busyLeft--; return json({ error: 'Worker is busy or paused' }, 429) }
        accepted = true
        if (options.running) return json({ id, status: 'running', audioHash }, 202)
        const status = options.status ?? 'completed'
        return json({ id, status, audioHash, ...(status === 'completed' ? { result, resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') } : { error: 'worker crashed' }) }, 202)
      }
      return json({ error: 'unexpected' }, 404)
    }) as unknown as typeof fetch
    return { fetchFn, seen }
  }
  const settings = { url: 'http://127.0.0.1:8766', token: 'test' }

  it('sends only the section audio as an alignment job and returns the heard words', async () => {
    const { fetchFn, seen } = host()
    const answer = await alignWordsOnModelHost(clip, settings, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn)
    expect(answer.words).toEqual(words)
    expect(answer.modelVersion).toBe(result.modelVersion)
    expect(seen).toContain('PUT /v1/jobs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/audio')
  })

  it('says the host is unavailable when it does not answer', async () => {
    const fetchFn = (async () => { throw new Error('connect ETIMEDOUT') }) as unknown as typeof fetch
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toBeInstanceOf(ModelHostUnavailableError)
  })

  it('says the host cannot align when Parakeet is not ready there, before any upload', async () => {
    const { fetchFn, seen } = host({ health: { protocolVersion: 1, state: 'ready', capabilities: ['vad'], alignmentModels: [] } })
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toThrow(/cannot place words/)
    expect(seen.some((s) => s.startsWith('PUT'))).toBe(false)
  })

  it('turns a failed host job into an unavailable host, so the caller falls back', async () => {
    const { fetchFn } = host({ status: 'failed' })
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toBeInstanceOf(ModelHostUnavailableError)
  })

  it('cancels the host job when it takes too long, so the host stops working for nobody (Kiro review of #198)', async () => {
    const { fetchFn, seen } = host({ running: true })
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 1200, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toBeInstanceOf(ModelHostUnavailableError)
    expect(seen).toContain('POST /v1/jobs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/cancel')
  })

  it('waits behind the job the host is running and then uses its words (27-nov-2026)', async () => {
    // Right after a restart the host was transcribing a queued recording. Its single slot
    // answered the upload with 429 and the job stayed awaiting-upload; Fix times fell back
    // at once with "Remote worker awaiting-upload; automatic retry disabled".
    const { fetchFn, seen } = host({ busyUploads: 2 })
    const answer = await alignWordsOnModelHost(clip, settings, { timeoutMs: 10_000, recordingId: 'rec-1', store: memory() }, fetchFn)
    expect(answer.words).toEqual(words)
    expect(seen.filter((s) => s.startsWith('PUT')).length).toBe(3)
    expect(seen.filter((s) => s === 'POST /v1/jobs').length).toBe(1)
    expect(seen.some((s) => s.endsWith('/cancel'))).toBe(false)
  }, 15_000)

  it('gives up with a clear reason when the host stays busy past the timeout, and withdraws the waiting job', async () => {
    const { fetchFn, seen } = host({ busyUploads: 1000 })
    const failure = alignWordsOnModelHost(clip, settings, { timeoutMs: 2500, recordingId: 'rec-1', store: memory() }, fetchFn)
    await expect(failure).rejects.toBeInstanceOf(ModelHostUnavailableError)
    await expect(failure).rejects.toThrow(/busy with another job/)
    expect(seen).toContain('POST /v1/jobs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/cancel')
  }, 10_000)

  it.each([401, 413, 500])('does not wait when the host refuses the upload with %i, which is not busy', async (code) => {
    const { fetchFn, seen } = host({ refuseUploadWith: code })
    const started = Date.now()
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 10_000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toThrow(/awaiting-upload/)
    expect(seen.filter((s) => s.startsWith('PUT')).length).toBe(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('does not cancel a job the host already ended', async () => {
    const { fetchFn, seen } = host({ status: 'failed' })
    await expect(alignWordsOnModelHost(clip, settings, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn)).rejects.toThrow()
    expect(seen.some((s) => s.endsWith('/cancel'))).toBe(false)
  })

  it('needs an address and a pairing', async () => {
    const { fetchFn } = host()
    await expect(alignWordsOnModelHost(clip, { url: '', token: '' }, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toBeInstanceOf(ModelHostUnavailableError)
    await expect(alignWordsOnModelHost(clip, { ...settings, token: '' }, { timeoutMs: 5000, recordingId: 'rec-1', store: memory() }, fetchFn))
      .rejects.toBeInstanceOf(ModelHostUnavailableError)
  })
})
