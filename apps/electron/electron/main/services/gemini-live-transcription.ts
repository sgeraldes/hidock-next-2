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
 *
 * The first cut at this was -45 dBFS (RMS 184), which is far too high for a
 * *mean* level: a 20 ms packet of speech at -50 dBFS measures RMS 73, and that
 * is an ordinary soft voice, not noise. The gate would have eaten it whole.
 * -55 dBFS is RMS 58 of 32768 — still above a quiet room once DC is removed
 * (see `acRms`), and below any voice worth transcribing.
 */
const SILENCE_RMS = 58

/**
 * Keep sending a channel for this long after its last packet above the gate.
 *
 * Speech is not continuous: the gaps between words, and the tail of a final
 * consonant, sit under any threshold. Gating packet by packet chops those off
 * and hands Gemini clipped words. A one second hangover is cheap — it only
 * bills while someone was talking a moment ago.
 */
const SILENCE_HANGOVER_MS = 1000

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
/**
 * True when this packet's payload is not a whole number of stereo frames.
 *
 * A stereo frame is 4 bytes, so a real stereo packet's payload is always a
 * multiple of 4. A payload that is a multiple of 2 and not of 4 is a stream of
 * single 16-bit samples: one channel.
 *
 * One such packet proves nothing — a truncated read looks identical — so this
 * is a signal, not a verdict. MONO_PACKETS_BEFORE_DEGRADING is what turns a run
 * of them into a decision.
 */
export function looksMono(packet: RealtimeData): boolean {
  const length = packet.data.length - 8
  return length > 0 && length % 2 === 0 && length % 4 !== 0
}

/**
 * How many odd packets in a row mean the firmware is sending one channel.
 *
 * Firmware that sends mono sends it every packet; a truncated USB read is an
 * accident and does not repeat. Degrading on the first one would throw away
 * speaker attribution for the rest of the session over a single glitch, and
 * five packets is half a second.
 */
export const MONO_PACKETS_BEFORE_DEGRADING = 5

/**
 * The payload of a one-channel packet, as it already is.
 *
 * `hidockRealtimeToMonoPcm` averages two channels; there is nothing to average
 * here, and running it over single samples would fold every other sample into
 * its neighbour.
 */
export function monoPayload(packet: RealtimeData): Uint8Array {
  if (packet.muted || packet.data.length <= 8) return new Uint8Array(0)
  const payload = packet.data.subarray(8)
  // A dangling byte shifts every sample after it by one, and PCM16 read half a
  // sample out is noise. `splitRealtimeChannels` already trims to whole frames;
  // this trims to whole samples, for the same reason.
  return payload.length % 2 === 0 ? payload : payload.subarray(0, payload.length - 1)
}

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
  let leftSquares = 0
  let rightSquares = 0

  for (let frame = 0; frame < frameCount; frame++) {
    const l = inView.getInt16(frame * 4, true)
    const r = inView.getInt16(frame * 4 + 2, true)
    leftView.setInt16(frame * 2, l, true)
    rightView.setInt16(frame * 2, r, true)
    leftSum += l
    rightSum += r
    leftSquares += l * l
    rightSquares += r * r
  }

  return [
    { pcm: left, rms: acRms(leftSquares, leftSum, frameCount) },
    { pcm: right, rms: acRms(rightSquares, rightSum, frameCount) },
  ]
}

/**
 * RMS with the packet's DC component removed.
 *
 * A converter with a DC offset reads as constant loudness: a channel sitting at
 * a steady 400 has a plain RMS of 400, sails over the silence gate and bills a
 * Live session for a flat line. Subtracting the mean is what an audio level
 * meter does, and it costs one extra accumulator. Under two frames there is no
 * mean worth removing, so the plain RMS stands.
 */
function acRms(sumOfSquares: number, sum: number, frameCount: number): number {
  const mean = sum / frameCount
  const variance = frameCount < 2 ? sumOfSquares / frameCount : sumOfSquares / frameCount - mean * mean
  return Math.sqrt(Math.max(0, variance))
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
 * so this measures instead.
 *
 * It does **not** measure who is louder. That was the first design and it is
 * wrong in the most ordinary case there is: on a call the far side arrives at
 * line level and routinely runs hotter than the device owner's own voice, so
 * "louder wins" labels the other person `you`. Fed 210 packets of owner-at-3000
 * against far-side-at-9000, the energy rule picked channel 1 — the far side.
 *
 * What actually separates the two is the **floor**, not the peak. The
 * microphone hears the room the whole time: between turns it still reads a few
 * hundred of hiss, breath and handling. The far-side channel is digital audio
 * from the other end of a codec; between turns it drops to near zero. So the
 * channel whose quiet moments are the loudest is the microphone, whoever
 * happens to shout. Measured as a low percentile of the per-packet RMS, which
 * ignores the talking and looks only at the gaps.
 *
 * It reports `null` until it has enough audio, and keeps reporting `null` when
 * the two floors are within ~3 dB, which is a usable answer (the UI shows
 * speaker-1/speaker-2) rather than a coin flip.
 */
export class MicChannelIdentifier {
  private readonly leftLevels: number[] = []
  private readonly rightLevels: number[] = []
  private leftFloor = 0
  private rightFloor = 0
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

  /** The two measured floors, for the log line that justifies the choice. */
  get evidence(): { left: number; right: number } {
    return { left: Math.round(this.leftFloor), right: Math.round(this.rightFloor) }
  }

  /** Feed one packet's channels. `durationMs` is that packet's audio length. */
  observe(channels: [RealtimeChannel, RealtimeChannel], durationMs: number): void {
    if (this.closed) return
    const [left, right] = channels
    // Both channels quiet tells us nothing: there is no talking to sit under.
    if (left.rms < SILENCE_RMS && right.rms < SILENCE_RMS) return
    this.leftLevels.push(left.rms)
    this.rightLevels.push(right.rms)
    this.packets += 1
    this.elapsedMs += durationMs
    if (this.elapsedMs < IDENTIFY_MS && this.packets < IDENTIFY_MAX_PACKETS) return

    this.closed = true
    this.leftFloor = noiseFloor(this.leftLevels)
    this.rightFloor = noiseFloor(this.rightLevels)
    const hot = Math.max(this.leftFloor, this.rightFloor)
    const cold = Math.min(this.leftFloor, this.rightFloor)
    if (hot <= 0) return
    // A floor of exactly zero on one side is the clearest case there is: that
    // channel is digital silence between turns, so the other one is the room.
    if (cold > 0 && hot / cold < IDENTIFY_MIN_RATIO) return
    this.decided = this.leftFloor > this.rightFloor ? 0 : 1
  }
}

/** Where a channel sits when nobody on it is talking: its 20th percentile. */
const FLOOR_PERCENTILE = 0.2

function noiseFloor(levels: number[]): number {
  if (levels.length === 0) return 0
  const sorted = [...levels].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * FLOOR_PERCENTILE))
  return sorted[index]
}

/** 16 kHz mono PCM16LE: 32,000 bytes per second. */
const bytesToMs = (byteLength: number): number => (byteLength / 32_000) * 1000

/**
 * How many device packets may wait for the provider before audio is dropped.
 *
 * The numbers this comes from: the device streams 16 kHz stereo PCM16, which is
 * 64,000 bytes per second, and the renderer polls every 100 ms, or every 50 ms
 * while the device reports a backlog (`rest > 1`, Device.tsx). So a packet is
 * 3-6 KB and carries 50-100 ms of audio.
 *
 * 200 packets is 10 seconds of audio at the fast cadence, 20 at the slow one,
 * and about 1.3 MB of memory. Ten seconds covers every stall this code can
 * produce on purpose: a Live session rotation at the 9 minute mark is one
 * WebSocket handshake, and both channels rotating at once is two. A provider
 * that has not accepted a byte in ten seconds is not slow, it is gone, and
 * holding more of its backlog only delays the transcript further.
 */
export const MAX_QUEUED_PACKETS = 200

/**
 * How long `stop()` waits for a parked drain before returning anyway.
 *
 * Long enough that the ordinary case — a send already handed to the SDK —
 * finishes and `stop()` still returns having drained cleanly. Short enough that
 * a user who pressed Stop gets the UI back while a dead socket is still timing
 * out somewhere underneath.
 */
export const STOP_DRAIN_GRACE_MS = 250

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

  /**
   * End the input stream and accept no more audio.
   *
   * The flag matters as much as the message. A packet parked on a reconnect
   * when the user hits pause would otherwise resume, find a freshly opened
   * session, and push audio into a stream that was ended — or into a session
   * opened *after* the pause. Resuming goes through `start()`, which builds new
   * `ChannelSession`s, so nothing needs this one to accept audio again.
   */
  endStream(): void {
    this.stopped = true
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
  /** Consecutive packets whose payload is not whole stereo frames. */
  private monoRun = 0
  private identifier = new MicChannelIdentifier()
  private persistedChannel = false
  private sender: LiveTranscriptionSender | null = null
  private active = false
  /** Bumped by every start and stop, so a superseded start cleans up after itself. */
  private generation = 0
  /** Per channel, when that channel last carried audio above the silence gate. */
  private lastVoiceAt: [number, number] = [-Infinity, -Infinity]
  /**
   * Packets read from USB and not yet handed to the provider, oldest first.
   *
   * This is what keeps provider latency off the USB path. `acceptDevicePacket`
   * used to await the send, so the renderer's poll loop — the only thing that
   * drains the device's own finite buffer — ran at the speed of a WebSocket.
   * A slow provider made `rest` grow on the device and packets were lost there,
   * where nothing can recover them.
   */
  private readonly queue: RealtimeData[] = []
  /** The single in-flight drain, so packets can never be sent out of order. */
  private draining: Promise<void> | null = null
  /** Packets dropped in the current overflow episode. Reset when it ends. */
  private dropped = 0
  /** True once this episode has been reported, so it is said once, not per packet. */
  private overflowReported = false
  /** True while sends are failing, so the reason is logged on the transition only. */
  private sendFailing = false

  constructor(
    private readonly createClient: (apiKey: string) => LiveClient = (apiKey) => new GoogleGenAI({ apiKey }),
    private readonly now: () => number = Date.now
  ) {}

  async start(sender: LiveTranscriptionSender): Promise<void> {
    const key = resolveGeminiApiKey()
    if (!key) throw new Error('Gemini API key is required for live transcription')
    await this.stop()
    const generation = ++this.generation
    this.active = true
    this.sender = sender
    this.persistedChannel = false
    this.lastVoiceAt = [-Infinity, -Infinity]
    this.identifier = new MicChannelIdentifier(configuredMicChannel())

    const a = this.buildSession(0)
    const b = this.buildSession(1)
    // Registered before the first await: a `stop()` that lands mid-connect has
    // to be able to find these two, or they stay open with nothing pointing at
    // them. Two overlapping `start()` calls (a double-clicked resume button)
    // used to leak exactly one pair of Live sessions each time.
    this.sessions = [a, b]
    await a.connect(key)
    if (generation !== this.generation) return this.discard(a, b)
    try {
      await b.connect(key)
      if (generation !== this.generation) return this.discard(a, b)
      this.sessions = [a, b]
    } catch (error) {
      if (generation !== this.generation) return this.discard(a, b)
      this.sessions = null
      // One channel transcribed with no attribution beats no transcript. Said
      // once, not on every packet. `monoSession` is the state that records it.
      this.emit('transcription-live:error', {
        error:
          'Only one live channel could be opened; the transcript will not be split by speaker' +
          (error instanceof Error ? ` (${error.message})` : ''),
      })
      this.monoSession = a
      await b.stop()
    }
  }

  /**
   * The device is sending one channel. Keep the first session, drop the second.
   *
   * Said once, like the failed-connection case, and for the same reason: this
   * is a property of the firmware on the other end of the cable, not of any
   * one packet, so repeating it every 100 ms would bury the log.
   */
  private async degradeToMono(generation: number): Promise<void> {
    // The caller snapshots the generation before this call; a stop between the
    // two would otherwise put "the device is sending a single audio channel" on
    // screen for a session the user already ended.
    if (this.monoSession || generation !== this.generation) return
    const open = this.sessions
    this.sessions = null
    this.emit('transcription-live:error', {
      error:
        'The device is sending a single audio channel, so this transcript will not be split by speaker.',
    })
    if (!open) return
    this.monoSession = open[0]
    await open[1].stop()
  }

  /** A start that lost a race owns its own sessions; nothing else will close them. */
  private async discard(...sessions: ChannelSession[]): Promise<void> {
    for (const session of sessions) await session.stop()
  }

  /**
   * Take one packet off the USB path and return.
   *
   * Deliberately not `async`: there is no await between the `active` check and
   * the push, so a `stop()` can never land in the middle of an enqueue and
   * leave a packet behind that belongs to a session already closed.
   */
  acceptDevicePacket(packet: RealtimeData): void {
    if (!this.active) return
    if (this.queue.length >= MAX_QUEUED_PACKETS) {
      // Drop the OLDEST, not the newest. This is a live transcript: dropping
      // the newest freezes the queue at the moment of the stall and refuses
      // every packet after it, so the transcript stops at that second and never
      // catches up. Dropping the oldest keeps the stream anchored to now — one
      // hole while the provider was away, and speech resumes the moment it is
      // back. The provider's own VAD also works on recent audio, so feeding it
      // ten second old speech after the fact is worth less than the silence.
      this.queue.shift()
      this.reportBackpressure()
    }
    this.queue.push(packet)
    void this.drain()
  }

  /** How much audio is waiting for the provider. For logs and tests. */
  get queuedPackets(): number {
    return this.queue.length
  }

  /** Report an overflow episode once, with the tally when it ends. */
  private reportBackpressure(): void {
    this.dropped += 1
    if (this.overflowReported) return
    this.overflowReported = true
    console.warn(
      `[LiveTranscription] send queue full at ${MAX_QUEUED_PACKETS} packets; dropping the oldest audio`
    )
    this.emit('transcription-live:error', {
      error:
        'Live transcription is falling behind the audio coming from the device; the oldest audio is being dropped.',
    })
  }

  /**
   * Send queued packets, one at a time, oldest first, until the queue is empty.
   *
   * One loop at a time is the whole ordering guarantee: `processPacket` awaits
   * the provider, and two loops would interleave their awaits and deliver audio
   * out of order, which is worse for a transcript than delivering it late.
   *
   * The generation is read once at the top and checked every iteration, so a
   * `stop()` or a superseded `start()` ends the loop instead of pushing audio
   * into sessions that are already closed. `stop()` also empties the queue and
   * closes the sessions, so this check is the backstop rather than the first
   * line: it is what keeps a future reordering of `stop()` from resurrecting
   * the bug. A session rotation is not a
   * generation change: the loop keeps awaiting through the reconnect, so the
   * packets waiting when a session rotates at 9 minutes are delivered, not lost.
   */
  private drain(): Promise<void> {
    if (this.draining) return this.draining
    const generation = this.generation
    this.draining = (async () => {
      while (this.queue.length > 0 && generation === this.generation) {
        try {
          await this.processPacket(this.queue.shift()!)
          this.sendFailing = false
        } catch (error) {
          // A failed send must not end the loop. If it did, the queue would
          // fill behind the dead loop and every packet after the first failure
          // would be dropped — the exact failure this queue exists to prevent,
          // reached by another road. Said on the transition, not per packet.
          if (!this.sendFailing) {
            this.sendFailing = true
            console.warn('[LiveTranscription] packet could not be sent:', error)
          }
        }
      }
      if (this.dropped > 0 && generation === this.generation) {
        console.warn(
          `[LiveTranscription] caught up after dropping ${this.dropped} packets of audio`
        )
        this.dropped = 0
        this.overflowReported = false
      }
    })().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  /**
   * Wait for the queue to drain.
   *
   * Nothing on the device path calls this — that is the point of the queue.
   * `stop()` uses it to make sure no send outlives the session, and the tests
   * use it to observe what the provider received.
   */
  async flush(): Promise<void> {
    while (this.draining) await this.draining
  }

  /**
   * Wait for the drain, but not forever.
   *
   * A drain parked inside `live.connect` is suspended on a promise nobody can
   * cancel: the SDK takes no AbortSignal, so `ChannelSession.stop()` can latch
   * the session closed but cannot make the handshake return. Without a deadline
   * `stop()` inherits that wait, and `jensen:stopRealtime` inherits it in turn,
   * so a stalled reconnect at the 9 minute mark leaves the Stop button hanging
   * on a socket.
   *
   * Abandoning the drain is safe, which is why a deadline is enough: the
   * sessions are already closed and latched, and the loop checks the generation
   * before every packet, so when the handshake finally settles the loop finds a
   * stale generation, exits, and the session it opened is closed unused.
   */
  private async flushWithin(ms: number): Promise<void> {
    if (!this.draining) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  private async processPacket(packet: RealtimeData): Promise<void> {
    if (!this.active) return
    const key = resolveGeminiApiKey()
    if (!key) return
    // Every other entry point checks the generation; this one did not. A packet
    // still in flight across a stop/start would then send into sessions the
    // stop already closed. `send` and `stop` are idempotent so nothing broke,
    // but "nothing broke because the callee is defensive" is not a contract.
    const generation = this.generation

    // One channel on the wire: the two-session design has nothing to split, so
    // it degrades to the single session it already has for a failed second
    // connection, labelled `speaker` because nothing says which voice it is.
    if (looksMono(packet)) {
      this.monoRun += 1
      if (this.monoRun >= MONO_PACKETS_BEFORE_DEGRADING && !this.monoSession) {
        await this.degradeToMono(generation)
        if (generation !== this.generation) return
      }
      if (this.monoSession) {
        await this.monoSession.send(monoPayload(packet), key)
        return
      }
    } else {
      this.monoRun = 0
    }

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
    // sessions and it gives the model's own VAD nothing to do. The hangover is
    // what keeps that from eating the gaps inside a sentence and the tail of
    // the last word — a gate with no hangover hands Gemini clipped speech.
    const now = this.now()
    for (let index = 0; index < 2; index++) {
      if (channels[index].rms >= SILENCE_RMS) this.lastVoiceAt[index] = now
      else if (now - this.lastVoiceAt[index] >= SILENCE_HANGOVER_MS) continue
      await this.sessions[index].send(channels[index].pcm, key)
      if (generation !== this.generation) return
    }
  }

  pause(): void {
    // A `getRealtimeData` poll already in flight when the user hits pause lands
    // after this, and pushing audio into a stream we just closed with
    // `audioStreamEnd` is not something the API promises anything about.
    // Resuming goes through `start()` again, so nothing is lost by refusing.
    this.active = false
    // Queued packets belong to the stream this call is about to end. Sending
    // them after `audioStreamEnd` is the same thing pause exists to prevent,
    // only delayed by however deep the queue was.
    this.queue.length = 0
    for (const session of this.allSessions()) session.endStream()
    this.emit('transcription-live:status', { status: 'paused' })
  }

  async stop(): Promise<void> {
    this.active = false
    this.generation += 1
    this.queue.length = 0
    this.dropped = 0
    this.overflowReported = false
    this.sendFailing = false
    const sessions = this.allSessions()
    this.sessions = null
    this.monoSession = null
    this.monoRun = 0
    // Close the sessions before waiting on the queue, not after. A drain that
    // is parked on a reconnect resumes into a `ChannelSession` that already
    // knows it is stopped, so the packet it was carrying is dropped instead of
    // written to a socket this call is closing. Flushing first would let that
    // one packet through, because nothing had told the session to stop yet.
    for (const session of sessions) await session.stop()
    // And only then wait for the loop to unwind, so no send outlives `stop()`.
    // Bounded, because that wait can be a WebSocket handshake that nobody can
    // cancel, and Stop has to return either way.
    await this.flushWithin(STOP_DRAIN_GRACE_MS)
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
      // `channel` rides along with `speaker` so the UI can relabel turns that
      // are already on screen when the measurement settles: the label changes,
      // the cable the turn came in on does not.
      (text) => this.emit('transcription-live:interim', { text, speaker: this.labelFor(channel), channel: this.channelOf(channel) }),
      (text) => this.emit('transcription-live:final', { text, speaker: this.labelFor(channel), channel: this.channelOf(channel) }),
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
  /** null when the stream is the unattributed mono fallback. */
  private channelOf(channel: 0 | 1): 0 | 1 | null {
    return this.monoSession ? null : channel
  }

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
    // Remembered under its own key. Writing the measurement into
    // `liveMicChannel` turned the user's explicit "Measure automatically" into
    // a pin behind their back, and the Settings control could never undo it,
    // so one wrong measurement became permanent.
    void updateConfig('transcription', { liveMicChannelMeasured: mic }).catch((error) => {
      console.warn('[LiveTranscription] could not persist liveMicChannelMeasured:', error)
    })
  }

  private emit(channel: string, payload: unknown): void {
    if (this.sender && !this.sender.isDestroyed()) this.sender.send(channel, payload)
  }
}

/**
 * `auto` (measure), or a channel index already known.
 *
 * The pin the user set in Settings always wins; a value this app measured in an
 * earlier session is only a warm start, so that picking "Measure automatically"
 * really does go back to measuring.
 */
function configuredMicChannel(): 0 | 1 | 'auto' {
  const { liveMicChannel, liveMicChannelMeasured } = getConfig().transcription
  if (liveMicChannel === 0 || liveMicChannel === 1) return liveMicChannel
  if (liveMicChannelMeasured === 0 || liveMicChannelMeasured === 1) return liveMicChannelMeasured
  return 'auto'
}

export const geminiLiveTranscription = new GeminiLiveTranscriptionService()
