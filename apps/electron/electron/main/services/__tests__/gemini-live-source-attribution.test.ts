/**
 * Live transcription source attribution (client only).
 *
 * The service used to settle a microphone lane from channel noise floors, call it
 * `you`, and store it in the global configuration for every later session, whatever
 * device or firmware was attached. It also kept measuring while the firmware
 * reported the system microphone muted, so a lane silenced on purpose looked like a
 * "far side that is silent between turns" and the other lane was credited as the
 * microphone.
 *
 * What these pin, through the real service with synthetic packet streams and fake
 * provider sessions:
 *   - a lane measured from noise floors never becomes a `you`/`them` label, and an
 *     unknown source stays `speaker-1` / `speaker-2`;
 *   - nothing is written to the configuration by inference, and a value an older
 *     build stored is neither read nor deleted;
 *   - packets that report the microphone muted are not evidence;
 *   - a lane the user pinned still labels, across a reconnect and a restart;
 *   - both PCM lanes reach the provider unchanged.
 *
 * This is the service lifecycle. It is not device, firmware or provider evidence:
 * no hardware, audio, app or network was involved, and the service still has no
 * attested source context (see the report for the typed seam that would give it one).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  transcription: {} as Record<string, unknown>,
  writes: [] as Array<{ section: string; patch: Record<string, unknown> }>,
}))

vi.mock('../brains', () => ({ resolveGeminiApiKey: () => 'test-key' }))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { language: 'es', ...deps.transcription } }),
  updateConfig: async (section: string, patch: Record<string, unknown>) => {
    deps.writes.push({ section, patch })
  },
}))

import {
  GeminiLiveTranscriptionService,
  MicChannelIdentifier,
  splitRealtimeChannels,
} from '../gemini-live-transcription'

type Packet = {
  rest: number
  muted: boolean
  data: Uint8Array
  microphoneMuted?: boolean
  sequenceMinusOne?: number
}

/** 8-byte header, then interleaved L/R PCM16LE. */
function packet(frames: Array<[number, number]>, extra: Partial<Packet> = {}): Packet {
  const data = new Uint8Array(8 + frames.length * 4)
  const view = new DataView(data.buffer)
  frames.forEach(([l, r], i) => {
    view.setInt16(8 + i * 4, l, true)
    view.setInt16(8 + i * 4 + 2, r, true)
  })
  return { rest: 0, muted: false, data, ...extra }
}

/** Square waves of amplitude l / r: no DC, so the measured level is the amplitude. */
const tone = (l: number, r: number, n = 400, extra: Partial<Packet> = {}) =>
  packet(Array.from({ length: n }, (_, i) => (i % 2 ? [-l, -r] : [l, r]) as [number, number]), extra)

/** Lane 0 muted by the firmware (zeros), lane 1 carrying audio. */
const mutedLaneZero = (r: number, n = 400): Packet =>
  packet(Array.from({ length: n }, (_, i) => [0, i % 2 ? -r : r] as [number, number]), {
    microphoneMuted: true,
    muted: true,
    sequenceMinusOne: 1,
  })

function harness() {
  const sessions: Array<{
    sendRealtimeInput: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    callbacks: Record<string, (arg?: unknown) => void>
  }> = []
  const connect = vi.fn(async (request: Record<string, unknown>) => {
    const session = {
      sendRealtimeInput: vi.fn(),
      close: vi.fn(),
      callbacks: request.callbacks as Record<string, (arg?: unknown) => void>,
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

const deliver = async (service: GeminiLiveTranscriptionService, p: Packet) => {
  service.acceptDevicePacket(p as never)
  await service.flush()
}
const events = (sender: { send: ReturnType<typeof vi.fn> }, channel: string) =>
  sender.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])
const say = (session: { callbacks: Record<string, (arg?: unknown) => void> }, text: string) =>
  session.callbacks.onmessage?.({ serverContent: { inputTranscription: { text } } } as never)
const read = (pcm: Uint8Array, frame: number) =>
  new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(frame * 2, true)
/** The PCM a provider session received, decoded from its base64 payload. */
const sentPcm = (session: { sendRealtimeInput: ReturnType<typeof vi.fn> }): Uint8Array[] =>
  session.sendRealtimeInput.mock.calls
    .map((call) => (call[0] as { audio?: { data?: string } }).audio?.data)
    .filter((data): data is string => Boolean(data))
    .map((data) => new Uint8Array(Buffer.from(data, 'base64')))

beforeEach(() => {
  vi.clearAllMocks()
  deps.transcription = {}
  deps.writes = []
})

describe('an unknown source stays neutral', () => {
  it('does not call a measured lane `you`, announces no microphone, and says why', async () => {
    const h = harness()
    await h.service.start(h.sender)
    // The shape the old heuristic settled on: lane 0 keeps a room floor, lane 1 drops to near zero.
    for (let i = 0; i < 210; i++) await deliver(h.service, i % 2 ? tone(250, 5) : tone(3000, 9000))
    say(h.sessions[0], 'lane zero')
    say(h.sessions[1], 'lane one')

    const finals = events(h.sender, 'transcription-live:final')
    expect(finals.map((f) => f.speaker)).toEqual(['speaker-1', 'speaker-2'])
    expect(finals.map((f) => f.channel)).toEqual([0, 1]) // the cable is still reported
    const announced = events(h.sender, 'transcription-live:channels')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ micChannel: null, source: 'unattested' })
    // The floors are evidence; the hint is a diagnostic, not an answer.
    expect(announced[0].left).toBeGreaterThan(announced[0].right)
    for (const event of [...finals, ...announced]) {
      expect(JSON.stringify(event)).not.toMatch(/"you"|"them"/)
    }
    await h.service.stop()
  })

  it('writes nothing to the configuration from inference', async () => {
    const h = harness()
    await h.service.start(h.sender)
    for (let i = 0; i < 210; i++) await deliver(h.service, tone(9000, 300))
    expect(events(h.sender, 'transcription-live:channels')).toHaveLength(1)
    await h.service.stop()
    expect(deps.writes).toEqual([])
  })

  it('does not reuse a lane an older build measured and stored globally, and leaves it in place', async () => {
    deps.transcription = { liveMicChannelMeasured: 1 } // a global guess from some earlier device
    const h = harness()
    await h.service.start(h.sender)
    await deliver(h.service, tone(9000, 8000))
    say(h.sessions[0], 'a')
    say(h.sessions[1], 'b')
    expect(events(h.sender, 'transcription-live:final').map((f) => f.speaker)).toEqual(['speaker-1', 'speaker-2'])
    await h.service.stop()
    expect(deps.writes).toEqual([]) // nothing deleted, nothing overwritten
    expect(deps.transcription.liveMicChannelMeasured).toBe(1)
  })

  it('stays neutral across a reconnect and a second session on the same service', async () => {
    const h = harness()
    await h.service.start(h.sender)
    for (let i = 0; i < 210; i++) await deliver(h.service, tone(9000, 300))
    await h.service.stop()
    await h.service.start(h.sender) // a different device could be attached now
    await deliver(h.service, tone(9000, 8000))
    say(h.sessions.at(-2)!, 'again')
    expect(events(h.sender, 'transcription-live:final').at(-1)).toMatchObject({ speaker: 'speaker-1' })
    expect(deps.writes).toEqual([])
    await h.service.stop()
  })
})

describe('a muted microphone is not evidence', () => {
  it('does not infer a microphone from a muted lane 0 with an active lane 1', async () => {
    const h = harness()
    await h.service.start(h.sender)
    for (let i = 0; i < 260; i++) await deliver(h.service, mutedLaneZero(8000))
    expect(events(h.sender, 'transcription-live:channels')).toHaveLength(0) // the window never opened
    say(h.sessions[1], 'only lane one')
    expect(events(h.sender, 'transcription-live:final').at(-1)).toMatchObject({ speaker: 'speaker-2', channel: 1 })
    expect(deps.writes).toEqual([])
    await h.service.stop()
  })

  it('shows what the old measurement did with the same stream (control)', () => {
    const id = new MicChannelIdentifier()
    for (let i = 0; i < 260; i++) id.observe(splitRealtimeChannels(mutedLaneZero(8000) as never)!, 100)
    expect(id.micChannel).toBe(1) // the muted lane read as "digital silence", so lane 1 became the mic
    const guarded = new MicChannelIdentifier()
    for (let i = 0; i < 260; i++) {
      guarded.observe(splitRealtimeChannels(mutedLaneZero(8000) as never)!, 100, { microphoneMuted: true })
    }
    expect(guarded.settled).toBe(false)
    expect(guarded.micChannel).toBeNull()
  })

  it('keeps measuring from packets that do not report a mute', async () => {
    const h = harness()
    await h.service.start(h.sender)
    for (let i = 0; i < 100; i++) await deliver(h.service, mutedLaneZero(8000))
    for (let i = 0; i < 210; i++) await deliver(h.service, tone(9000, 300))
    const announced = events(h.sender, 'transcription-live:channels')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ micChannel: null, measuredHint: 0 })
    await h.service.stop()
  })

  it('a legacy `muted` packet with no microphoneMuted field is still dropped whole', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await deliver(h.service, tone(9000, 8000, 400, { muted: true }))
    expect(h.sessions[0].sendRealtimeInput).not.toHaveBeenCalled()
    expect(h.sessions[1].sendRealtimeInput).not.toHaveBeenCalled()
    await h.service.stop()
  })
})

describe('an explicit user pin still labels', () => {
  it('labels from the first packet, measures nothing, and persists nothing', async () => {
    deps.transcription = { liveMicChannel: 1 }
    const h = harness()
    await h.service.start(h.sender)
    await deliver(h.service, tone(9000, 8000))
    say(h.sessions[0], 'far')
    say(h.sessions[1], 'mine')
    const finals = events(h.sender, 'transcription-live:final')
    expect(finals.at(-2)).toMatchObject({ text: 'far', speaker: 'them', channel: 0 })
    expect(finals.at(-1)).toMatchObject({ text: 'mine', speaker: 'you', channel: 1 })
    // A pinned identifier is settled from the start, so there is no measurement to announce.
    for (let i = 0; i < 210; i++) await deliver(h.service, tone(300, 9000))
    expect(events(h.sender, 'transcription-live:channels')).toHaveLength(0)
    expect(deps.writes).toEqual([])
    await h.service.stop()
  })

  it('wins over a stored measured value and over what the audio looks like', async () => {
    deps.transcription = { liveMicChannel: 0, liveMicChannelMeasured: 1 }
    const h = harness()
    await h.service.start(h.sender)
    // The audio shape would measure lane 1; the pin says lane 0.
    for (let i = 0; i < 210; i++) await deliver(h.service, tone(300, 9000))
    say(h.sessions[0], 'x')
    say(h.sessions[1], 'y')
    const finals = events(h.sender, 'transcription-live:final')
    expect(finals.at(-2)).toMatchObject({ speaker: 'you', channel: 0 })
    expect(finals.at(-1)).toMatchObject({ speaker: 'them', channel: 1 })
    await h.service.stop()
  })

  it('applies a pin changed between sessions, and returning to automatic goes neutral again', async () => {
    const h = harness()
    deps.transcription = { liveMicChannel: 0 }
    await h.service.start(h.sender)
    say(h.sessions.at(-2)!, 'one')
    expect(events(h.sender, 'transcription-live:final').at(-1)).toMatchObject({ speaker: 'you' })
    await h.service.stop()

    deps.transcription = { liveMicChannel: null }
    await h.service.start(h.sender)
    say(h.sessions.at(-2)!, 'two')
    expect(events(h.sender, 'transcription-live:final').at(-1)).toMatchObject({ speaker: 'speaker-1' })
    await h.service.stop()
  })

  it('keeps the pin through a provider session rotation', async () => {
    deps.transcription = { liveMicChannel: 0 }
    const h = harness()
    await h.service.start(h.sender)
    await deliver(h.service, tone(9000, 9000, 5))
    h.tick(9 * 60 * 1000 + 1)
    await deliver(h.service, tone(9000, 9000, 5))
    expect(h.connect.mock.calls.length).toBeGreaterThan(2) // rotated
    const fresh = h.sessions.at(-2)!
    say(fresh, 'after rotation')
    expect(events(h.sender, 'transcription-live:final').at(-1)).toMatchObject({ speaker: 'you', channel: 0 })
    await h.service.stop()
  })
})

describe('the two PCM lanes are preserved', () => {
  it('sends each lane unchanged to its own session while the microphone is reported muted', async () => {
    const h = harness()
    await h.service.start(h.sender)
    // Lane 0 is muted and silent, so it is gated off; lane 1 must arrive sample for sample.
    const p = mutedLaneZero(7000, 40)
    await deliver(h.service, p)
    expect(h.sessions[0].sendRealtimeInput).not.toHaveBeenCalled()
    const lane1 = sentPcm(h.sessions[1])
    expect(lane1).toHaveLength(1)
    expect(lane1[0]).toHaveLength(40 * 2)
    for (let frame = 0; frame < 40; frame++) expect(read(lane1[0], frame)).toBe(frame % 2 ? -7000 : 7000)
    await h.service.stop()
  })

  it('does not mix the lanes: distinct lanes arrive as distinct, unaveraged streams', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await deliver(h.service, tone(9000, 4000, 40))
    const lane0 = sentPcm(h.sessions[0])[0]
    const lane1 = sentPcm(h.sessions[1])[0]
    expect(read(lane0, 0)).toBe(9000)
    expect(read(lane1, 0)).toBe(4000)
    expect(read(lane0, 1)).toBe(-9000)
    expect(read(lane1, 1)).toBe(-4000)
    await h.service.stop()
  })

  it('keeps raw PCM identical whether or not a lane is pinned', async () => {
    const send = async (transcription: Record<string, unknown>) => {
      deps.transcription = transcription
      const h = harness()
      await h.service.start(h.sender)
      await deliver(h.service, tone(9000, 4000, 40))
      const out = [sentPcm(h.sessions[0])[0], sentPcm(h.sessions[1])[0]]
      await h.service.stop()
      return out.map((pcm) => Buffer.from(pcm).toString('hex'))
    }
    expect(await send({ liveMicChannel: 0 })).toEqual(await send({}))
  })
})
