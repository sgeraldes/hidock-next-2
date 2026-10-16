// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { createServer } from 'http'

const mocks = vi.hoisted(() => {
  const activity = new Map<string, number>()
  return {
    list: vi.fn(), fetch: vi.fn(), save: vi.fn(), result: vi.fn(),
    create: vi.fn(() => ({ id: 'run' })), complete: vi.fn(), fail: vi.fn(), checkpoint: vi.fn(), activity,
    add: vi.fn((id: string) => activity.set(id, (activity.get(id) ?? 0) + 1)),
    remove: vi.fn((id: string) => {
      const count = activity.get(id) ?? 0
      if (count <= 1) activity.delete(id)
      else activity.set(id, count - 1)
    }),
    getActiveCount: vi.fn((id: string) => activity.get(id) ?? 0),
    getActive: vi.fn(() => [...activity.keys()])
  }
})
vi.mock('../stage-checkpoints', () => ({ saveStageCheckpoint: mocks.checkpoint }))
vi.mock('../remote-job-checkpoints', () => ({ listRecoverableRemoteJobs: mocks.list,
  remoteJobCheckpoints: () => ({ save: mocks.save, saveResult: mocks.result }) }))
vi.mock('../model-host-transport', () => ({ modelHostFetch: mocks.fetch }))
vi.mock('../database', () => ({ createProcessingRun: mocks.create, completeProcessingRun: mocks.complete,
  failProcessingRun: mocks.fail }))
vi.mock('../transcription-activity', () => ({ addActiveTranscription: mocks.add, removeActiveTranscription: mocks.remove,
  getActiveTranscriptionCount: mocks.getActiveCount, getActiveTranscriptions: mocks.getActive }))
import { cancelRecoveredRemote, recoveredRemoteRecordings, recoverRemoteJobs, stopRemoteRecovery } from '../remote-job-recovery'

const config = { modelHostUrl: 'https://worker.example', modelHostToken: 'fixture' }
const model = 'microsoft/VibeVoice-ASR'
const saved = { recordingId: 'recording', key: 'lookup', identity: { key: 'intent', id: 'job',
  request: { base: config.modelHostUrl, audioHash: 'audio', model, stage: 'transcription' } } }
const result = { model, modelVersion: 'fixture', text: 'Hello', segments: [{ start: 0, end: 1, text: 'Hello', speaker: '1' }] }
const completed = { id: 'job', audioHash: 'audio', status: 'completed', result,
  resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
const response = (body: unknown) => new Response(JSON.stringify(body))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockReset().mockReturnValue({ id: 'run' })
  mocks.activity.clear()
  vi.useFakeTimers()
  mocks.list.mockReturnValue([saved])
})
afterEach(async () => { stopRemoteRecovery(); await vi.advanceTimersByTimeAsync(1500); vi.useRealTimers() })

describe('remote startup observation', () => {
  it('does not admit an active local recording and leaves its activity reference intact', async () => {
    mocks.add('recording')
    await recoverRemoteJobs(config, vi.fn())
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(recoveredRemoteRecordings()).toEqual([])
    expect(mocks.getActiveCount('recording')).toBe(1)
  })

  it('stops after a local pipeline starts during a pending completion poll', async () => {
    let resolveCompletion!: (value: Response) => void
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveCompletion = resolve }))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getActiveCount('recording')).toBe(1) // recovery observer's own reference

    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    mocks.add('recording') // local queue pipeline becomes active while GET is pending
    expect(mocks.getActiveCount('recording')).toBe(2)
    resolveCompletion(response(completed))
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('local transcription pipeline'), false)
    expect(mocks.getActiveCount('recording')).toBe(1) // recovery released only its own reference
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('does not persist a completion when recovery is stopped during a pending GET', async () => {
    let resolveCompletion!: (value: Response) => void
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveCompletion = resolve }))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)

    stopRemoteRecovery()
    resolveCompletion(response(completed))
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('stopped'), false)
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.getActiveCount('recording')).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('discards completion JSON when cancellation arrives while its GET body is pending', async () => {
    let resolveJson!: (value: unknown) => void
    const pendingJson = { ok: true, status: 200, json: () => new Promise(resolve => { resolveJson = resolve }) } as Response
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockResolvedValueOnce(pendingJson)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'cancelled' }))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)

    cancelRecoveredRemote('recording')
    resolveJson(completed)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1500)

    expect(mocks.fetch).toHaveBeenCalledTimes(4)
    expect(mocks.fetch.mock.calls[2][0]).toBe('https://worker.example/v1/jobs/job/cancel')
    expect(mocks.fetch.mock.calls[2][1].method).toBe('POST')
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('cancelled'), true)
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.getActiveCount('recording')).toBe(0)
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('preserves two running recovery references when a local pipeline takes ownership', async () => {
    const second = { ...saved, key: 'second', identity: { ...saved.identity, id: 'job2' } }
    mocks.list.mockReturnValue([saved, second])
    let runNumber = 0
    mocks.create.mockImplementation(() => ({ id: `run-${++runNumber}` }))
    const firstPolls = new Set<string>()
    const pendingGets = new Map<string, (value: Response) => void>()
    mocks.fetch.mockImplementation((url: string) => {
      const jobId = url.endsWith('/job2') ? 'job2' : 'job'
      if (!firstPolls.has(jobId)) {
        firstPolls.add(jobId)
        return Promise.resolve(response({ id: jobId, audioHash: 'audio', status: 'running' }))
      }
      return new Promise<Response>(resolve => pendingGets.set(jobId, resolve))
    })
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getActiveCount('recording')).toBe(2)
    expect(mocks.create).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1500)
    expect(pendingGets.size).toBe(2)
    mocks.add('recording') // a local queue owner becomes active during both GETs
    pendingGets.get('job')!(response(completed))
    pendingGets.get('job2')!(response({ ...completed, id: 'job2' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledTimes(2)
    expect(mocks.fail.mock.calls.map(([id]) => id).sort()).toEqual(['run-1', 'run-2'])
    expect(mocks.fail.mock.calls.every(([, message, cancelled]) =>
      String(message).includes('local transcription pipeline') && cancelled === false)).toBe(true)
    expect(mocks.remove).toHaveBeenCalledTimes(2)
    expect(mocks.getActiveCount('recording')).toBe(1)
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('observes running then verified completion with authenticated GET only', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockResolvedValueOnce(response(completed))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    for (const [url, options] of mocks.fetch.mock.calls) {
      expect(url).toBe('https://worker.example/v1/jobs/job')
      expect(options.method ?? 'GET').toBe('GET')
      expect(options.headers.authorization).toBe('Bearer fixture')
    }
    expect(mocks.result).toHaveBeenCalledWith('lookup', { ...result, hostJobId: 'job' })
    expect(ready).toHaveBeenCalledWith('recording', model, 'transcription')
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.checkpoint).toHaveBeenCalledWith('recording', 'transcription', 'audio', expect.objectContaining({
      fullText: result.text, model, provider: 'vibevoice', remoteQuality: expect.objectContaining({ hostJobId: 'job' })
    }))
    expect(mocks.remove).toHaveBeenCalledWith('recording')
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('uses the retained request language during recovery after current config changes', async () => {
    const retained = { ...saved, identity: { ...saved.identity,
      request: { ...saved.identity.request!, language: 'es' } } }
    const reportedAutoResult = { ...result, language: 'auto' }
    const reportedAutoCompletion = { ...completed, result: reportedAutoResult,
      resultHash: createHash('sha256').update(JSON.stringify(reportedAutoResult)).digest('hex') }
    mocks.list.mockReturnValue([retained])
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockResolvedValueOnce(response(reportedAutoCompletion))
    const ready = vi.fn()
    const changedConfig = { ...config, language: 'en' }

    await recoverRemoteJobs(changedConfig, ready)
    await vi.advanceTimersByTimeAsync(1500)

    expect(mocks.result).toHaveBeenCalledWith('lookup', { ...reportedAutoResult, hostJobId: 'job' })
    expect(mocks.checkpoint).toHaveBeenCalledWith('recording', 'transcription', 'audio', expect.objectContaining({
      language: 'es', remoteQuality: expect.objectContaining({ requestedLanguage: 'es', reportedLanguage: 'auto',
        languageSource: 'requested' })
    }))
    expect(ready).toHaveBeenCalledWith('recording', model, 'transcription')
  })

  it('never forwards current credentials to a changed host', async () => {
    await recoverRemoteJobs({ ...config, modelHostUrl: 'https://other.example' }, vi.fn())
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('sends cancellation only after an explicit cancel and settles ownership', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'cancelled' }))
    await recoverRemoteJobs(config, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    cancelRecoveredRemote('recording')
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch.mock.calls[1][0]).toBe('https://worker.example/v1/jobs/job/cancel')
    expect(mocks.fetch.mock.calls[1][1].method).toBe('POST')
    expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('cancelled'), true)
    expect(mocks.remove).toHaveBeenCalledOnce()
  })

  it.each([409, 503, 'network failure'] as const)(
    'does not mark the remote job cancelled when the cancel request fails (%s)', async failure => {
      mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      if (typeof failure === 'number') mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: failure }))
      else mocks.fetch.mockRejectedValueOnce(new Error('cancel endpoint unavailable'))
      const ready = vi.fn()
      await recoverRemoteJobs(config, ready)
      await vi.advanceTimersByTimeAsync(0)
      cancelRecoveredRemote('recording')
      await vi.advanceTimersByTimeAsync(1500)

      expect(mocks.fetch).toHaveBeenCalledTimes(2)
      expect(mocks.fetch.mock.calls[1][0]).toBe('https://worker.example/v1/jobs/job/cancel')
      expect(mocks.fetch.mock.calls[1][1].method).toBe('POST')
      expect(mocks.save).not.toHaveBeenCalled()
      expect(mocks.result).not.toHaveBeenCalled()
      expect(mocks.checkpoint).not.toHaveBeenCalled()
      expect(mocks.complete).not.toHaveBeenCalled()
      expect(ready).not.toHaveBeenCalled()
      expect(mocks.fail).toHaveBeenCalledWith('run', expect.stringContaining('Remote cancellation not confirmed'), false)
      expect(mocks.remove).toHaveBeenCalledOnce()
      expect(mocks.getActiveCount('recording')).toBe(0)
      expect(recoveredRemoteRecordings()).toEqual([])
    }
  )

  it.each(['bad-hash', 'network-error', 'malformed-result'])('settles an observed run on %s without caching or resubmission', async failure => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
    if (failure === 'bad-hash') mocks.fetch.mockResolvedValueOnce(response({ ...completed, resultHash: 'wrong' }))
    else if (failure === 'malformed-result') {
      const invalid = { model, modelVersion: 'fixture' }
      mocks.fetch.mockResolvedValueOnce(response({ ...completed, result: invalid,
        resultHash: createHash('sha256').update(JSON.stringify(invalid)).digest('hex') }))
    } else mocks.fetch.mockRejectedValue(new Error('connection lost'))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(failure === 'network-error' ? 4500 : 1500)
    expect(mocks.fail).toHaveBeenCalledOnce()
    expect(mocks.result).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(recoveredRemoteRecordings()).toEqual([])
    expect(mocks.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true)
  })

  it('observes multiple persisted jobs for one recording independently', async () => {
    mocks.list.mockReturnValue([saved, { ...saved, key: 'second', identity: { ...saved.identity, id: 'job2' } }])
    mocks.fetch.mockImplementation(async (url: string) => response({ ...completed, id: url.endsWith('job2') ? 'job2' : 'job' }))
    await recoverRemoteJobs(config, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.result).toHaveBeenCalledTimes(2)
    expect(recoveredRemoteRecordings()).toEqual([])
  })

  it('reattaches after one transport interruption without retaining uncertain running ownership', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'job', audioHash: 'audio', status: 'running' }))
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce(response(completed))
    const ready = vi.fn()
    await recoverRemoteJobs(config, ready)
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(ready).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    expect(mocks.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true)
  })

  it('recovers through real authenticated loopback HTTP using GET only', async () => {
    vi.useRealTimers()
    const requests: { method: string | undefined; authorization: string | undefined; url: string | undefined }[] = []
    const server = createServer((req, res) => {
      requests.push({ method: req.method, authorization: req.headers.authorization, url: req.url })
      if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401); res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(requests.length === 1 ? { id: 'job', audioHash: 'audio', status: 'running' } : completed))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`
    mocks.list.mockReturnValue([{ ...saved, identity: { ...saved.identity, request: { ...saved.identity.request, base } } }])
    mocks.fetch.mockImplementation((url, options) => fetch(url, options))
    const ready = vi.fn()
    try {
      await recoverRemoteJobs({ ...config, modelHostUrl: base }, ready)
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 3500, interval: 30 })
      expect(requests).toEqual([
        { method: 'GET', authorization: 'Bearer fixture', url: '/v1/jobs/job' },
        { method: 'GET', authorization: 'Bearer fixture', url: '/v1/jobs/job' }
      ])
      expect(mocks.checkpoint).toHaveBeenCalledOnce()
      expect(recoveredRemoteRecordings()).toEqual([])
    } finally {
      stopRemoteRecovery()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
      vi.useFakeTimers()
    }
  })
})
