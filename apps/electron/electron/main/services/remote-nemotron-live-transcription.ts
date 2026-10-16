import WebSocket from 'ws'
import { X509Certificate } from 'crypto'
import type { RealtimeData } from '@hidock/jensen-protocol'
import type { LiveTranscriptionSender } from './gemini-live-transcription'
import { liveStereoToMono } from './live-pcm'
import { modelHostFetch } from './model-host-transport'

const MODEL = 'nvidia/nemotron-3.5-asr-streaming-0.6b'
export interface RemoteLiveSettings { modelHostUrl?: string; modelHostToken?: string; modelHostCertificatePem?: string;
  liveTranscriptionLanguage?: 'en' | 'es' }

/** No reconnect/replay: capture and disk recording continue independently on failure. */
export class RemoteNemotronLiveTranscription {
  private socket?: WebSocket
  private sender?: LiveTranscriptionSender
  private ready = false
  private generation = 0
  private interim = ''
  private deadline?: ReturnType<typeof setTimeout>
  constructor(private readonly settings: () => RemoteLiveSettings,
    private readonly capabilityFetch: typeof modelHostFetch = modelHostFetch) {}
  private emit(kind: string, value: object): void {
    if (!this.sender?.isDestroyed()) this.sender?.send(`transcription-live:${kind}`, value)
  }
  private fail(error: string): void {
    this.ready = false
    this.emit('error', { error }); this.emit('status', { status: 'error' })
    this.socket?.terminate()
  }
  async start(sender: LiveTranscriptionSender): Promise<void> {
    this.pause()
    this.sender = sender; this.interim = ''
    const generation = ++this.generation
    const config = this.settings(), url = new URL(config.modelHostUrl || '')
    if (url.username || url.password || url.search || url.hash) throw Error('Invalid paired worker URL')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw Error('Live remote ASR requires HTTPS')
    if (!config.modelHostToken) throw Error('Pair the worker before live transcription')
    if (url.protocol === 'https:' && !config.modelHostCertificatePem) throw Error('The paired worker certificate is missing')
    if (config.modelHostCertificatePem) new X509Certificate(config.modelHostCertificatePem)
    const language = config.liveTranscriptionLanguage || 'es'
    if (!['en', 'es'].includes(language)) throw Error('Live Nemotron currently requires en or es')
    const response = await this.capabilityFetch(`${url.href.replace(/\/+$/, '')}/v1/capabilities`, {
      headers: { authorization: `Bearer ${config.modelHostToken}` }, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw Error(`Live worker capability check failed (${response.status})`)
    const caps = await response.json()
    if (caps.protocolVersion !== 1 || !caps.realtimeAsrModels?.includes(MODEL))
      throw Error('The worker has not validated Nemotron realtime ASR')
    if (generation !== this.generation) return
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/v1/audio/transcriptions/realtime'
    this.emit('status', { status: 'connecting' })
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${config.modelHostToken}` },
      ...(config.modelHostCertificatePem ? { ca: config.modelHostCertificatePem } : {}),
      rejectUnauthorized: true, handshakeTimeout: 5000, maxPayload: 256000, perMessageDeflate: false })
    this.socket = socket
    this.deadline = setTimeout(() => this.fail('Live worker startup timed out'), 50000)
    socket.on('error', () => { if (generation === this.generation) this.fail('Live worker connection failed') })
    socket.on('close', () => {
      if (generation !== this.generation) return
      clearTimeout(this.deadline); this.ready = false
      this.emit('status', { status: 'stopped' })
    })
    socket.on('message', data => {
      if (generation !== this.generation) return
      let event
      try { event = JSON.parse(data.toString()) } catch { this.fail('Invalid live worker response'); return }
      if (event.type === 'session.created') socket.send(JSON.stringify({ type: 'session.update', session: {
        sample_rate: 16000, language, word_timestamps: true, speaker_diarization: false } }))
      else if (event.type === 'session.updated') {
        clearTimeout(this.deadline); this.ready = true; this.emit('status', { status: 'listening' })
      } else if (event.type?.endsWith('.delta') && typeof event.delta === 'string') {
        this.interim += event.delta
        if (this.interim.length > 100000) return this.fail('Live transcript exceeded its text limit')
        this.emit('interim', { text: this.interim, speaker: 'speaker', channel: null })
      } else if (event.type?.endsWith('.completed') && typeof event.transcript === 'string') {
        this.emit('final', { text: event.transcript, speaker: 'speaker', channel: null }); this.interim = ''
      } else if (event.type === 'error') this.fail(event.error?.message || 'Live worker failed')
    })
  }
  acceptDevicePacket(packet: RealtimeData): void {
    // While connecting, do not buffer or replay old audio into the live session.
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return
    try {
      const pcm = liveStereoToMono(packet)
      if (this.socket.bufferedAmount + pcm.length > 64000) return this.fail('Live audio backlog exceeded two seconds; capture continues')
      for (let offset = 0; offset < pcm.length; offset += 32000) this.socket.send(pcm.subarray(offset, offset + 32000))
    } catch (error) { this.fail(error instanceof Error ? error.message : 'Live audio failed') }
  }
  pause(): void {
    ++this.generation; this.ready = false; clearTimeout(this.deadline)
    const socket = this.socket; this.socket = undefined
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'response.cancel' })); socket.close()
      setTimeout(() => socket.terminate(), 1000).unref()
    } else socket?.terminate()
  }
  async stop(): Promise<void> {
    this.ready = false
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) { this.pause(); return }
    this.emit('status', { status: 'finalizing' })
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { socket.terminate(); resolve() }, 16000)
      socket.once('close', () => { clearTimeout(timer); resolve() })
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    })
    this.pause()
  }
}
