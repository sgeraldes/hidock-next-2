/** Opt-in file adapters. No downloads, retries, transcoding, or cross-request speaker linking.
 * Contracts: https://dev.meta.ai/docs/speech-to-text
 * https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
 * https://learn.microsoft.com/rest/api/speechtotext/transcriptions/transcribe?view=rest-speechtotext-2025-10-15
 */
import { randomUUID } from 'node:crypto'

export interface CloudFileOptions {
  audio: Uint8Array
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Test transport injection only; production uses native fetch. */
  fetchFn?: typeof fetch
}
export interface CloudTurn {
  text: string
  start: number
  end: number
  speaker: string
  speakerAttribution: 'diarization' | 'unresolved'
  timestampSource: 'provider-turn-timestamps' | 'provider-phrase-timestamps'
  words?: { word: string; start: number; end: number }[]
}
export interface CloudFileResult {
  model: string
  requestId: string
  text: string
  segments: CloudTurn[]
  audioSeconds: number
  speakerIdentityScope: 'request'
  streaming: false
}

// Deliberately smaller than the providers' full file APIs: predictable client
// memory and short diarization requests until long-audio accuracy is evaluated.
const MAX_AUDIO_BYTES = 31_000_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function pcmWavDuration(audio: Uint8Array): number {
  if (audio.byteLength < 44 || audio.byteLength > MAX_AUDIO_BYTES) throw new Error('Cloud ASR WAV size limit')
  const b = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE'
      || b.readUInt32LE(4) + 8 !== b.length) throw new Error('Cloud ASR requires a complete PCM WAV')
  let rate = 0
  let dataBytes = -1
  let fmtSeen = false
  let pos = 12
  for (; pos + 8 <= b.length;) {
    const id = b.toString('ascii', pos, pos + 4)
    const size = b.readUInt32LE(pos + 4)
    const start = pos + 8
    if (start + size > b.length) throw new Error('Truncated WAV chunk')
    if (id === 'fmt ') {
      if (fmtSeen || size < 16 || b.readUInt16LE(start) !== 1 || b.readUInt16LE(start + 2) !== 1
          || b.readUInt16LE(start + 14) !== 16 || b.readUInt16LE(start + 12) !== 2) {
        throw new Error('Cloud ASR requires mono PCM16 WAV')
      }
      rate = b.readUInt32LE(start + 4)
      if (![16000, 24000].includes(rate) || b.readUInt32LE(start + 8) !== rate * 2) {
        throw new Error('Cloud ASR requires 16 or 24 kHz WAV')
      }
      fmtSeen = true
    } else if (id === 'data') {
      if (dataBytes !== -1 || size % 2) throw new Error('Invalid WAV data chunk')
      dataBytes = size
    }
    pos = start + size + (size % 2)
  }
  const seconds = dataBytes / (rate * 2)
  if (pos !== b.length || !fmtSeen || !Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error('Cloud ASR requires a complete WAV of at most ten minutes')
  }
  return seconds
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cloud ASR response')
  return value as Record<string, unknown>
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid cloud ASR timing')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid cloud ASR transcript')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Incomplete cloud ASR response')
  return value
}
function timing(startMs: unknown, endMs: unknown, duration: number): { start: number; end: number } {
  const start = number(startMs) / 1000
  const end = number(endMs) / 1000
  if (start < 0 || end <= start || end > duration) throw new Error('Cloud ASR timing outside source audio')
  return { start, end }
}
function completeDuration(value: unknown, duration: number): void {
  // Metadata rounds to milliseconds; do not confuse trailing silence with truncation.
  if (Math.abs(number(value) / 1000 - duration) > 0.002) throw new Error('Incomplete cloud ASR audio coverage')
}
function completeText(full: string, segments: CloudTurn[]): void {
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim()
  if (normalized(full) !== normalized(segments.map(row => row.text).join(' '))) {
    throw new Error('Incomplete cloud ASR transcript turns')
  }
}
function speaker(value: unknown, id: string): Pick<CloudTurn, 'speaker' | 'speakerAttribution'> {
  if (value === undefined || value === null) return { speaker: 'Speaker unresolved', speakerAttribution: 'unresolved' }
  if ((typeof value !== 'string' && typeof value !== 'number')
      || !/^[\w-]{1,64}$/.test(String(value))) throw new Error('Invalid cloud ASR speaker label')
  return { speaker: `${id}:${value}`, speakerAttribution: 'diarization' }
}

async function post(url: URL, body: FormData, headers: Record<string, string>, options: CloudFileOptions): Promise<unknown> {
  const timeout = options.timeoutMs ?? 180_000
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) throw new Error('Invalid cloud ASR deadline')
  if (!options.apiKey.trim()) throw new Error('Cloud ASR API key required')
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeout)
  try {
    if (controller.signal.aborted) throw new Error('cancelled')
    const response = await (options.fetchFn ?? fetch)(url, {
      method: 'POST', headers: { ...headers, Accept: 'application/json' }, body,
      signal: controller.signal, redirect: 'error'
    })
    if (!response.ok) {
      await response.body?.cancel()
      // Provider bodies can echo keys, input text or signed URLs. Never expose them.
      throw new Error(`Cloud ASR HTTP ${response.status}; request was not retried`)
    }
    if (!response.body) throw new Error('Empty cloud ASR response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('Cloud ASR response exceeds limit')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (parseError) { throw new Error('Malformed or truncated cloud ASR JSON', { cause: parseError }) }
  } catch (error) {
    // Only fixed messages generated here survive. The transport error is dropped
    // on purpose: it can carry the request URL and headers, credentials included,
    // and an attached `cause` would follow the error into every log.
    // eslint-disable-next-line preserve-caught-error -- see above
    if (controller.signal.aborted) throw new Error('Cloud ASR cancelled or timed out; outcome unknown; not retried')
    if (error instanceof Error && /^(Cloud ASR HTTP \d{3};|Empty cloud ASR response$|Cloud ASR response exceeds limit$|Malformed or truncated cloud ASR JSON$)/.test(error.message)) throw error
    // eslint-disable-next-line preserve-caught-error -- see above
    throw new Error('Cloud ASR transport failed; outcome unknown; not retried')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function transcribeMuseVoice(options: CloudFileOptions): Promise<CloudFileResult> {
  const duration = pcmWavDuration(options.audio)
  const id = randomUUID()
  const form = new FormData()
  form.append('request', new Blob([JSON.stringify({
    mode: 'DIARIZATION', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV'
  })], { type: 'application/json' }))
  form.append('audio', new Blob([Uint8Array.from(options.audio)], { type: 'audio/wav' }), 'audio.wav')
  const url = new URL('https://api.meta.ai/v1/asr/transcribe')
  url.searchParams.set('sessionId', id)
  const result = object(await post(url, form, { Authorization: `Bearer ${options.apiKey}` }, options))
  completeDuration(result.audioDurationMs, duration)
  const seen = new Set<unknown>()
  const segments = array(result.turns).map(value => {
    const row = object(value)
    if (!Number.isInteger(row.turnId) || seen.has(row.turnId)) throw new Error('Invalid cloud ASR turn ID')
    seen.add(row.turnId)
    return { text: text(row.transcript), ...timing(row.startMs, row.endMs, duration), ...speaker(row.speaker, id),
      timestampSource: 'provider-turn-timestamps' as const }
  })
  const full = text(result.transcript)
  completeText(full, segments)
  return { model: 'muse-voice-transcribe-1.0', requestId: id, text: full, segments,
    audioSeconds: duration, speakerIdentityScope: 'request', streaming: false }
}

export async function transcribeMaiTranscribe2(options: CloudFileOptions & { endpoint: string }): Promise<CloudFileResult> {
  const duration = pcmWavDuration(options.audio)
  let url: URL
  try { url = new URL(options.endpoint) } catch { throw new Error('Invalid Azure Speech endpoint') }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the Azure Speech resource HTTPS origin')
  }
  url.pathname = '/speechtotext/transcriptions:transcribe'
  url.search = '?api-version=2025-10-15'
  const id = randomUUID()
  const form = new FormData()
  form.append('definition', JSON.stringify({ enhancedMode: { enabled: true, model: 'MAI-Transcribe-2',
    modelOptions: { timestamps: 'word', transcribeStyle: 'verbatim' } }, diarization: { enabled: true } }))
  form.append('audio', new Blob([Uint8Array.from(options.audio)], { type: 'audio/wav' }), 'audio.wav')
  const result = object(await post(url, form, { 'Ocp-Apim-Subscription-Key': options.apiKey }, options))
  completeDuration(result.durationMilliseconds, duration)
  const segments = array(result.phrases).map(value => {
    const row = object(value)
    const bounds = timing(row.offsetMilliseconds,
      number(row.offsetMilliseconds) + number(row.durationMilliseconds), duration)
    const words = array(row.words).map(value => {
      const word = object(value)
      const wordBounds = timing(word.offsetMilliseconds,
        number(word.offsetMilliseconds) + number(word.durationMilliseconds), duration)
      if (wordBounds.start < bounds.start || wordBounds.end > bounds.end) throw new Error('Cloud ASR word outside phrase')
      return { word: text(word.text), ...wordBounds }
    })
    if (text(row.text).trim() && !words.length) throw new Error('Cloud ASR omitted requested word timestamps')
    return { text: text(row.text), ...bounds, ...speaker(row.speaker, id), words,
      timestampSource: 'provider-phrase-timestamps' as const }
  })
  const combined = array(result.combinedPhrases)
  if (combined.length > 1) throw new Error('Unexpected multichannel cloud ASR response')
  const full = combined.length ? text(object(combined[0]).text) : ''
  completeText(full, segments)
  return { model: 'MAI-Transcribe-2', requestId: id, text: full, segments,
    audioSeconds: duration, speakerIdentityScope: 'request', streaming: false }
}
