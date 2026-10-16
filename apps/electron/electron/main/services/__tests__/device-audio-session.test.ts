// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DeviceAudioSession, type DeviceAudioSessionDeps } from '../device-audio-session'

function setup(overrides: Partial<DeviceAudioSessionDeps> = {}) {
  const deps = {
    startDevice: vi.fn(async () => ({ result: 'success' })),
    pauseDevice: vi.fn(async () => ({ result: 'success' })),
    stopDevice: vi.fn(async () => ({ result: 'success' })),
    startTranscription: vi.fn(async () => undefined),
    pauseTranscription: vi.fn(), stopTranscription: vi.fn(async () => undefined),
    startRecording: vi.fn(), finishRecording: vi.fn(), beginDiagnostics: vi.fn(), noteDiscontinuity: vi.fn(), ...overrides
  }
  return { deps, session: new DeviceAudioSession(deps) }
}

describe('device live stream ownership', () => {
  it('retains one capture across an acknowledged stop when native pause is rejected', async () => {
    const { deps, session } = setup({ pauseDevice: async () => ({ result: 'failed' }) })
    await session.start(1)
    const id = session.snapshot().sessionId
    expect(await session.pause(1)).toMatchObject({ result: 'success', pauseMethod: 'stream-stop-restart', nativePauseResult: 'failed' })
    expect(session.canRead(1)).toBe(false)
    expect(deps.finishRecording).not.toHaveBeenCalled()
    expect(deps.noteDiscontinuity).toHaveBeenCalledWith('paused-by-stream-stop')
    await session.start(1)
    expect(session.snapshot()).toMatchObject({ sessionId: id, status: 'streaming' })
    expect(deps.startDevice).toHaveBeenCalledTimes(2)
    expect(deps.startRecording).toHaveBeenCalledOnce()
  })
  it('does not claim paused when both pause and fallback stop are rejected', async () => {
    const { session } = setup({ pauseDevice: async () => ({ result: 'failed' }), stopDevice: async () => ({ result: 'failed' }) })
    await session.start(1)
    expect(await session.pause(1)).toMatchObject({ result: 'failed' })
    expect(session.snapshot().status).toBe('streaming')
  })
  it('does not issue fallback stop after an inconclusive pause reply', async () => {
    const { deps, session } = setup({ pauseDevice: async () => null })
    await session.start(1)
    expect(await session.pause(1)).toBeNull()
    expect(deps.stopDevice).not.toHaveBeenCalled()
  })
  it('a late fallback stop cannot undo disconnect', async () => {
    let release!: (value: { result: string }) => void
    const { session } = setup({ pauseDevice: async () => ({ result: 'failed' }), stopDevice: () => new Promise(resolve => { release = resolve }) })
    await session.start(1)
    const paused = session.pause(1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await session.endLocally('disconnected')
    release({ result: 'success' })
    expect(await paused).toMatchObject({ result: 'failed' })
    expect(session.snapshot().status).toBe('idle')
  })
  it('captures without constructing or calling an AI provider', async () => {
    const { deps, session } = setup()
    expect(await session.start(1)).toMatchObject({ result: 'success', transcribe: false, saveRecording: true })
    expect(deps.startTranscription).not.toHaveBeenCalled()
    expect(deps.startRecording).toHaveBeenCalledOnce()
    expect(session.canRead(1)).toBe(true)
    expect(session.canRead(2)).toBe(false)
  })
  it('does not hold the dequeue loop behind a provider connection', async () => {
    const { session } = setup({ startTranscription: () => new Promise(() => undefined) })
    expect(await session.start(1, { transcribe: true })).toMatchObject({ result: 'success' })
    expect(session.canRead(1)).toBe(true)
  })
  it('provider failure leaves capture active and records its error', async () => {
    const { session } = setup({ startTranscription: async () => { throw new Error('No provider key') } })
    await session.start(1, { transcribe: true })
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: 'streaming', transcriptionError: 'No provider key' }))
  })
  it('serializes double starts and rejects competing owners', async () => {
    const { deps, session } = setup()
    await Promise.all([session.start(1), session.start(1)])
    expect(deps.startDevice).toHaveBeenCalledOnce()
    expect(await session.start(2)).toMatchObject({ result: 'failed' })
    expect(await session.stop(2)).toMatchObject({ result: 'failed' })
  })
  it('resume retains the capture file, settings and session identifier', async () => {
    const { deps, session } = setup()
    await session.start(1, { transcribe: false })
    const id = session.snapshot().sessionId
    await session.pause(1)
    expect(session.canRead(1)).toBe(false)
    await session.start(1, { transcribe: true })
    expect(session.snapshot()).toMatchObject({ sessionId: id, transcribe: false, status: 'streaming' })
    expect(deps.startRecording).toHaveBeenCalledOnce()
  })
  it('failed starts never open a file and failed stops still tear down locally', async () => {
    const first = setup({ startDevice: async () => ({ result: 'failed' }) })
    await first.session.start(1)
    expect(first.deps.startRecording).not.toHaveBeenCalled()
    expect(first.session.snapshot().status).toBe('idle')
    const second = setup({ stopDevice: async () => { throw new Error('Disconnected') } })
    await second.session.start(1)
    await expect(second.session.stop(1)).rejects.toThrow('Disconnected')
    expect(second.deps.finishRecording).toHaveBeenCalledOnce()
    expect(second.session.snapshot().status).toBe('idle')
  })
  it('a disconnect during start cannot re-open recording or transcription', async () => {
    let resolve!: (result: { result: string }) => void
    const { deps, session } = setup({ startDevice: () => new Promise(r => { resolve = r }) })
    const pending = session.start(1)
    await Promise.resolve()
    session.endLocally('disconnected')
    resolve({ result: 'success' })
    expect(await pending).toMatchObject({ result: 'failed' })
    expect(session.snapshot().status).toBe('idle')
    expect(deps.startRecording).not.toHaveBeenCalled()
  })

  it('a recording-start failure keeps an owned stream with explicit recording error', async () => {
    const { session } = setup({ startRecording: () => { throw new Error('Disk full') } })
    expect(await session.start(1)).toMatchObject({ result: 'success', status: 'streaming', saveRecording: false, recordingError: 'Disk full' })
    expect(session.canRead(1)).toBe(true)
  })

  it('a synchronous provider-start failure leaves capture streaming', async () => {
    const { session } = setup({ startTranscription: () => { throw new Error('Provider construction failed') } })
    await session.start(1, { transcribe: true })
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: 'streaming', transcriptionError: 'Provider construction failed' }))
  })

  it('file finalization failure cannot prevent provider cleanup or release ownership', async () => {
    const { deps, session } = setup({ finishRecording: () => { throw new Error('Disk failure') } })
    await session.start(1)
    await expect(session.stop(1)).rejects.toThrow('Disk failure')
    expect(deps.stopTranscription).toHaveBeenCalledOnce()
    expect(session.snapshot().status).toBe('idle')
  })

  it('local end clears resources despite throwing callbacks without issuing USB commands', async () => {
    const { deps, session } = setup({ noteDiscontinuity: () => { throw new Error('Diagnostic failure') },
      finishRecording: () => { throw new Error('Disk failure') }, stopTranscription: () => { throw new Error('Provider failure') } })
    await session.start(1)
    await session.endLocally('reset')
    expect(session.snapshot().status).toBe('idle')
    expect(deps.stopDevice).not.toHaveBeenCalled()
  })

  it('disconnect cannot be undone by an old pause response', async () => {
    let resolve!: (result: { result: string }) => void
    const { session } = setup({ pauseDevice: () => new Promise(r => { resolve = r }) })
    await session.start(1)
    const paused = session.pause(1)
    await Promise.resolve()
    await session.endLocally('disconnected')
    resolve({ result: 'success' })
    expect(await paused).toMatchObject({ result: 'failed' })
    expect(session.snapshot().status).toBe('idle')
  })

  it('invalidates reads immediately on stop and across pause/resume of the same session', async () => {
    const { session } = setup()
    await session.start(1)
    const id = session.snapshot().sessionId, original = session.readGeneration
    await session.pause(1)
    await session.start(1)
    expect(session.snapshot().sessionId).toBe(id)
    expect(session.readGeneration).not.toBe(original)
    const stopping = session.stop(1)
    expect(session.canRead(1)).toBe(false)
    await stopping
  })

  it('local invalidation cancels starts already queued before disconnect', async () => {
    const { deps, session } = setup()
    const started = session.start(1)
    await session.endLocally('disconnected')
    expect(await started).toMatchObject({ result: 'failed' })
    expect(deps.startDevice).not.toHaveBeenCalled()
  })

  it('disconnect during failed-resume provider cleanup cannot resurrect paused state', async () => {
    let release!: () => void
    const { deps, session } = setup()
    await session.start(1)
    await session.pause(1)
    vi.mocked(deps.startDevice).mockResolvedValueOnce({ result: 'failed' })
    vi.mocked(deps.stopTranscription).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const resumed = session.start(1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await session.endLocally('disconnected')
    release()
    expect(await resumed).toMatchObject({ result: 'failed' })
    expect(session.snapshot().status).toBe('idle')
  })

  it('successful resume retries a failed optional provider without retaining a stale error', async () => {
    const { deps, session } = setup()
    vi.mocked(deps.startTranscription).mockRejectedValueOnce(new Error('First connection failed'))
    await session.start(1, { transcribe: true })
    await vi.waitFor(() => expect(session.snapshot().transcriptionError).toBe('First connection failed'))
    await session.pause(1)
    await session.start(1)
    await vi.waitFor(() => expect(deps.startTranscription).toHaveBeenCalledTimes(2))
    expect(session.snapshot().transcriptionError).toBeNull()
  })
})
