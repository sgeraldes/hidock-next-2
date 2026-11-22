import { modelHostFetch } from './model-host-transport'
import { REMOTE_ASR_MODELS } from '../../../src/shared/asr-models'

export const AUDIO_MODELS = {
  'local-asr': 'CohereLabs/cohere-transcribe-03-2026',
  vibevoice: 'microsoft/VibeVoice-ASR'
} as const
export type AudioRoute = { provider: 'gemini' | 'local-asr' | 'vibevoice' | 'muse-voice' | 'mai-transcribe-2'; execution: 'local' | 'remote' | 'cloud'; model: string; host?: string; lastValidatedDevice?: string }

export async function resolveAudioRoute(input: {
  provider: string; location?: string; language?: string; geminiModel: string; vibevoiceModel?: string;
  base?: string; token?: string; localFallback?: boolean; hasRemoteIdentity?: boolean; remoteAsrModel?: string
}, fetchFn: typeof fetch = fetch): Promise<AudioRoute> {
  if (input.provider === 'gemini') return { provider: 'gemini', execution: 'cloud', model: input.geminiModel }
  if (input.provider === 'muse-voice' || input.provider === 'mai-transcribe-2') {
    return { provider: input.provider, execution: 'cloud',
      model: input.provider === 'muse-voice' ? 'muse-voice-transcribe-1.0' : 'MAI-Transcribe-2' }
  }
  const provider = input.provider === 'vibevoice' ? 'vibevoice' : 'local-asr'
  const model = provider === 'vibevoice' ? input.vibevoiceModel || AUDIO_MODELS.vibevoice : AUDIO_MODELS['local-asr']
  const remoteDefault = input.provider === 'remote-worker'
  if (!remoteDefault && (!input.location || input.location === 'local')) return { provider, execution: 'local', model }
  let selected: string
  let host: string | undefined
  let lastValidatedDevice: string | undefined
  try {
    if (!input.base || !input.token) throw new Error('Pair a remote worker before using remote transcription')
    const url = new URL(input.base)
    if (url.username || url.password || url.search || url.hash) throw new Error('Worker URL must not contain credentials, query or fragment')
    host = url.host
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote transcription requires HTTPS outside loopback')
    }
    const response = await modelHostFetch(input.base.replace(/\/+$/, '') + '/v1/capabilities', {
      headers: { authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(5000)
    }, fetchFn)
    if (!response.ok) throw new Error(`Worker capability check failed (HTTP ${response.status})`)
    const caps = await response.json()
    selected = remoteDefault ? input.remoteAsrModel || caps.defaultAsrModel : model
    if (caps.protocolVersion !== 1 || !caps.stages?.includes('transcription') || !caps.models?.includes(selected) ||
        !(REMOTE_ASR_MODELS as readonly string[]).includes(selected)) throw new Error('The worker has not advertised the selected ASR engine')
    const engine = caps.engines?.find((item: { model: string }) => item.model === selected)
    if (typeof engine?.lastValidatedDevice === 'string') lastValidatedDevice = engine.lastValidatedDevice
  } catch (error) {
    // An existing durable identity may still be processing remotely. Never
    // turn a reconnect failure into a second local transcription.
    if (!remoteDefault && input.location === 'auto' && input.localFallback && !input.hasRemoteIdentity) {
      return { provider, execution: 'local', model }
    }
    throw error
  }
  // Configuration errors must not become permission to fall back locally.
  if (selected === 'Edge0/Audio8-ASR-Infinite' &&
      !['en', 'zh'].includes((input.language || '').toLowerCase().replace('_', '-').split('-')[0])) {
    throw new Error('Audio8 supports explicit English or Chinese only. Select en or zh before uploading audio.')
  }
  if (selected === AUDIO_MODELS['local-asr'] && (!input.language || input.language === 'auto' || !/^[a-z]{2,3}$/.test(input.language))) {
    throw new Error('Cohere transcription requires an explicit language. Choose a language before uploading audio.')
  }
  return { provider: selected === AUDIO_MODELS.vibevoice ? 'vibevoice' : 'local-asr', execution: 'remote', model: selected, host, ...(lastValidatedDevice ? { lastValidatedDevice } : {}) }
}
