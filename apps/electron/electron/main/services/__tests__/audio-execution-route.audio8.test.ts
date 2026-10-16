// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AUDIO_MODELS, resolveAudioRoute } from '../audio-execution-route'
import { REMOTE_ASR_MODELS } from '../../../../src/shared/asr-models'
import { AUDIO8_ASR } from '../../../../../model-host/src/asr-catalog.mjs'

// The id comes from the host catalog, not from a copy in this file.
const AUDIO8 = Object.keys(AUDIO8_ASR)[0]
// An engine with no language guard of its own: Cohere (local-asr) requires an explicit language,
// and the Audio8 engine is the one under test.
const routedByProvider = Object.values(AUDIO_MODELS) as string[]
const OTHER = REMOTE_ASR_MODELS.find(model => model !== AUDIO8 && !routedByProvider.includes(model))!

const base = { provider: 'remote-worker', geminiModel: 'cloud-model', base: 'https://worker.example',
  token: 'fixture-token', remoteAsrModel: AUDIO8 }
const capabilities = (models: string[], overrides = {}) => ({ protocolVersion: 1, stages: ['transcription'],
  models, defaultAsrModel: models[0], engines: models.map(model => ({ model, lastValidatedDevice: 'fixture-device' })), ...overrides })
const ready = () => vi.fn().mockImplementation(async () => new Response(JSON.stringify(capabilities([AUDIO8, OTHER]))))
const calledUrls = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([url]) => String(url))

describe('Audio8 language admission in the audio route', () => {
  it.each(['es', 'auto', '', undefined, 'fr', 'es-ES', 'pt_BR'])(
    'rejects Audio8 with language %j without creating or uploading a job', async language => {
      const request = ready()
      await expect(resolveAudioRoute({ ...base, language }, request)).rejects.toThrow('English or Chinese')
      // At most the capability check. Never a job, an upload or a non-GET call.
      expect(request.mock.calls.length).toBeLessThanOrEqual(1)
      expect(calledUrls(request).every(url => url === 'https://worker.example/v1/capabilities')).toBe(true)
      expect(request.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
    })

  it.each(['en', 'zh', 'EN', 'en-US', 'zh_CN', 'zh-TW'])('admits Audio8 with language %s when the host advertises it', async language => {
    const request = ready()
    await expect(resolveAudioRoute({ ...base, language }, request)).resolves.toEqual({
      provider: 'local-asr', execution: 'remote', model: AUDIO8, host: 'worker.example', lastValidatedDevice: 'fixture-device' })
    expect(calledUrls(request)).toEqual(['https://worker.example/v1/capabilities'])
  })

  it('does not turn a language rejection into a local run, even when auto fallback is enabled', async () => {
    const request = ready()
    await expect(resolveAudioRoute({ ...base, language: 'es', location: 'auto', localFallback: true }, request))
      .rejects.toThrow('English or Chinese')
  })

  it('does not swap Audio8 for the host default when the host does not advertise it', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify(capabilities([OTHER]))))
    await expect(resolveAudioRoute({ ...base, language: 'en' }, request)).rejects.toThrow('not advertised')
  })

  it('returns exactly the configured model for every selectable engine and leaves the input untouched', async () => {
    for (const model of REMOTE_ASR_MODELS) {
      const language = model === AUDIO8 ? 'en' : 'es'
      const input = Object.freeze({ ...base, remoteAsrModel: model, language })
      // The advertised default differs from the selection, so a silent fallback to the default would show up.
      const decoy = REMOTE_ASR_MODELS.find(candidate => candidate !== model)!
      const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify(capabilities([decoy, model]))))
      const route = await resolveAudioRoute(input, request)
      expect(route.model, model).toBe(model)
      expect(route.execution, model).toBe('remote')
      expect(input.language, model).toBe(language)
      expect(input.remoteAsrModel, model).toBe(model)
    }
  })

  it('applies the Audio8 language rule only to Audio8', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify(capabilities([AUDIO8, OTHER]))))
    await expect(resolveAudioRoute({ ...base, remoteAsrModel: OTHER, language: 'es' }, request))
      .resolves.toMatchObject({ model: OTHER, execution: 'remote' })
    await expect(resolveAudioRoute({ ...base, remoteAsrModel: OTHER, language: 'auto' }, request))
      .resolves.toMatchObject({ model: OTHER, execution: 'remote' })
  })
})
