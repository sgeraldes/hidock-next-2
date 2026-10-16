// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AUDIO_MODELS, resolveAudioRoute } from '../audio-execution-route'

const input = { provider: 'local-asr', language: 'es', geminiModel: 'cloud-model', base: 'https://worker.example', token: 'test-token' }
const capabilities = (overrides = {}) => ({ protocolVersion: 1, stages: ['transcription'],
  models: Object.values(AUDIO_MODELS), defaultAsrModel: AUDIO_MODELS.vibevoice, ...overrides })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('audio execution routing', () => {
  it.each(['muse-voice', 'mai-transcribe-2'])('keeps %s in the cloud even when remote/local preferences are set', async provider => {
    const request = vi.fn()
    await expect(resolveAudioRoute({ ...input, provider, location: 'local' }, request))
      .resolves.toMatchObject({ provider, execution: 'cloud' })
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['nvidia/parakeet-tdt-0.6b-v3', 'Qwen/Qwen3-ASR-0.6B',
    'nvidia/nemotron-3.5-asr-streaming-0.6b'])('routes explicitly selected %s only when validated remotely', async model => {
    const configured = { ...input, provider: 'remote-worker', remoteAsrModel: model, language: 'auto' }
    await expect(resolveAudioRoute(configured, vi.fn().mockResolvedValue(response(capabilities({ models: [model] })))))
      .resolves.toMatchObject({ model, execution: 'remote' })
    await expect(resolveAudioRoute(configured, vi.fn().mockResolvedValue(response(capabilities()))))
      .rejects.toThrow('not advertised')
  })
  it.each([undefined, 'auto'])('rejects remote Cohere language %s even with auto fallback enabled', async language => {
    const request = vi.fn().mockResolvedValue(response(capabilities()))
    await expect(resolveAudioRoute({ ...input, language, location: 'auto', localFallback: true }, request))
      .rejects.toThrow('explicit language')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a remote default Cohere model with automatic language', async () => {
    await expect(resolveAudioRoute({ ...input, provider: 'remote-worker', language: 'auto' },
      vi.fn().mockResolvedValue(response(capabilities({ defaultAsrModel: AUDIO_MODELS['local-asr'] })))))
      .rejects.toThrow('explicit language')
  })

  it('allows explicitly selected language for remote Cohere and auto language for remote VibeVoice', async () => {
    const request = vi.fn().mockImplementation(async () => response(capabilities()))
    await expect(resolveAudioRoute({ ...input, location: 'remote' }, request))
      .resolves.toMatchObject({ execution: 'remote', model: AUDIO_MODELS['local-asr'] })
    await expect(resolveAudioRoute({ ...input, provider: 'vibevoice', location: 'remote', language: 'auto' }, request))
      .resolves.toMatchObject({ execution: 'remote', model: AUDIO_MODELS.vibevoice, host: 'worker.example' })
  })

  it('keeps cloud and explicitly local requests independent of the remote host', async () => {
    const request = vi.fn()
    await expect(resolveAudioRoute({ ...input, provider: 'gemini', location: 'remote' }, request))
      .resolves.toEqual({ provider: 'gemini', execution: 'cloud', model: 'cloud-model' })
    await expect(resolveAudioRoute({ ...input, location: 'local' }, request))
      .resolves.toEqual({ provider: 'local-asr', execution: 'local', model: AUDIO_MODELS['local-asr'] })
    expect(request).not.toHaveBeenCalled()
  })

  it('selects the advertised remote default through an authenticated request without redirects', async () => {
    const request = vi.fn().mockResolvedValue(response(capabilities()))
    await expect(resolveAudioRoute({ ...input, provider: 'remote-worker' }, request))
      .resolves.toEqual({ provider: 'vibevoice', execution: 'remote', model: AUDIO_MODELS.vibevoice, host: 'worker.example' })
    expect(request).toHaveBeenCalledWith('https://worker.example/v1/capabilities', expect.objectContaining({
      headers: { authorization: 'Bearer test-token' }, redirect: 'error', signal: expect.any(AbortSignal)
    }))
  })

  it.each([
    { defaultAsrModel: 'unrecognized-model', models: ['unrecognized-model'] },
    { models: [AUDIO_MODELS['local-asr']] },
    { stages: ['diarization'] },
    { protocolVersion: 2 }
  ])('rejects unadvertised or unsupported defaults: %j', async (caps) => {
    await expect(resolveAudioRoute({ ...input, provider: 'remote-worker' },
      vi.fn().mockResolvedValue(response(capabilities(caps))))) .rejects.toThrow('not advertised')
  })

  it('does not send credentials over non-loopback HTTP', async () => {
    const request = vi.fn()
    await expect(resolveAudioRoute({ ...input, location: 'remote', base: 'http://worker.example' }, request))
      .rejects.toThrow('HTTPS')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { location: 'auto', localFallback: false },
    { location: 'auto', localFallback: true, hasRemoteIdentity: true },
    { location: 'remote', localFallback: true },
    { provider: 'remote-worker', location: 'auto', localFallback: true }
  ])('refuses fallback without explicit eligible auto permission: %j', async (options) => {
    await expect(resolveAudioRoute({ ...input, ...options }, vi.fn().mockRejectedValue(new Error('offline'))))
      .rejects.toThrow('offline')
  })

  it('allows explicitly opted-in auto fallback before any durable remote identity exists', async () => {
    await expect(resolveAudioRoute({ ...input, location: 'auto', localFallback: true },
      vi.fn().mockRejectedValue(new Error('offline'))))
      .resolves.toEqual({ provider: 'local-asr', execution: 'local', model: AUDIO_MODELS['local-asr'] })
  })

  it('rejects an unauthenticated capability response', async () => {
    await expect(resolveAudioRoute({ ...input, location: 'remote' },
      vi.fn().mockResolvedValue(response({}, 401)))).rejects.toThrow('HTTP 401')
  })
})
