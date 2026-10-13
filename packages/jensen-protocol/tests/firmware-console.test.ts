import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, FIRMWARE_CONSOLE_STATUS, encodeFirmwareConsoleRequest, parseFirmwareConsoleStatus,
  encodeCustomRecordingProfile, type FirmwareConsoleRequest } from '../src/index.js'

const text = (value: string, ack = 0) => Uint8Array.of(ack, ...new TextEncoder().encode(value))
const profile = Uint8Array.of(0, ...encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }))
function frame(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12); return bytes
}
const command = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint16(2)
const sequence = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint32(4)
describe('literal-only candidate console status contract', () => {
  it.each(['help', 'version', 'uptime'] as const)('encodes%s without newline, NUL or arguments', request => {
    expect(new TextDecoder().decode(encodeFirmwareConsoleRequest(request))).toBe(request)
  })
  it.each(['', 'help\n', 'version\0', 'uptime arg', 'reboot', null])('rejects arbitrary input%s', input => {
    expect(() => encodeFirmwareConsoleRequest(input as FirmwareConsoleRequest)).toThrow()
  })
  it('parses exact declared version/help shapes without claiming image attestation', () => {
    expect(parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\n'))).toEqual({ request: 'help', commands: ['help', 'version', 'uptime'], imageAttested: false })
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.2\n'))).toEqual({ request: 'version', kernelVersion: '1.9.0', firmwareVersion: '6.3.2', versionSource: 'candidate-literal', imageAttested: false })
  })
  it('binds dynamic FVER text to the explicitly qualified firmware pair', () => {
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.4\n'), '6.3.4')).toMatchObject({ firmwareVersion: '6.3.4', imageAttested: false })
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.2\n'), '6.3.4')).toBeNull()
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.4\n'))).toBeNull()
    expect(parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\n'), '6.3.5' as '6.3.4')).toBeNull()
  })
  it.each([0, 1, 4294967295])('preserves low32 uptime%s without inferring boot date', uptime => {
    expect(parseFirmwareConsoleStatus('uptime', text(`uptime_ms32=${uptime}\n`))).toEqual({ request: 'uptime', uptimeMs32: uptime, counterBits: 32, imageAttested: false })
  })
  it.each(['uptime_ms32=4294967296\n', 'uptime_ms32=0001\n', 'uptime_ms32=-1\n', 'uptime_ms32=1.5\n', 'uptime_ms32=1\nextra', 'uptime_ms32=1', 'uptime_ms32=1\r\n'])('rejects malformed or overflowing uptime%s', reply => {
    expect(parseFirmwareConsoleStatus('uptime', text(reply))).toBeNull()
  })
  it('rejects wrong ACK, nonASCII, NUL, truncation, oversized or mismatched command text', () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(1), text('help\nversion\nuptime\n', 1), text('kernel=1.9.0 firmware=6.3.3\n'), text('kernel=1.9.0 firmware=6.3.2\n\0'), Uint8Array.of(0, 255, 10), new Uint8Array(257)]) {
      expect(parseFirmwareConsoleStatus('version', bytes)).toBeNull()
    }
    expect(parseFirmwareConsoleStatus('help', text('uptime\nversion\nhelp\n'))).toBeNull()
  })
})

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
  device.model = 'hidock-h1e'; device.versionNumber = 393986; device.versionCode = '6.3.2'; device.serialNumber = 'SYNTHETIC0001'; device.deviceValidationReadOnly = true
  return { device, sent, emit }
}
afterEach(async () => { vi.useRealTimers(); for (const device of devices.splice(0)) await device.disconnect() })

describe('console qualification through the actual serialized public SDK', () => {
  it.each([[393984, '6.3.0'], [393985, '6.3.1'], [393986, '6.3.1'], [393985, '6.3.2'], [393988, '6.3.2'], [393986, '6.3.4'], [393989, '6.3.5']])('sends zero OUT on unsupported or mismatched firmware%s/%s', async (version, code) => {
    const h = await owner(); h.device.versionNumber = Number(version); h.device.versionCode = String(code)
    expect(await h.device.getFirmwareConsoleStatus('help')).toBeNull(); expect(h.sent).toEqual([])
  })
  it.each(['help', 'version', 'uptime'] as const)('qualifies future393988 FVER and unchanged%s ABI with fresh REA1', async request => {
    const h = await owner((bytes, emit) => {
      const reply = command(bytes) === 0xf111 ? profile : text(request === 'help' ? 'help\nversion\nuptime\n' : request === 'version' ? 'kernel=1.9.0 firmware=6.3.4\n' : 'uptime_ms32=0\n')
      emit(frame(command(bytes), sequence(bytes), reply))
    })
    h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    const reading = h.device.getFirmwareConsoleStatus(request); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ request, imageAttested: false, ...(request === 'version' ? { firmwareVersion: '6.3.4' } : {}) })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
  })
  it('rejects stale console FVER text from another supported image', async () => {
    const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), command(bytes) === 0xf111 ? profile : text('kernel=1.9.0 firmware=6.3.2\n'))))
    h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    const reading = h.device.getFirmwareConsoleStatus('version'); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
  })
  it('does not dispatch console if fresh REA1 arrives after a change to another supported firmware pair', async () => {
    const h = await owner(), reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(1)
    h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    h.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('sends zero OUT without an exact H1E identity, valid request, valid deadline or uncancelled input', async () => {
    const h = await owner(); h.device.serialNumber = ''
    expect(await h.device.getFirmwareConsoleStatus('help')).toBeNull()
    h.device.serialNumber = 'SYNTHETIC0001'; h.device.model = 'hidock-p1'
    expect(await h.device.getFirmwareConsoleStatus('help')).toBeNull(); h.device.model = 'hidock-h1e'
    expect(await h.device.getFirmwareConsoleStatus('reboot' as FirmwareConsoleRequest)).toBeNull()
    expect(await h.device.getFirmwareConsoleStatus('help', 11)).toBeNull()
    const cancel = new AbortController(); cancel.abort()
    expect(await h.device.getFirmwareConsoleStatus('help', 5, cancel.signal)).toBeNull(); expect(h.sent).toEqual([])
  })
  it.each(['help', 'version', 'uptime'] as const)('freshly qualifies REA1 and sends exact bounded%s bytes with strict correlation', async request => {
    const h = await owner((bytes, emit) => {
      const id = command(bytes), seq = sequence(bytes)
      if (id === 0xf111) emit(frame(id, seq, profile))
      else {
        expect(id).toBe(FIRMWARE_CONSOLE_STATUS)
        expect(Array.from(bytes.subarray(12))).toEqual(Array.from(encodeFirmwareConsoleRequest(request)))
        const reply = request === 'help' ? 'help\nversion\nuptime\n' : request === 'version' ? 'kernel=1.9.0 firmware=6.3.2\n' : 'uptime_ms32=4294967295\n'
        emit(frame(id, seq + 1, text(reply))); emit(frame(id, seq, text(reply)))
      }
    })
    const reading = h.device.getFirmwareConsoleStatus(request); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ request, imageAttested: false }); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
    expect(h.device.getProtocolDiagnostics().events.filter(event => event.kind === 'frame' && event.commandId === 0xf117).map(event => event.correlated)).toEqual([false, true])
  })
  it('never emits f117 for malformed capability or after identity changes', async () => {
    const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), Uint8Array.of(0, ...new Uint8Array(16)))))
    const reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('rechecks exact cached identity after the fresh capability, even within the same epoch', async () => {
    const h = await owner(), reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(1)
    h.device.serialNumber = 'DIFFERENT0001'; h.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('bounds missing capability by the total deadline and never retries or emits console OUT', async () => {
    const h = await owner(), reading = h.device.getFirmwareConsoleStatus('help', 1)
    await vi.advanceTimersByTimeAsync(1100)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('returns unavailable for rejected/oversized console replies after consuming their complete correlated frame', async () => {
    for (const reply of [Uint8Array.of(1), new Uint8Array(257)]) {
      const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), command(bytes) === 0xf111 ? profile : reply)))
      const reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(30)
      expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
      expect(h.device.getProtocolDiagnostics().currentCommand).toBeNull()
      // Finish this owner while fake timers are advancing, before the next loop owner.
      const closing = h.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    }
  })
  it('cancellation after capability dispatch consumes its correlated reply before advancing another operation', async () => {
    const h = await owner(), cancel = new AbortController()
    const reading = h.device.getFirmwareConsoleStatus('help', 5, cancel.signal); await vi.advanceTimersByTimeAsync(1)
    cancel.abort(); const queued = h.device.getFileCount(); await vi.advanceTimersByTimeAsync(10)
    expect(h.sent.map(command)).toEqual([0xf111])
    h.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 6])
    h.emit(frame(6, 1, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20); expect(await queued).toEqual({ count: 2 })
  })
  it('cancellation after console OUT retains the slot until its exact reply, then discards the result', async () => {
    const h = await owner((bytes, emit) => { if (command(bytes) === 0xf111) emit(frame(0xf111, sequence(bytes), profile)) }), cancel = new AbortController()
    const reading = h.device.getFirmwareConsoleStatus('help', 5, cancel.signal); await vi.advanceTimersByTimeAsync(15)
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117]); cancel.abort(); const queued = h.device.getFileCount()
    await vi.advanceTimersByTimeAsync(10); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
    h.emit(frame(0xf117, 1, text('help\nversion\nuptime\n'))); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf117, 6])
    h.emit(frame(6, 2, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20); expect(await queued).toEqual({ count: 2 })
  })
  it('queued cancellation never sends a capability or takes another operation slot', async () => {
    const h = await owner(), previous = h.device.getFileCount(); await vi.advanceTimersByTimeAsync(1)
    const cancel = new AbortController(), reading = h.device.getFirmwareConsoleStatus('help', 5, cancel.signal); cancel.abort()
    expect(h.device.getProtocolDiagnostics().currentCommand?.commandId).toBe(6)
    h.emit(frame(6, 0, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20)
    expect(await previous).toEqual({ count: 2 }); expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([6])
  })
  it('rejects same-version REA1 capability after an explicit connection epoch change', async () => {
    const h = await owner(), reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(1)
    const epoch = h.device.getConnectionSessionId(), disconnecting = h.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await disconnecting
    expect(await reading).toBeNull(); expect(h.device.getConnectionSessionId()).toBeGreaterThan(epoch); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('excludes forward stock setters and intersects durable recovery despite readonly console allowance', async () => {
    const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), profile)))
    h.device.versionNumber = 393987; h.device.versionCode = '6.3.3'
    expect(await h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).toBeNull()
    expect(h.sent).toEqual([]); h.device.versionNumber = 393986; h.device.versionCode = '6.3.2'; h.device.firmwareRecoveryReadOnly = true
    const reading = h.device.getFirmwareConsoleStatus('help'); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
})
