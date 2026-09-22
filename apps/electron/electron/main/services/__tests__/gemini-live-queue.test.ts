/**
 * Live transcription: the queue between the USB poll and the provider send.
 *
 * `acceptDevicePacket` used to await the Gemini send inline, so the renderer's
 * realtime poll — the only thing draining the device's finite buffer — ran at
 * the speed of a WebSocket. A slow provider made `rest` grow on the device and
 * audio was lost there, where nothing can get it back. These pin the queue that
 * takes provider latency off the USB path: that the poll returns immediately,
 * that the queue is bounded, that it drops the oldest and says so once, that
 * order is preserved, and that it does not outlive its session.
 *
 * The stall the tests use is a slow `live.connect`, because that is the
 * provider latency this code actually awaits: `sendRealtimeInput` hands the
 * bytes to the SDK and returns, while opening or rotating a session is a
 * WebSocket handshake the drain loop has to wait for.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  language: 'es' as string,
  liveMicChannel: undefined as 0 | 1 | undefined,
}))

vi.mock('../brains', () => ({ resolveGeminiApiKey: () => 'test-key' }))
vi.mock('../config', () => ({
  getConfig: () => ({
    transcription: { language: deps.language, liveMicChannel: deps.liveMicChannel },
  }),
  updateConfig: async () => {},
}))

import { GeminiLiveTranscriptionService, MAX_QUEUED_PACKETS } from '../gemini-live-transcription'

const ROTATE_MS = 9 * 60 * 1000

/** A packet whose every frame carries `value` on both channels, sign-alternating. */
function tone(value: number, frames = 5) {
  const data = new Uint8Array(8 + frames * 4)
  const view = new DataView(data.buffer)
  for (let i = 0; i < frames; i++) {
    const sample = i % 2 ? -value : value
    view.setInt16(8 + i * 4, sample, true)
    view.setInt16(8 + i * 4 + 2, sample, true)
  }
  return { rest: 0, muted: false, data }
}

/** The first sample of a base64 PCM payload, which names the packet it came from. */
function firstSampleOf(base64: string): number {
  // byteOffset and byteLength on purpose: Node carves Buffers out of a shared
  // pool, so `.buffer` is the pool and reading from offset 0 reads someone
  // else's bytes.
  const bytes = Buffer.from(base64, 'base64')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(0, true)
}

function harness() {
  const sessions: Array<{
    sendRealtimeInput: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    callbacks: Record<string, (arg?: unknown) => void>
  }> = []
  let gated = false
  const waiting: Array<() => void> = []

  const connect = vi.fn(async (request: Record<string, unknown>) => {
    if (gated) await new Promise<void>((resolve) => waiting.push(resolve))
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

  return {
    sessions,
    connect,
    sender,
    service,
    tick: (ms: number) => {
      clock += ms
    },
    /** Hold every following connect open: the slow-provider case. */
    gate: () => {
      gated = true
    },
    /** Let the held connects finish and give the drain loop room to catch up. */
    open: async () => {
      gated = false
      while (waiting.length > 0) waiting.pop()?.()
      await service.flush()
    },
  }
}

type Harness = ReturnType<typeof harness>

const samplesPerSession = (h: Harness): number[][] =>
  h.sessions.map((session) =>
    session.sendRealtimeInput.mock.calls
      .map((call) => (call[0] as { audio?: { data?: string } }).audio?.data)
      .filter((data): data is string => Boolean(data))
      .map(firstSampleOf)
  )

const allSamples = (h: Harness): number[] => samplesPerSession(h).flat()

const errors = (h: Harness) =>
  h.sender.send.mock.calls
    .filter((c) => c[0] === 'transcription-live:error')
    .map((c) => c[1] as { error: string })

/** Start a session and park it in the middle of a rotation the provider will not finish. */
async function stalled() {
  const h = harness()
  await h.service.start(h.sender)
  h.tick(ROTATE_MS + 1)
  h.gate()
  return h
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.language = 'es'
  deps.liveMicChannel = undefined
})

describe('the realtime send queue', () => {
  it('returns from the poll without waiting for the provider', async () => {
    const h = await stalled()

    // The first packet starts a rotation the provider is holding open. The poll
    // gets its turn back anyway, and keeps handing packets over.
    for (let i = 1; i <= 10; i++) {
      expect(h.service.acceptDevicePacket(tone(i * 100))).toBeUndefined()
    }
    expect(allSamples(h)).toHaveLength(0)

    await h.open()
    const delivered = allSamples(h)
    for (let i = 1; i <= 10; i++) expect(delivered).toContain(i * 100)
    await h.service.stop()
  })

  it('bounds the queue and drops the oldest audio', async () => {
    const h = await stalled()

    // One packet is in flight and MAX_QUEUED_PACKETS wait behind it; 30 more
    // arrive with nowhere to go.
    // Amplitudes stay well above the silence gate, or the gate, not the queue,
    // would be the thing deciding what gets sent.
    const overflow = 30
    const total = MAX_QUEUED_PACKETS + overflow + 1
    for (let i = 1; i <= total; i++) {
      h.service.acceptDevicePacket(tone(1000 + i))
      expect(h.service.queuedPackets).toBeLessThanOrEqual(MAX_QUEUED_PACKETS)
    }
    expect(h.service.queuedPackets).toBe(MAX_QUEUED_PACKETS)

    await h.open()
    expect(h.service.queuedPackets).toBe(0)
    const delivered = allSamples(h)
    // Packet 1 was already in flight; the last MAX_QUEUED_PACKETS queued behind
    // it survived and the 30 oldest of the queued ones were dropped.
    expect(delivered).toContain(1000 + total)
    expect(delivered).toContain(1001)
    expect(delivered).not.toContain(1002)
    expect(new Set(delivered).size).toBe(MAX_QUEUED_PACKETS + 1)
    await h.service.stop()
  })

  it('reports backpressure once, not once per dropped packet', async () => {
    const h = await stalled()
    for (let i = 1; i <= MAX_QUEUED_PACKETS + 50; i++) h.service.acceptDevicePacket(tone(1000 + i))

    expect(errors(h)).toHaveLength(1)
    expect(errors(h)[0].error).toMatch(/falling behind/)

    await h.open()
    await h.service.stop()
  })

  it('says nothing while the queue stays under its bound', async () => {
    const h = await stalled()
    for (let i = 1; i <= MAX_QUEUED_PACKETS - 1; i++) h.service.acceptDevicePacket(tone(1000 + i))
    expect(errors(h)).toHaveLength(0)
    await h.open()
    await h.service.stop()
  })

  it('preserves order: a packet queued first is sent first', async () => {
    const h = await stalled()
    for (let i = 1; i <= 5; i++) h.service.acceptDevicePacket(tone(i * 1000))
    await h.open()

    for (const sequence of samplesPerSession(h)) {
      const ascending = [...sequence].sort((a, b) => a - b)
      expect(sequence).toEqual(ascending)
    }
    // And the run really did go through one session in full, not one packet each.
    expect(samplesPerSession(h)).toContainEqual([1000, 2000, 3000, 4000, 5000])
    await h.service.stop()
  })

  it('delivers the packets waiting when a session rotates at 9 minutes', async () => {
    const h = harness()
    await h.service.start(h.sender)
    h.service.acceptDevicePacket(tone(9000))
    await h.service.flush()

    // Three packets queue behind a rotation the provider is slow to complete.
    h.tick(ROTATE_MS + 1)
    h.gate()
    h.service.acceptDevicePacket(tone(1111))
    h.service.acceptDevicePacket(tone(2222))
    h.service.acceptDevicePacket(tone(3333))
    await h.open()

    const delivered = allSamples(h)
    for (const expected of [9000, 1111, 2222, 3333]) expect(delivered).toContain(expected)
    await h.service.stop()
  })

  it('drains on stop: nothing queued is sent afterwards', async () => {
    const h = await stalled()
    for (let i = 1; i <= 20; i++) h.service.acceptDevicePacket(tone(i * 100))

    // The provider is still holding the rotation open when the user hits stop.
    const stopping = h.service.stop()
    await h.open()
    await stopping

    expect(allSamples(h)).toHaveLength(0)

    // Nothing was left behind to leak into the next session either.
    await h.service.start(h.sender)
    h.service.acceptDevicePacket(tone(777))
    await h.service.flush()
    expect(allSamples(h)).toEqual([777, 777])
    await h.service.stop()
  })

  it('drops queued packets on pause rather than sending past audioStreamEnd', async () => {
    const h = harness()
    await h.service.start(h.sender)
    h.tick(ROTATE_MS + 1)
    h.gate()
    for (let i = 1; i <= 20; i++) h.service.acceptDevicePacket(tone(i * 100))

    expect(h.service.queuedPackets).toBe(19)
    h.service.pause()
    // The queue does not outlive the stream it was filling: the packets are
    // gone at once, not held until the reconnect they were waiting on lands.
    expect(h.service.queuedPackets).toBe(0)
    await h.open()

    expect(allSamples(h)).toHaveLength(0)
    await h.service.stop()
  })

  it('ignores packets that arrive while stopped', async () => {
    const h = harness()
    await h.service.start(h.sender)
    await h.service.stop()
    h.service.acceptDevicePacket(tone(9000))
    await h.service.flush()
    expect(allSamples(h)).toHaveLength(0)
  })
})
