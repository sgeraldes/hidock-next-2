import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  type Session,
} from '@google/genai'
import type { RealtimeData } from '@hidock/jensen-protocol'
import { resolveGeminiApiKey } from './brains'
import { getConfig, updateConfig } from './config'

export const GEMINI_LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live'

/** Documented Live session ceiling is 10 minutes; rotate with a minute of slack. */
const LIVE_SESSION_ROTATE_MS = 9 * 60 * 1000

/**
 * Below this a channel is treated as silent and not sent.
 *
 * Two Live sessions cost twice the minutes of one, and in a normal meeting one
 * person talks at a time, so the quiet channel is most of the bill for nothing.
 * -45 dBFS on 16-bit is ~184 of 32768: above room noise and the device's own
 * handling noise, below any speech that Gemini could transcribe anyway.
 */
const SILENCE_RMS = 184

/** How much audio the channel identification looks at before it commits. */
const IDENTIFY_MS = 10_000
const IDENTIFY_MAX_PACKETS = 200
/** Two channels within this ratio (~3 dB) are too close to call. */
const IDENTIFY_MIN_RATIO = 1.41

export type SpeakerLabel = 'you' | 'them' | 'speaker-1' | 'speaker-2' | 'speaker'

export interface LiveTranscriptionSender {
  isDestroyed(): boolean
  send(channel: string, payload?: unknown): void
}

type LiveClient = Pick<GoogleGenAI, 'live'>

/** One de-interleaved mono channel of a realtime packet, plus its loudness. */
export interface RealtimeChannel {
  /** Mono PCM16LE at 16 kHz — the format the Live API documents. */
  pcm: Uint8Array
  /** Root mean square of this channel's samples, in 16-bit units. */
  rms: number
}

/**
 * De-interleave a HiDock realtime packet into its two channels.
 *
 * The device sends an 8-byte metadata header followed by **stereo** PCM16LE
 * (`RealtimeData`, jensen-device.ts). The previous implementation averaged the
 * two into mono, which threw away the only thing that can attribute a turn: the
 * Live API does no diarization ("Speaker diarization: Not available in live
 * streaming"), so one channel being the microphone and the other the far side
 * IS the speaker attribution. Averaging destroyed it before it left the machine.
 *
 * Returns null when there is nothing usable (muted, header only, or a payload
 * that is not a whole number of stereo frames' worth of samples to read).
 */
export function splitRealtimeChannels(packet: RealtimeData): [RealtimeChannel, RealtimeChannel] | null {
  if (packet.muted || packet.data.length <= 8) return null
  const input = packet.data.subarray(8)
  const frameCount = Math.floor(input.length / 4)
  if (frameCount === 0) return null

  const left = new Uint8Array(frameCount * 2)
  const right = new Uint8Array(frameCount * 2)
  // A stereo frame is 4 bytes, so `frameCount * 4` never reads past `input`.
  const inView = new DataView(input.buffer, input.byteOffset, frameCount * 4)
  const leftView = new DataView(left.buffer)
  const rightView = new DataView(right.buffer)
  let leftSum = 0
  let rightSum = 0

  for (let frame = 0; frame < frameCount; frame++) {
    const l = inView.getInt16(frame * 4, true)
    const r = inView.getInt16(frame * 4 + 2, true)
    leftView.setInt16(frame * 2, l, true)
    rightView.setInt16(frame * 2, r, true)
    leftSum += l * l
    rightSum += r * r
  }

  return [
    { pcm: left, rms: Math.sqrt(leftSum / frameCount) },
    { pcm: right, rms: Math.sqrt(rightSum / frameCount) },
  ]
}

/**
 * Average the two channels into one.
 *
 * Kept for the single-session path: a packet that arrives with one channel, or
 * a second session that never connects, still has to be transcribed, and one
 * mono stream is the honest representation of "we cannot attribute this".
 */
export function hidockRealtimeToMonoPcm(packet: RealtimeData): Uint8Array {
  const channels = splitRealtimeChannels(packet)
  if (!channels) return new Uint8Array()
  const [left, right] = channels
  const frameCount = left.pcm.length / 2
  const output = new Uint8Array(frameCount * 2)
  const outView = new DataView(output.buffer)
  const leftView = new DataView(left.pcm.buffer)
  const rightView = new DataView(right.pcm.buffer)
  for (let frame = 0; frame < frameCount; frame++) {
    const mixed = (leftView.getInt16(frame * 2, true) + rightView.getInt16(frame * 2, true)) / 2
    outView.setInt16(frame * 2, Math.trunc(mixed), true)
  }
  return output
}

/**
 * Decide which channel carries the microphone by listening to both.
 *
 * Nothing documents which channel is which — the protocol says "stereo" and
 * stops. Guessing costs transcripts that credit your words to the other side,
 * so this measures instead: the microphone channel is the one that runs hotter
 * while the device's owner talks. It reports `null` until it has enough audio,
 * and keeps reporting `null` when the two channels are too close to separate,
 * which is a usable answer (the UI shows speaker-1/speaker-2) rather than a
 * coin flip.
 */
export class MicChannelIdentifier {
  private leftEnergy = 0
  private rightEnergy = 0
  private packets = 0
  private elapsedMs = 0
  private decided: 0 | 1 | null = null
  private closed = false

  constructor(override: 0 | 1 | 'auto' = 'auto') {
    if (override === 0 || override === 1) {
      this.decided = override
      this.closed = true
    }
  }

  /** True once no further audio can change the answer. */
  get settled(): boolean {
    return this.closed
  }

  /** The microphone channel, or null while unknown / too close to call. */
  get micChannel(): 0 | 1 | null {
    return this.decided
  }

  /** Energies observed so far, for the log line that justifies the choice. */
  get evidence(): { left: number; right: number } {
    return { left: Math.round(this.leftEnergy), right: Math.round(this.rightEnergy) }
  }

  /** Feed one packet's channels. `durationMs` is that packet's audio length. */
  observe(channels: [RealtimeChannel, RealtimeChannel], durationMs: number): void {
    if (this.closed) return
    const [left, right] = channels
    // Silence tells us nothing about which side the microphone is on.
    if (left.rms < SILENCE_RMS && right.rms < SILENCE_RMS) return
    this.leftEnergy += left.rms
    this.rightEnergy += right.rms
    this.packets += 1
    this.elapsedMs += durationMs
    if (this.elapsedMs < IDENTIFY_MS && this.packets < IDENTIFY_MAX_PACKETS) return

    this.closed = true
    const hot = Math.max(this.leftEnergy, this.rightEnergy)
    const cold = Math.min(this.leftEnergy, this.rightEnergy)
    if (cold <= 0 || hot / cold < IDENTIFY_MIN_RATIO) return
    this.decided = this.leftEnergy > this.rightEnergy ? 0 : 1
  }
}

/** 16 kHz mono PCM16LE: 32,000 bytes per second. */
const bytesToMs = (byteLength: number): number => (byteLength / 32_000) * 1000

/**
 * One Live session bound to one audio channel.
 *
 * Each session owns its own rotation clock. The previous single-session code
 * had one `openedAt`; with two sessions a shared clock would rotate the quiet
 * one in the middle of the other's sentence.
 */
class ChannelSession {
  private session: Session | null = null
  private openedAt = 0
  private generation = 0
  private connecting: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly createClient: (apiKey: string) => LiveClient,
    private readonly now: () => number,
    private readonly onInterim: (text: string) => void,
    private readonly onFinal: (text: string) => void,
    private readonly onStatus: (status: string) => void,
    private readonly onError: (error: string) => void
  ) {}

  get connected(): boolean {
    return this.session !== null
  }

  async send(pcm: Uint8Array, apiKey: string): Promise<void> {
    if (this.stopped) return
    if (!this.session || this.now() - this.openedAt >= LIVE_SESSION_ROTATE_MS) {
      await this.rotate(apiKey)
    }
    this.session?.sendRealtimeInput({
      audio: {
        data: Buffer.from(pcm).toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    })
  }

  endStream(): void {
    try { this.session?.sendRealtimeInput({ audioStreamEnd: true }) } catch { /* already closed */ }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    const current = this.session
    this.session = null
    this.connecting = null
    if (current) {
      try { current.sendRealtimeInput({ audioStreamEnd: true }) } catch { /* already closed */ }
      try { current.close() } catch { /* already closed */ }
    }
  }

  async connect(apiKey: string): Promise<void> {
    this.stopped = false
    return this.open(apiKey)
  }

  private async rotate(apiKey: string): Promise<void> {
    if (this.connecting) return this.connecting
    const old = this.session
    this.session = null
    if (old) {
      try { old.sendRealtimeInput({ audioStreamEnd: true }) } catch { /* already closed */ }
      try { old.close() } catch { /* already closed */ }
    }
    this.onStatus('reconnecting')
    return this.open(apiKey)
  }

  private async open(apiKey: string): Promise<void> {
    if (this.connecting) return this.connecting
    const generation = ++this.generation
    this.onStatus('connecting')
    this.connecting = (async () => {
      const client = this.createClient(apiKey)
      const session = await client.live.connect({
        model: GEMINI_LIVE_TRANSCRIBE_MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            languageCodes: languageCodes(getConfig().transcription.language),
            mode: AudioTranscriptionConfigMode.SMART,
          },
        },
        callbacks: {
          onopen: () => this.onStatus('connected'),
          onmessage: (message) => {
            const interim = message.serverContent?.interimInputTranscription?.text?.trim()
            const final = message.serverContent?.inputTranscription?.text?.trim()
            if (interim) this.onInterim(interim)
            if (final) this.onFinal(final)
          },
          onerror: (event) => this.onError(event.message || 'Gemini Live transcription error'),
          onclose: () => {
            if (!this.stopped && generation === this.generation) {
              this.session = null
              this.onStatus('reconnecting')
            }
          },
        },
      })
      if (this.stopped || generation !== this.generation) {
        session.close()
        return
      }
      this.session = session
      this.openedAt = this.now()
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }
}

function languageCodes(language: string | undefined): string[] {
  const value = (language ?? '').trim()
  if (!value || /^(auto|unknown)$/i.test(value)) return []
  if (/^es$/i.test(value)) return ['es-419']
  if (/^en$/i.test(value)) return ['en-US']
  return [value]
}

export class GeminiLiveTranscriptionService {
  private sessions: [ChannelSession, ChannelSession] | null = null
  /** Set when only one session could be used: the stream is mono, unattributed. */
  private monoSession: ChannelSession | null = null
  private identifier = new MicChannelIdentifier()
  private persistedChannel = false
  private sender: LiveTranscriptionSender | null = null
  private active = false

  constructor(
    private readonly createClient: (apiKey: string) => LiveClient = (apiKey) => new GoogleGenAI({ apiKey }),
    private readonly now: () => number = Date.now
  ) {}

  async start(sender: LiveTranscriptionSender): Promise<void> {
    const key = resolveGeminiApiKey()
    if (!key) throw new Error('Gemini API key is required for live transcription')
    await this.stop()
    this.active = true
    this.sender = sender
    this.persistedChannel = false
    this.identifier = new MicChannelIdentifier(configuredMicChannel())

    const a = this.buildSession(0)
    const b = this.buildSession(1)
    await a.connect(key)
    try {
      await b.connect(key)
      this.sessions = [a, b]
    } catch (error) {
      // One channel transcribed with no attribution beats no transcript. Said
      // once, not on every packet. `monoSession` is the state that records it.
      this.emit('transcription-live:error', {
        error:
          'Only one live channel could be opened; the transcript will not be split by speaker' +
          (error instanceof Error ? ` (${error.message})` : ''),
      })
      this.monoSession = a
    }
  }

  async acceptDevicePacket(packet: RealtimeData): Promise<void> {
    if (!this.active) return
    const key = resolveGeminiApiKey()
    if (!key) return

    const channels = splitRealtimeChannels(packet)
    if (!channels) return

    const wasSettled = this.identifier.settled
    this.identifier.observe(channels, bytesToMs(channels[0].pcm.length))
    if (!wasSettled && this.identifier.settled) this.announceChannel()

    if (this.monoSession) {
      await this.monoSession.send(hidockRealtimeToMonoPcm(packet), key)
      return
    }
    if (!this.sessions) return

    // Silence on a channel is not sent: it is most of the cost of running two
    // sessions and it gives the model's own VAD nothing to do.
    for (let index = 0; index < 2; index++) {
      if (channels[index].rms < SILENCE_RMS) continue
      await this.sessions[index].send(channels[index].pcm, key)
    }
  }

  pause(): void {
    for (const session of this.allSessions()) session.endStream()
    this.emit('transcription-live:status', { status: 'paused' })
  }

  async stop(): Promise<void> {
    this.active = false
    const sessions = this.allSessions()
    this.sessions = null
    this.monoSession = null
    for (const session of sessions) await session.stop()
    this.emit('transcription-live:status', { status: 'stopped' })
    this.sender = null
  }

  private allSessions(): ChannelSession[] {
    if (this.monoSession) return [this.monoSession]
    return this.sessions ? [this.sessions[0], this.sessions[1]] : []
  }

  private buildSession(channel: 0 | 1): ChannelSession {
    return new ChannelSession(
      this.createClient,
      this.now,
      (text) => this.emit('transcription-live:interim', { text, speaker: this.labelFor(channel) }),
      (text) => this.emit('transcription-live:final', { text, speaker: this.labelFor(channel) }),
      (status) => this.emit('transcription-live:status', { status, channel }),
      (error) => this.emit('transcription-live:error', { error, channel })
    )
  }

  /**
   * The label a channel's turns carry.
   *
   * Before the identification settles, and when it cannot separate the two
   * channels, the labels stay neutral. A transcript never claims `you` on a
   * guess.
   */
  private labelFor(channel: 0 | 1): SpeakerLabel {
    if (this.monoSession) return 'speaker'
    const mic = this.identifier.micChannel
    if (mic === null) return channel === 0 ? 'speaker-1' : 'speaker-2'
    return channel === mic ? 'you' : 'them'
  }

  /** Publish and remember the measured channel, with the evidence for it. */
  private announceChannel(): void {
    const mic = this.identifier.micChannel
    const evidence = this.identifier.evidence
    console.info(
      '[LiveTranscription] channel identification ' +
        JSON.stringify({ micChannel: mic, ...evidence })
    )
    this.emit('transcription-live:channels', { micChannel: mic, ...evidence })
    if (mic === null || this.persistedChannel) return
    this.persistedChannel = true
    // Next session starts already knowing, instead of spending its first ten
    // seconds on speaker-1/speaker-2 again.
    void updateConfig('transcription', { liveMicChannel: mic }).catch((error) => {
      console.warn('[LiveTranscription] could not persist liveMicChannel:', error)
    })
  }

  private emit(channel: string, payload: unknown): void {
    if (this.sender && !this.sender.isDestroyed()) this.sender.send(channel, payload)
  }
}

/** `auto` (measure), or a channel index the user pinned in Settings. */
function configuredMicChannel(): 0 | 1 | 'auto' {
  const value = getConfig().transcription.liveMicChannel
  return value === 0 || value === 1 ? value : 'auto'
}

export const geminiLiveTranscription = new GeminiLiveTranscriptionService()
