import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND, encodeCustomRecordingProfile, parseFirmwareConsoleStatus } from '../src/index.js'

const profile = Uint8Array.of(0, ...encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }))
const text = (value: string, ack = 0) => Uint8Array.of(ack, ...new TextEncoder().encode(value))
function frame(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12); return bytes
}
const command = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint16(2)
const sequence = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint32(4)

interface ReplyFields { status?: number; flags?: number; nativeState?: number; attempted?: number; successful?: number; lastStatus?: number; word?: number; sequence?: number }
function vadReply(fields: ReplyFields = {}): Uint8Array {
  const body = new Uint8Array(32), view = new DataView(body.buffer)
  body[0] = fields.status ?? 0; body[1] = 1; body[2] = fields.flags ?? 0x01; body[3] = fields.nativeState ?? 0
  view.setUint32(4, fields.attempted ?? 5); view.setUint32(8, fields.successful ?? 3); view.setInt32(12, fields.lastStatus ?? 0)
  view.setUint32(16, fields.word ?? 0); view.setUint32(28, fields.sequence ?? 2)
  return body
}

const devices: JensenDevice[] = []
async function owner(auto?: (bytes: Uint8Array, emit: (bytes: Uint8Array) => void) => void) {
  vi.useFakeTimers()
  const pending: Uint8Array[] = [], sent: Uint8Array[] = []
  const endpoint = Object.assign(new EventEmitter(), { startPoll() { for (const bytes of pending.splice(0)) this.emit('data', bytes) }, stopPoll(done?: () => void) { done?.() } })
  const emit = (bytes: Uint8Array) => { if (endpoint.listenerCount('data')) endpoint.emit('data', bytes); else pending.push(bytes) }
  const handle = { vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: true, async open() {}, async close() {}, async reset() { throw Error('Unexpected reset') }, async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {},
    transferOut: vi.fn(async (_endpoint: number, data: Uint8Array) => { const bytes = new Uint8Array(data); sent.push(bytes); auto?.(bytes, emit); return { status: 'ok', bytesWritten: bytes.length } }),
    device: { interface: () => ({ endpoint: () => endpoint }) } }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  devices.push(device); const connecting = device.tryConnect(handle as unknown as USBDevice); await vi.advanceTimersByTimeAsync(350); expect(await connecting).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393992; device.versionCode = '6.3.8'; device.serialNumber = 'SYNTHETIC0001'; device.deviceValidationReadOnly = true
  return { device, sent, emit }
}
afterEach(async () => { vi.useRealTimers(); for (const device of devices.splice(0)) await device.disconnect() })

const answering = (reply: Uint8Array) => (bytes: Uint8Array, emit: (bytes: Uint8Array) => void) =>
  emit(frame(command(bytes), sequence(bytes), command(bytes) === 0xf111 ? profile : reply))

describe('getNativeVadObservation on the exact 393992 / 6.3.8 pair', () => {
  it('runs F111 then one F11A with the VERSION=1 body, in a read-only validation session', async () => {
    const h = await owner(answering(vadReply({ word: 0xdeadbeef })))
    const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toEqual({ version: 1, nativeState: 0, clockBinding: 'unclocked', imageAttested: false, status: 'ok', hasSample: true,
      attemptedReads: 5, successfulReads: 3, lastCompletedNativeStatus: 0, lastSuccessfulCallerWord: 0xdeadbeef, sequence: 2, age: null, dspFreshness: 'unknown', voice: 'unknown' })
    expect(h.sent.map(command)).toEqual([0xf111, NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND])
    expect(Array.from(h.sent[1].subarray(12))).toEqual([1])
  })
  it('keeps a raw zero word and the sticky HAS_SAMPLE flag without inferring voice or freshness', async () => {
    const h = await owner(answering(vadReply({ word: 0, attempted: 0xffffffff, successful: 0, lastStatus: -7 })))
    const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ status: 'ok', hasSample: true, lastSuccessfulCallerWord: 0, attemptedReads: 0xffffffff, successfulReads: 0, lastCompletedNativeStatus: -7, voice: 'unknown', dspFreshness: 'unknown', age: null })
  })
  it('keeps no-sample state as null word, and busy/unavailable replies as status-only', async () => {
    for (const [reply, expected] of [
      [vadReply({ flags: 0, successful: 0, attempted: 4 }), { status: 'ok', hasSample: false, lastSuccessfulCallerWord: null }],
      [Uint8Array.of(1, 1, 0, 3, ...new Uint8Array(28)), { status: 'busy', nativeState: 3 }],
      [Uint8Array.of(2, 1, 0, 0, ...new Uint8Array(28)), { status: 'unavailable' }],
    ] as const) {
      const h = await owner(answering(reply))
      const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
      expect(await reading).toMatchObject(expected); expect(h.sent.map(command)).toEqual([0xf111, 0xf11a])
      const closing = h.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    }
  })
  it('rejects malformed, unclocked-contract-violating and wrong-length replies after sending exactly one F11A', async () => {
    const good = vadReply()
    const withByte = (index: number, value: number) => { const copy = Uint8Array.from(good); copy[index] = value; return copy }
    for (const reply of [good.subarray(0, 31), Uint8Array.of(...good, 0), new Uint8Array(), withByte(0, 3), withByte(1, 2), withByte(2, 0x02), withByte(20, 1), withByte(31, 3), vadReply({ flags: 0, word: 1, successful: 0 })]) {
      const h = await owner(answering(reply))
      const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
      expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf11a])
      const closing = h.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    }
  })
  it('sends zero OUT on crossed pairs, other models, blank serial, bad timeout or an already aborted signal', async () => {
    for (const [version, code] of [[393991, '6.3.7'], [393990, '6.3.6'], [393988, '6.3.4'], [393986, '6.3.2'], [393992, '6.3.7'], [393991, '6.3.8'], [393992, '6.3.80'], [393992, '6.3.8 '], [393992, ''], [393993, '6.3.8'], [0, '6.3.8']] as const) {
      const h = await owner(); h.device.versionNumber = version; h.device.versionCode = code
      expect(await h.device.getNativeVadObservation()).toBeNull(); expect(h.sent).toEqual([])
    }
    const h = await owner()
    for (const model of ['hidock-p1', 'hidock-h1', 'hidock-h1e-x', '', 'HIDOCK-H1E']) { h.device.model = model as typeof h.device.model; expect(await h.device.getNativeVadObservation()).toBeNull() }
    h.device.model = 'hidock-h1e'; h.device.serialNumber = ' '; expect(await h.device.getNativeVadObservation()).toBeNull()
    h.device.serialNumber = 'SYNTHETIC0001'
    for (const timeout of [0, -1, 11, Number.NaN, Number.POSITIVE_INFINITY]) expect(await h.device.getNativeVadObservation(timeout)).toBeNull()
    const cancel = new AbortController(); cancel.abort()
    expect(await h.device.getNativeVadObservation(5, cancel.signal)).toBeNull(); expect(h.sent).toEqual([])
  })
  it('does not send F11A when the F111 capability is malformed or missing within the single deadline', async () => {
    const malformed = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), Uint8Array.of(0, ...new Uint8Array(16)))))
    const first = malformed.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(20)
    expect(await first).toBeNull(); expect(malformed.sent.map(command)).toEqual([0xf111])
    const closing = malformed.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    const silent = await owner(), second = silent.device.getNativeVadObservation(1); await vi.advanceTimersByTimeAsync(1100)
    expect(await second).toBeNull(); expect(silent.sent.map(command)).toEqual([0xf111])
  })
  it('does not send F11A after a version, serial or connection-epoch change during the capability read', async () => {
    const version = await owner(), changing = version.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(1)
    version.device.versionNumber = 393990; version.device.versionCode = '6.3.6'
    version.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await changing).toBeNull(); expect(version.sent.map(command)).toEqual([0xf111])
    const serial = await owner(), swapping = serial.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(1)
    serial.device.serialNumber = 'DIFFERENT0001'; serial.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await swapping).toBeNull(); expect(serial.sent.map(command)).toEqual([0xf111])
    const epoch = await owner(), reading = epoch.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(1)
    const before = epoch.device.getConnectionSessionId(), disconnecting = epoch.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await disconnecting
    expect(await reading).toBeNull(); expect(epoch.device.getConnectionSessionId()).toBeGreaterThan(before); expect(epoch.sent.map(command)).toEqual([0xf111])
  })
  it('discards a result when the session changes between the F11A reply and its return', async () => {
    const h = await owner((bytes, emit) => { if (command(bytes) === 0xf111) emit(frame(0xf111, sequence(bytes), profile)) })
    const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(15)
    expect(h.sent.map(command)).toEqual([0xf111, 0xf11a]); h.device.serialNumber = 'DIFFERENT0001'
    h.emit(frame(0xf11a, 1, vadReply())); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull()
  })
  it('correlates the exact packet sequence: a stale-sequence reply is ignored, the matching one is accepted', async () => {
    const h = await owner((bytes, emit) => {
      const id = command(bytes), seq = sequence(bytes)
      if (id === 0xf111) emit(frame(id, seq, profile))
      else { emit(frame(id, seq + 1, vadReply({ word: 9 }))); emit(frame(id, seq, vadReply({ word: 7 }))) }
    })
    const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ status: 'ok', lastSuccessfulCallerWord: 7 })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf11a])
  })
  it('abort before the capability reply sends no F11A and still consumes the F111 reply before the next operation', async () => {
    const h = await owner(), cancel = new AbortController()
    const reading = h.device.getNativeVadObservation(5, cancel.signal); await vi.advanceTimersByTimeAsync(1)
    cancel.abort(); const queued = h.device.getFileCount(); await vi.advanceTimersByTimeAsync(10)
    expect(h.sent.map(command)).toEqual([0xf111])
    h.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 6])
    h.emit(frame(6, 1, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20); expect(await queued).toEqual({ count: 2 })
  })
  it('abort after F11A OUT keeps the serialized slot until the exact reply, then discards the result', async () => {
    const h = await owner((bytes, emit) => { if (command(bytes) === 0xf111) emit(frame(0xf111, sequence(bytes), profile)) }), cancel = new AbortController()
    const reading = h.device.getNativeVadObservation(5, cancel.signal); await vi.advanceTimersByTimeAsync(15)
    expect(h.sent.map(command)).toEqual([0xf111, 0xf11a]); cancel.abort(); const queued = h.device.getFileCount()
    await vi.advanceTimersByTimeAsync(10); expect(h.sent.map(command)).toEqual([0xf111, 0xf11a])
    h.emit(frame(0xf11a, 1, vadReply())); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf11a, 6])
    h.emit(frame(6, 2, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20); expect(await queued).toEqual({ count: 2 })
  })
  it('stays unavailable in firmware-recovery read-only mode, where F11A is not a recovery read', async () => {
    const h = await owner(answering(vadReply())); h.device.firmwareRecoveryReadOnly = true
    const reading = h.device.getNativeVadObservation(); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
})

describe('393992 / 6.3.8 admission to the existing custom-control and console getters', () => {
  const slotsText = 'slot=0000ef5c tgt=00000001 pll=c0001014\n'
  const consoleReply = (request: string) => request === 'slots' ? slotsText : request === 'version' ? 'kernel=1.9.0 firmware=6.3.8\n'
    : request === 'help' ? 'help\nversion\nuptime\nvectors\n' : request === 'uptime' ? 'uptime_ms32=7\n' : 'dma=00000458 ring=00000478 clk=c0001014\n'
  const consoleDevice = (auto = (bytes: Uint8Array, emit: (bytes: Uint8Array) => void) =>
    emit(frame(command(bytes), sequence(bytes), command(bytes) === 0xf111 ? profile : text(consoleReply(new TextDecoder().decode(bytes.subarray(12))))))) => owner(auto)

  it.each(['help', 'version', 'uptime', 'vectors', 'slots'] as const)('runs F111 then the exact %s F117 literal on 393992/6.3.8', async request => {
    const h = await consoleDevice()
    const reading = h.device.getFirmwareConsoleStatus(request); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ request, imageAttested: false, ...(request === 'version' ? { firmwareVersion: '6.3.8' } : {}) })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
    expect(new TextDecoder().decode(h.sent[1].subarray(12))).toBe(request)
  })
  it('binds 6.3.8 FVER text to the 6.3.8 pair only and accepts slots text under the 6.3.7 and 6.3.8 expectations only', () => {
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.8\n'), '6.3.8')).toMatchObject({ firmwareVersion: '6.3.8', imageAttested: false })
    for (const expected of ['6.3.2', '6.3.4', '6.3.6', '6.3.7'] as const) expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.8\n'), expected)).toBeNull()
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.7\n'), '6.3.8')).toBeNull()
    expect(parseFirmwareConsoleStatus('slots', text(slotsText), '6.3.8')).toMatchObject({ request: 'slots', targetWord: 1, pllWord: 0xc0001014 })
    expect(parseFirmwareConsoleStatus('slots', text(slotsText), '6.3.7')).toMatchObject({ request: 'slots' })
    for (const expected of ['6.3.2', '6.3.4', '6.3.6'] as const) expect(parseFirmwareConsoleStatus('slots', text(slotsText), expected)).toBeNull()
  })
  it('still rejects crossed pairs for console literals, including 6.3.8 with the neighbouring numbers', async () => {
    for (const [version, code] of [[393992, '6.3.7'], [393991, '6.3.8'], [393990, '6.3.8'], [393992, '6.3.6'], [393993, '6.3.8']] as const) {
      const h = await owner(); h.device.versionNumber = version; h.device.versionCode = code
      expect(await h.device.getFirmwareConsoleStatus('slots')).toBeNull(); expect(await h.device.getFirmwareConsoleStatus('vectors')).toBeNull(); expect(h.sent).toEqual([])
    }
  })
  it('keeps every earlier pair working for its previous console requests', async () => {
    for (const [version, code, request] of [[393986, '6.3.2', 'help'], [393988, '6.3.4', 'vectors'], [393990, '6.3.6', 'vectors'], [393991, '6.3.7', 'slots']] as const) {
      const h = await consoleDevice(); h.device.versionNumber = version; h.device.versionCode = code
      const reading = h.device.getFirmwareConsoleStatus(request); await vi.advanceTimersByTimeAsync(30)
      expect(await reading).toMatchObject({ request }); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
      const closing = h.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    }
  })
  it('admits the exact 6.3.8 pair to the custom profile getter and rejects its crossed neighbours with zero OUT', async () => {
    const h = await owner(answering(new Uint8Array()))
    const reading = h.device.getCustomRecordingProfile(); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).not.toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
    for (const [version, code] of [[393992, '6.3.7'], [393991, '6.3.8'], [393992, '6.3.80']] as const) {
      const crossed = await owner(); crossed.device.versionNumber = version; crossed.device.versionCode = code
      expect(await crossed.device.getCustomRecordingProfile()).toBeNull(); expect(crossed.sent).toEqual([])
    }
  })
})
