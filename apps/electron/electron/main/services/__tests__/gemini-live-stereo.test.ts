/**
 * Live transcription: one channel per speaker (2026-09-22).
 *
 * The service averaged the device's two channels into mono. The Live API does
 * no diarization, so that average destroyed the only thing that can attribute a
 * turn — one channel is the microphone, the other is the far side. These pin
 * the de-interleaving, the measurement that decides which channel is which
 * (nothing documents it), the silence gate that keeps two sessions from costing
 * twice as much for nothing, and the rule that a transcript never claims `you`
 * on a guess.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  language: 'es' as string,
  liveMicChannel: undefined as 0 | 1 | undefined,
  saved: [] as Array<Record<string, unknown>>,
}))

vi.mock('../brains', () => ({ resolveGeminiApiKey: () => 'test-key' }))
vi.mock('../config', () => ({
  getConfig: () => ({
    transcription: { language: deps.language, liveMicChannel: deps.liveMicChannel },
  }),
  updateConfig: async (_section: string, patch: Record<string, unknown>) => {
    deps.saved.push(patch)
  },
}))

import {
  GeminiLiveTranscriptionService,
  MicChannelIdentifier,
  hidockRealtimeToMonoPcm,
  splitRealtimeChannels,
} from '../gemini-live-transcription'

/** Build a realtime packet: 8-byte header, then interleaved L/R PCM16LE. */
function packet(frames: Array<[number, number]>, muted = false) {
  const data = new Uint8Array(8 + frames.length * 4)
  const view = new DataView(data.buffer)
  frames.forEach(([l, r], i) => {
    view.setInt16(8 + i * 4, l, true)
    view.setInt16(8 + i * 4 + 2, r, true)
  })
  return { rest: 0, muted, data }
}

/**
 * n frames of a square wave at amplitude `l` on the left and `r` on the right.
 *
 * It alternates sign so the packet has no DC component: the levels the service
 * measures are DC-free (a steady offset is not loudness), and a constant-value
 * fixture would measure as silence.
 */
const tone = (l: number, r: number, n = 400) =>
  packet(Array.from({ length: n }, (_, i) => (i % 2 ? [-l, -r] : [l, r]) as [number, number]))

const read = (pcm: Uint8Array, frame: number) =>
  new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(frame * 2, true)

beforeEach(() => {
  vi.clearAllMocks()
  deps.language = 'es'
  deps.liveMicChannel = undefined
  deps.saved = []
})

describe('splitRealtimeChannels', () => {
  it('strips the header and de-interleaves both channels', () => {
    const channels = splitRealtimeChannels(packet([[1000, 3000], [-2000, 1000]]))!
    expect(channels).toHaveLength(2)
    expect(read(channels[0].pcm, 0)).toBe(1000)
    expect(read(channels[0].pcm, 1)).toBe(-2000)
    expect(read(channels[1].pcm, 0)).toBe(3000)
    expect(read(channels[1].pcm, 1)).toBe(1000)
  })

  it('reports each channel loudness independently', () => {
    const channels = splitRealtimeChannels(tone(8000, 100))!
    expect(channels[0].rms).toBeGreaterThan(channels[1].rms * 10)
  })

  it('returns null for muted, header-only and empty payloads', () => {
    expect(splitRealtimeChannels(tone(1000, 1000, 10) && { ...tone(1000, 1000, 10), muted: true })).toBeNull()
    expect(splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(8) })).toBeNull()
    expect(splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(3) })).toBeNull()
  })

  it('reads through a view with a non-zero byteOffset', () => {
    // Node hands out pooled Buffers, so `data.buffer` is usually a shared 8 KiB
    // arena and `data.byteOffset` is not zero. A DataView built on `.buffer`
    // without passing the offset reads someone else's bytes.
    const src = packet([[1000, 3000], [-2000, 1000]]).data
    const arena = new Uint8Array(200)
    arena.set(src, 37)
    const view = arena.subarray(37, 37 + src.length)
    expect(view.byteOffset).toBe(37)
    const channels = splitRealtimeChannels({ rest: 0, muted: false, data: view })!
    expect(read(channels[0].pcm, 0)).toBe(1000)
    expect(read(channels[0].pcm, 1)).toBe(-2000)
    expect(read(channels[1].pcm, 0)).toBe(3000)
    expect(read(channels[1].pcm, 1)).toBe(1000)
  })

  it('reads a real pooled Node Buffer', () => {
    const buffer = Buffer.from(packet([[500, -700]]).data)
    const channels = splitRealtimeChannels({ rest: 0, muted: false, data: buffer })!
    expect(read(channels[0].pcm, 0)).toBe(500)
    expect(read(channels[1].pcm, 0)).toBe(-700)
  })

  it('returns null rather than reading past a 9-byte or 11-byte payload', () => {
    expect(splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(9) })).toBeNull()
    expect(splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(11) })).toBeNull()
    expect(splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(0) })).toBeNull()
    expect(() => splitRealtimeChannels({ rest: 0, muted: false, data: new Uint8Array(13) })).not.toThrow()
  })

  it('measures loudness with the DC component removed', () => {
    // A converter sitting at a steady 400 is not making any sound. Plain RMS
    // reports 400 and bills a Live session for a flat line.
    const flat = packet(Array.from({ length: 400 }, () => [400, 400] as [number, number]))
    expect(splitRealtimeChannels(flat)![0].rms).toBe(0)
  })

  it('never reads past a payload that is not a whole number of frames', () => {
    // 8-byte header + 6 bytes: one full stereo frame and two stray bytes.
    const data = new Uint8Array(8 + 6)
    new DataView(data.buffer).setInt16(8, 1234, true)
    const channels = splitRealtimeChannels({ rest: 0, muted: false, data })!
    expect(channels[0].pcm).toHaveLength(2)
    expect(read(channels[0].pcm, 0)).toBe(1234)
  })
})

describe('hidockRealtimeToMonoPcm', () => {
  it('still averages the two channels, for the unattributed single-session path', () => {
    const mono = hidockRealtimeToMonoPcm(packet([[1000, 3000], [-2000, 1000]]))
    expect(read(mono, 0)).toBe(2000)
    expect(read(mono, 1)).toBe(-500)
  })

  it('returns nothing for a muted packet', () => {
    expect(hidockRealtimeToMonoPcm({ ...tone(5000, 5000, 4), muted: true })).toHaveLength(0)
  })
})

describe('MicChannelIdentifier', () => {
  /** Feed enough audio to close the window. */
  const feed = (id: MicChannelIdentifier, l: number, r: number) => {
    for (let i = 0; i < 210; i++) id.observe(splitRealtimeChannels(tone(l, r))!, 100)
  }

  it('picks the channel with the steadier floor when one is plainly quieter', () => {
    const left = new MicChannelIdentifier()
    feed(left, 9000, 200)
    expect(left.settled).toBe(true)
    expect(left.micChannel).toBe(0)

    const right = new MicChannelIdentifier()
    feed(right, 200, 9000)
    expect(right.micChannel).toBe(1)
  })

  it('refuses to choose when the channels are too close to separate', () => {
    const id = new MicChannelIdentifier()
    feed(id, 5000, 5000)
    expect(id.settled).toBe(true)
    expect(id.micChannel).toBeNull()
  })

  it('reports null while the window is still open', () => {
    const id = new MicChannelIdentifier()
    id.observe(splitRealtimeChannels(tone(9000, 200))!, 100)
    expect(id.settled).toBe(false)
    expect(id.micChannel).toBeNull()
  })

  it('ignores silence: it says nothing about which side the mic is on', () => {
    const id = new MicChannelIdentifier()
    for (let i = 0; i < 300; i++) id.observe(splitRealtimeChannels(tone(10, 10))!, 100)
    expect(id.settled).toBe(false)
  })

  it('picks the channel with the higher floor, not the louder speaker', () => {
    // The real shape of a call: turns alternate. Channel 0 is the microphone —
    // quieter when its owner talks (3000), but never silent, because it keeps
    // hearing the room (250). Channel 1 is the far side: hotter when they talk
    // (9000) and near digital silence when they do not (20).
    const id = new MicChannelIdentifier()
    for (let i = 0; i < 210; i++) {
      const owner = i % 2 === 0
      id.observe(splitRealtimeChannels(owner ? tone(3000, 20) : tone(250, 9000))!, 100)
    }
    expect(id.settled).toBe(true)
    // Summing energy picks 1 here (4510 against 1625) and calls the other
    // person `you`. The floor picks the microphone.
    expect(id.micChannel).toBe(0)
  })

  it('treats a channel that is digitally silent between turns as the far side', () => {
    const id = new MicChannelIdentifier()
    for (let i = 0; i < 210; i++) {
      id.observe(splitRealtimeChannels(i % 2 === 0 ? tone(0, 9000) : tone(0, 60))!, 100)
    }
    expect(id.micChannel).toBe(1)
  })

  it('honours a channel pinned in Settings without measuring', () => {
    const pinned = new MicChannelIdentifier(1)
    expect(pinned.settled).toBe(true)
    expect(pinned.micChannel).toBe(1)
  })

  it('carries the floors that justify the choice', () => {
    const id = new MicChannelIdentifier()
    feed(id, 9000, 200)
    expect(id.evidence.left).toBeGreaterThan(id.evidence.right)
  })
})

describe('GeminiLiveTranscriptionService with two channels', () => {
  function harness() {
    const sessions: Array<{
      sendRealtimeInput: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      callbacks: Record<string, (arg?: unknown) => void>
      model: string
    }> = []
    const connect = vi.fn(async (request: Record<string, unknown>) => {
      const session = {
        sendRealtimeInput: vi.fn(),
        close: vi.fn(),
        callbacks: request.callbacks as Record<string, (arg?: unknown) => void>,
        model: request.model as string,
      }
      sessions.push(session)
      session.callbacks.onopen?.()
      return session
    })
    const sender = { isDestroyed: () => false, send: vi.fn() }
    let clock = 0
    const service = new GeminiLiveTranscriptionService(
      () => ({ live: { connect } }) as never,
      () => clock
    )
    return { sessions, connect, sender, service, tick: (ms: number) => { clock += ms } }
  }

  const events = (sender: { send: ReturnType<typeof vi.fn> }, channel: string) =>
    sender.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

  it('opens one session per channel, both on the live transcribe model', async () => {
    const h = harness()
    await h.service.start(h.sender)
    expect(h.connect).toHaveBeenCalledTimes(2)
    for (const s of h.sessions) expect(s.model).toBe('gemini-3.5-transcribe-live')
    await h.service.stop()
  })

  it('routes each channel to its own session', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await h.service.acceptDevicePacket(tone(9000, 8000))
    expect(h.sessions[0].sendRealtimeInput).toHaveBeenCalledTimes(1)
    expect(h.sessions[1].sendRealtimeInput).toHaveBeenCalledTimes(1)
    // Different audio reached each one.
    const a = h.sessions[0].sendRealtimeInput.mock.calls[0][0].audio.data
    const b = h.sessions[1].sendRealtimeInput.mock.calls[0][0].audio.data
    expect(a).not.toBe(b)
    await h.service.stop()
  })

  it('does not send a silent channel', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await h.service.acceptDevicePacket(tone(9000, 5))
    expect(h.sessions[0].sendRealtimeInput).toHaveBeenCalledTimes(1)
    expect(h.sessions[1].sendRealtimeInput).not.toHaveBeenCalled()
    await h.service.stop()
  })

  it('keeps sending a channel through the hangover, then stops', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await h.service.acceptDevicePacket(tone(9000, 9000))
    // Both spoke. A quiet packet 300 ms later is the gap inside a sentence and
    // still goes; the same packet two seconds later is silence and does not.
    h.tick(300)
    await h.service.acceptDevicePacket(tone(9000, 5))
    expect(h.sessions[1].sendRealtimeInput).toHaveBeenCalledTimes(2)
    h.tick(2000)
    await h.service.acceptDevicePacket(tone(9000, 5))
    expect(h.sessions[1].sendRealtimeInput).toHaveBeenCalledTimes(2)
    await h.service.stop()
  })

  it('labels turns speaker-1/speaker-2 until the measurement settles', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await h.service.acceptDevicePacket(tone(9000, 8000))
    h.sessions[0].callbacks.onmessage?.({
      serverContent: { inputTranscription: { text: 'hola' } },
    } as never)
    expect(events(h.sender, 'transcription-live:final')[0]).toMatchObject({
      text: 'hola',
      speaker: 'speaker-1',
    })
    await h.service.stop()
  })

  it('labels you/them once the measurement settles, and persists the channel', async () => {
    const h = harness()
    await h.service.start(h.sender)
    for (let i = 0; i < 210; i++) await h.service.acceptDevicePacket(tone(9000, 300))
    h.sessions[0].callbacks.onmessage?.({
      serverContent: { inputTranscription: { text: 'mio' } },
    } as never)
    h.sessions[1].callbacks.onmessage?.({
      serverContent: { inputTranscription: { text: 'suyo' } },
    } as never)
    const finals = events(h.sender, 'transcription-live:final')
    expect(finals.at(-2)).toMatchObject({ text: 'mio', speaker: 'you' })
    expect(finals.at(-1)).toMatchObject({ text: 'suyo', speaker: 'them' })
    expect(events(h.sender, 'transcription-live:channels')[0]).toMatchObject({ micChannel: 0 })
    expect(deps.saved).toEqual([{ liveMicChannelMeasured: 0 }])
    await h.service.stop()
  })

  it('starts already labelled when Settings pins the channel', async () => {
    deps.liveMicChannel = 1
    const h = harness()
    await h.service.start(h.sender)
    await h.service.acceptDevicePacket(tone(9000, 8000))
    h.sessions[1].callbacks.onmessage?.({
      serverContent: { interimInputTranscription: { text: 'ya' } },
    } as never)
    expect(events(h.sender, 'transcription-live:interim')[0]).toMatchObject({
      text: 'ya',
      speaker: 'you',
    })
    await h.service.stop()
  })

  it('rotates each session on its own clock', async () => {
    const h = harness()
    await h.service.start(h.sender)
    // Only channel 0 carries audio, so only its clock should ever advance past
    // the rotation window. A shared clock would recycle the quiet session too.
    await h.service.acceptDevicePacket(tone(9000, 5))
    h.tick(9 * 60 * 1000 + 1)
    await h.service.acceptDevicePacket(tone(9000, 5))
    expect(h.connect).toHaveBeenCalledTimes(3)
    expect(h.sessions[0].close).toHaveBeenCalled()
    expect(h.sessions[1].close).not.toHaveBeenCalled()
    await h.service.stop()
  })

  it('falls back to one mono session when the second channel cannot open', async () => {
    const sessions: Array<{ sendRealtimeInput: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
    const connect = vi.fn(async () => {
      if (sessions.length === 1) throw new Error('quota')
      const session = { sendRealtimeInput: vi.fn(), close: vi.fn(), callbacks: {} }
      sessions.push(session)
      return session
    })
    const sender = { isDestroyed: () => false, send: vi.fn() }
    const service = new GeminiLiveTranscriptionService(() => ({ live: { connect } }) as never, () => 0)

    await service.start(sender)
    await service.acceptDevicePacket(tone(9000, 8000))

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sendRealtimeInput).toHaveBeenCalledTimes(1)
    const errors = sender.send.mock.calls.filter((c) => c[0] === 'transcription-live:error')
    expect(errors).toHaveLength(1)
    expect(String(errors[0][1].error)).toMatch(/not be split by speaker/)
    await service.stop()
  })

  it('closes both sessions when two starts overlap', async () => {
    const h = harness()
    await Promise.all([h.service.start(h.sender), h.service.start(h.sender)])
    await h.service.stop()
    // Four sessions were opened; the losing pair must not be left running.
    expect(h.sessions.length).toBeGreaterThanOrEqual(2)
    for (const s of h.sessions) expect(s.close).toHaveBeenCalled()
  })

  it('ends both streams on pause and closes both on stop', async () => {
    const h = harness()
    await h.service.start(h.sender)
    h.service.pause()
    for (const s of h.sessions) {
      expect(s.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true })
    }
    await h.service.stop()
    for (const s of h.sessions) expect(s.close).toHaveBeenCalled()
  })
})
