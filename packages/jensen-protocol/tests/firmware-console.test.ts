import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, FIRMWARE_CONSOLE_STATUS, FIRMWARE_CONSOLE_REQUESTS, FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES, encodeFirmwareConsoleRequest, parseFirmwareConsoleStatus,
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

describe('fixed read-only vectors diagnostic codec', () => {
  const vectors = (dma: string, ring: string, clk: string) => `dma=${dma} ring=${ring} clk=${clk}\n`
  it('encodes only the literal seven-character vectors query', () => {
    const bytes = encodeFirmwareConsoleRequest('vectors')
    expect(bytes).toHaveLength(7)
    expect(new TextDecoder().decode(bytes)).toBe('vectors')
    expect(FIRMWARE_CONSOLE_REQUESTS).toEqual(['help', 'version', 'uptime', 'vectors'])
  })
  it.each(['vectors\n', 'vectors\0', 'vectors dma', 'vectors 00000458', 'vectors=1', 'Vectors', 'vector', 'vectorss', '0x458', ' vectors', 'vectors '])('rejects argument, address or variant encoding %j', input => {
    expect(() => encodeFirmwareConsoleRequest(input as FirmwareConsoleRequest)).toThrow()
  })
  it('parses an exact 40-byte reply into raw unsigned words without attestation or interpretation', () => {
    const reply = text(vectors('00000458', '00000478', 'c0001014'))
    expect(reply).toHaveLength(41)
    expect(parseFirmwareConsoleStatus('vectors', reply)).toEqual({ request: 'vectors', dmaApiWord: 0x458, ringApiWord: 0x478, clockRegisterWord: 0xc0001014, imageAttested: false })
  })
  it.each([
    ['00000000', '00000000', '00000000', 0, 0, 0],
    ['80000000', '7fffffff', 'ffffffff', 0x80000000, 0x7fffffff, 0xffffffff],
    ['ffffffff', 'ffffffff', '80000000', 0xffffffff, 0xffffffff, 0x80000000],
    ['0a1b2c3d', 'deadbeef', '0000000f', 0x0a1b2c3d, 0xdeadbeef, 0xf]
  ])('keeps full 32-bit unsigned words dma=%s ring=%s clk=%s', (dma, ring, clk, dmaWord, ringWord, clkWord) => {
    const status = parseFirmwareConsoleStatus('vectors', text(vectors(dma, ring, clk)))
    expect(status).toEqual({ request: 'vectors', dmaApiWord: dmaWord, ringApiWord: ringWord, clockRegisterWord: clkWord, imageAttested: false })
    for (const word of [dmaWord, ringWord, clkWord]) { expect(word).toBeGreaterThanOrEqual(0); expect(Number.isInteger(word)).toBe(true) }
  })
  it('ignores the expected firmware pair, so version gates stay untouched', () => {
    const reply = text(vectors('00000458', '00000478', 'c0001014'))
    expect(parseFirmwareConsoleStatus('vectors', reply, '6.3.4')).toMatchObject({ request: 'vectors', imageAttested: false })
    expect(parseFirmwareConsoleStatus('vectors', reply, '6.3.5' as '6.3.4')).toBeNull()
  })
  it('does not expose clock-rate or snapshot claims', () => {
    const status = parseFirmwareConsoleStatus('vectors', text(vectors('00000458', '00000478', 'c0001014')))
    expect(Object.keys(status ?? {}).sort()).toEqual(['clockRegisterWord', 'dmaApiWord', 'imageAttested', 'request', 'ringApiWord'])
  })
  it.each([
    ['uppercase hex', vectors('0000045A', '00000478', 'c0001014')],
    ['mixed-case hex', vectors('0000045a', '00000478', 'C0001014')],
    ['short field', vectors('0000458', '00000478', 'c0001014')],
    ['long field', vectors('000000458', '00000478', 'c0001014')],
    ['0x prefix', vectors('0x000458', '00000478', 'c0001014')],
    ['non-hex digit', vectors('0000045g', '00000478', 'c0001014')],
    ['sign', vectors('-0000458', '00000478', 'c0001014')],
    ['empty field', vectors('', '00000478', 'c0001014')],
    ['reordered fields', 'ring=00000478 dma=00000458 clk=c0001014\n'],
    ['missing field', 'dma=00000458 ring=00000478\n'],
    ['unknown name', 'dma=00000458 ring=00000478 clock=c0001014\n'],
    ['double space', 'dma=00000458  ring=00000478 clk=c0001014\n'],
    ['tab separator', 'dma=00000458\tring=00000478 clk=c0001014\n'],
    ['missing LF', 'dma=00000458 ring=00000478 clk=c0001014'],
    ['CRLF', 'dma=00000458 ring=00000478 clk=c0001014\r\n'],
    ['double LF', `${vectors('00000458', '00000478', 'c0001014')}\n`],
    ['trailing space', 'dma=00000458 ring=00000478 clk=c0001014 \n'],
    ['trailing text', `${vectors('00000458', '00000478', 'c0001014')}extra`],
    ['second line', `${vectors('00000458', '00000478', 'c0001014')}${vectors('00000458', '00000478', 'c0001014')}`],
    ['leading LF', `\n${vectors('00000458', '00000478', 'c0001014')}`],
    ['legacy uptime text', 'uptime_ms32=1\n']
  ])('rejects %s', (_name, reply) => {
    expect(parseFirmwareConsoleStatus('vectors', text(reply))).toBeNull()
  })
  it('rejects non-zero ACK or status bytes, empty, ACK-only and length violations', () => {
    const good = vectors('00000458', '00000478', 'c0001014')
    for (const ack of [1, 2, 0x17, 0xff]) expect(parseFirmwareConsoleStatus('vectors', text(good, ack))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', new Uint8Array())).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', Uint8Array.of(0))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', text(good.slice(0, -2)))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', text(good.slice(0, 20)))).toBeNull()
  })
  it('rejects control, NUL, nonASCII and overlong bodies', () => {
    const good = new TextEncoder().encode(vectors('00000458', '00000478', 'c0001014'))
    for (const [index, byte] of [[5, 0], [5, 1], [5, 9], [5, 13], [5, 127], [5, 128], [5, 255], [20, 0], [39, 0]] as const) {
      const body = Uint8Array.of(0, ...good); body[index + 1] = byte
      expect(parseFirmwareConsoleStatus('vectors', body)).toBeNull()
    }
    expect(parseFirmwareConsoleStatus('vectors', Uint8Array.of(0, ...good, 0))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', Uint8Array.of(0, ...good, 10))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', Uint8Array.of(0, ...good, ...new Uint8Array(FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES)))).toBeNull()
    expect(parseFirmwareConsoleStatus('vectors', new Uint8Array(FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES + 1))).toBeNull()
  })
  it('does not accept a vectors reply under another request, nor another reply under vectors', () => {
    const reply = text(vectors('00000458', '00000478', 'c0001014'))
    for (const request of ['help', 'version', 'uptime'] as const) expect(parseFirmwareConsoleStatus(request, reply)).toBeNull()
    for (const other of ['help\nversion\nuptime\n', 'kernel=1.9.0 firmware=6.3.2\n', 'uptime_ms32=0\n']) expect(parseFirmwareConsoleStatus('vectors', text(other))).toBeNull()
  })
})

describe('help codec keeps the legacy module and accepts the vectors module', () => {
  it('legacy help returns its actual three-command list, unaffected by REQUESTS growing', () => {
    const status = parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\n'))
    expect(status).toEqual({ request: 'help', commands: ['help', 'version', 'uptime'], imageAttested: false })
    expect(FIRMWARE_CONSOLE_REQUESTS).toHaveLength(4)
  })
  it('vectors-capable help returns the actual four-command list', () => {
    expect(parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\nvectors\n'))).toEqual({ request: 'help', commands: ['help', 'version', 'uptime', 'vectors'], imageAttested: false })
  })
  it('returns independent command arrays on every parse', () => {
    const first = parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\nvectors\n'))
    if (first?.request !== 'help') throw Error('expected help')
    first.commands.pop()
    const second = parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\nvectors\n'))
    expect(second).toMatchObject({ commands: ['help', 'version', 'uptime', 'vectors'] })
    expect(parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\n'))).toMatchObject({ commands: ['help', 'version', 'uptime'] })
  })
  it.each([
    'help\nversion\nuptime\nvectors\nvectors\n', 'help\nversion\nuptime\nuptime\n', 'help\nhelp\nversion\nuptime\n',
    'help\nversion\nvectors\nuptime\n', 'vectors\nhelp\nversion\nuptime\n', 'uptime\nversion\nhelp\nvectors\n',
    'help\nversion\nuptime\nvectors\nreboot\n', 'help\nversion\nuptime\nreboot\n', 'help\nversion\nuptime\nvector\n',
    'help\nversion\nuptime\nVectors\n', 'help\nversion\nuptime\nvectors', 'help\nversion\nuptime', 'help\nversion\nuptime\n\n',
    'help\nversion\nuptime\nvectors\n\n', 'help\r\nversion\r\nuptime\r\nvectors\r\n', 'help\nversion\nvectors\n', 'help\nversion\n', '', '\n'
  ])('rejects duplicate, reordered, unknown or malformed help %j', reply => {
    expect(parseFirmwareConsoleStatus('help', text(reply))).toBeNull()
  })
  it('keeps version and uptime parity after vectors was added', () => {
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.2\n'))).toMatchObject({ firmwareVersion: '6.3.2', imageAttested: false })
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.4\n'), '6.3.4')).toMatchObject({ firmwareVersion: '6.3.4' })
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.4\n'))).toBeNull()
    expect(parseFirmwareConsoleStatus('uptime', text('uptime_ms32=4294967295\n'))).toEqual({ request: 'uptime', uptimeMs32: 4294967295, counterBits: 32, imageAttested: false })
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

describe('proposed diagnostic firmware 6.3.6 / 393990 console admission', () => {
  const vectorsText = 'dma=00000458 ring=00000478 clk=c0001014\n'
  const replyFor = (request: FirmwareConsoleRequest, firmware: string) =>
    request === 'help' ? 'help\nversion\nuptime\nvectors\n' : request === 'version' ? `kernel=1.9.0 firmware=${firmware}\n` : request === 'uptime' ? 'uptime_ms32=7\n' : vectorsText
  const as636 = (h: Awaited<ReturnType<typeof owner>>) => { h.device.versionNumber = 393990; h.device.versionCode = '6.3.6' }
  const answering = (firmware: string) => (bytes: Uint8Array, emit: (bytes: Uint8Array) => void) => {
    if (command(bytes) === 0xf111) { emit(frame(0xf111, sequence(bytes), profile)); return }
    emit(frame(command(bytes), sequence(bytes), text(replyFor(new TextDecoder().decode(bytes.subarray(12)) as FirmwareConsoleRequest, firmware))))
  }

  it('parses the exact 6.3.6 version text only for the 6.3.6 pair and keeps imageAttested false', () => {
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.6\n'), '6.3.6')).toEqual({ request: 'version', kernelVersion: '1.9.0', firmwareVersion: '6.3.6', versionSource: 'candidate-literal', imageAttested: false })
    for (const expected of ['6.3.2', '6.3.4'] as const) expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.6\n'), expected)).toBeNull()
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.6\n'))).toBeNull()
    for (const stale of ['6.3.2', '6.3.4', '6.3.5', '6.3.60', '6.3.6 ', '6.3.', '']) expect(parseFirmwareConsoleStatus('version', text(`kernel=1.9.0 firmware=${stale}\n`), '6.3.6')).toBeNull()
    for (const expected of ['6.3.5', '6.3.7', '6.3.60', '', undefined]) {
      if (expected !== undefined) expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.6\n'), expected as '6.3.6')).toBeNull()
    }
  })
  it('keeps the prior 6.3.2 and 6.3.4 version pairs parsing unchanged', () => {
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.2\n'), '6.3.2')).toMatchObject({ firmwareVersion: '6.3.2', imageAttested: false })
    expect(parseFirmwareConsoleStatus('version', text('kernel=1.9.0 firmware=6.3.4\n'), '6.3.4')).toMatchObject({ firmwareVersion: '6.3.4', imageAttested: false })
  })
  it('parses help, uptime and vectors under the 6.3.6 expectation without a version dependency', () => {
    expect(parseFirmwareConsoleStatus('help', text('help\nversion\nuptime\nvectors\n'), '6.3.6')).toEqual({ request: 'help', commands: ['help', 'version', 'uptime', 'vectors'], imageAttested: false })
    expect(parseFirmwareConsoleStatus('uptime', text('uptime_ms32=4294967295\n'), '6.3.6')).toMatchObject({ uptimeMs32: 4294967295, imageAttested: false })
    expect(parseFirmwareConsoleStatus('vectors', text('dma=80000000 ring=ffffffff clk=00000000\n'), '6.3.6'))
      .toEqual({ request: 'vectors', dmaApiWord: 0x80000000, ringApiWord: 0xffffffff, clockRegisterWord: 0, imageAttested: false })
  })

  it.each(['help', 'version', 'uptime', 'vectors'] as const)('runs F111 then exact %s F117 on 393990/6.3.6 and returns an unattested status', async request => {
    const h = await owner(answering('6.3.6')); as636(h)
    const reading = h.device.getFirmwareConsoleStatus(request); await vi.advanceTimersByTimeAsync(30)
    const status = await reading
    expect(status).toMatchObject({ request, imageAttested: false })
    if (request === 'version') expect(status).toMatchObject({ firmwareVersion: '6.3.6' })
    if (request === 'vectors') expect(status).toEqual({ request, dmaApiWord: 0x458, ringApiWord: 0x478, clockRegisterWord: 0xc0001014, imageAttested: false })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
    expect(Array.from(h.sent[1].subarray(12))).toEqual(Array.from(encodeFirmwareConsoleRequest(request)))
  })
  it.each(['6.3.2', '6.3.4'] as const)('still admits the prior %s pair for the vectors query', async firmware => {
    const h = await owner(answering(firmware))
    h.device.versionNumber = firmware === '6.3.2' ? 393986 : 393988; h.device.versionCode = firmware
    const reading = h.device.getFirmwareConsoleStatus('vectors'); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ request: 'vectors', dmaApiWord: 0x458, imageAttested: false })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
  })
  it('rejects 6.3.4 version text received on the 6.3.6 pair, and 6.3.6 text on the 6.3.4 pair', async () => {
    const stale = await owner(answering('6.3.4')); as636(stale)
    const first = stale.device.getFirmwareConsoleStatus('version'); await vi.advanceTimersByTimeAsync(30)
    expect(await first).toBeNull(); expect(stale.sent.map(command)).toEqual([0xf111, 0xf117])
    const closing = stale.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    const forward = await owner(answering('6.3.6')); forward.device.versionNumber = 393988; forward.device.versionCode = '6.3.4'
    const second = forward.device.getFirmwareConsoleStatus('version'); await vi.advanceTimersByTimeAsync(30)
    expect(await second).toBeNull(); expect(forward.sent.map(command)).toEqual([0xf111, 0xf117])
  })
  it.each([
    [393990, '6.3.4'], [393990, '6.3.5'], [393990, '6.3.2'], [393990, '6.3.60'], [393990, '6.3.6 '], [393990, ''], [393990, '6.3.7'],
    [393988, '6.3.6'], [393986, '6.3.6'], [393989, '6.3.6'], [393991, '6.3.6'], [393987, '6.3.6'], [0, '6.3.6']
  ])('sends zero OUT on mismatched number/name %s/%j', async (version, code) => {
    const h = await owner(); h.device.versionNumber = Number(version); h.device.versionCode = String(code)
    expect(await h.device.getFirmwareConsoleStatus('vectors')).toBeNull(); expect(h.sent).toEqual([])
  })
  it('sends zero OUT on 393990/6.3.6 for other models, a blank serial or a missing version', async () => {
    const h = await owner(); as636(h)
    for (const model of ['hidock-p1', 'hidock-h1', 'hidock-h1e-x', '', 'HIDOCK-H1E']) {
      h.device.model = model as typeof h.device.model
      expect(await h.device.getFirmwareConsoleStatus('vectors')).toBeNull()
    }
    h.device.model = 'hidock-h1e'; h.device.serialNumber = ' '
    expect(await h.device.getFirmwareConsoleStatus('vectors')).toBeNull()
    h.device.serialNumber = 'SYNTHETIC0001'; h.device.versionCode = null as unknown as string
    expect(await h.device.getFirmwareConsoleStatus('vectors')).toBeNull()
    expect(h.sent).toEqual([])
  })
  it('keeps the F111 capability check: no F117 when the 6.3.6 capability reply is malformed or missing', async () => {
    const malformed = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), Uint8Array.of(0, ...new Uint8Array(16))))); as636(malformed)
    const first = malformed.device.getFirmwareConsoleStatus('vectors'); await vi.advanceTimersByTimeAsync(20)
    expect(await first).toBeNull(); expect(malformed.sent.map(command)).toEqual([0xf111])
    const closing = malformed.device.disconnect(); await vi.advanceTimersByTimeAsync(1000); await closing
    const silent = await owner(); as636(silent)
    const second = silent.device.getFirmwareConsoleStatus('vectors', 1); await vi.advanceTimersByTimeAsync(1100)
    expect(await second).toBeNull(); expect(silent.sent.map(command)).toEqual([0xf111])
  })
  it('does not dispatch F117 if the pair changes from 6.3.6 to another supported pair before the capability reply', async () => {
    const h = await owner(); as636(h)
    const reading = h.device.getFirmwareConsoleStatus('vectors'); await vi.advanceTimersByTimeAsync(1)
    h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    h.emit(frame(0xf111, 0, profile)); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111])
  })
  it('keeps the sole owner and cancellation fence on 6.3.6: the slot is held until the exact reply', async () => {
    const h = await owner((bytes, emit) => { if (command(bytes) === 0xf111) emit(frame(0xf111, sequence(bytes), profile)) }), cancel = new AbortController()
    as636(h)
    const reading = h.device.getFirmwareConsoleStatus('vectors', 5, cancel.signal); await vi.advanceTimersByTimeAsync(15)
    expect(h.sent.map(command)).toEqual([0xf111, 0xf117]); cancel.abort(); const queued = h.device.getFileCount()
    await vi.advanceTimersByTimeAsync(10); expect(h.sent.map(command)).toEqual([0xf111, 0xf117])
    h.emit(frame(0xf117, 1, text(vectorsText))); await vi.advanceTimersByTimeAsync(20)
    expect(await reading).toBeNull(); expect(h.sent.map(command)).toEqual([0xf111, 0xf117, 6])
    h.emit(frame(6, 2, Uint8Array.of(0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(20); expect(await queued).toEqual({ count: 2 })
  })
  it('admits the exact 6.3.6 pair to the custom profile setter: F111 capability, then one F110 write', async () => {
    const record = Uint8Array.from([82, 69, 65, 49, 2, 0, 0, 0, 0, 0, 128, 0, 0, 0, 128, 0])
    const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), command(bytes) === 0xf111 ? Uint8Array.of(1, ...record) : Uint8Array.of(0)))); as636(h)
    h.device.deviceValidationReadOnly = false
    const writing = h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }); await vi.advanceTimersByTimeAsync(30)
    expect(await writing).toEqual({ result: 'success', persistence: 'unverified' })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf110]); expect(Array.from(h.sent[1].subarray(12))).toEqual(Array.from(record))
  })
  it.each([[393990, '6.3.5'], [393990, '6.3.4'], [393989, '6.3.6'], [393988, '6.3.6'], [393991, '6.3.6'], [393990, '6.3.60']])(
    'sends zero OUT from the custom profile setter on crossed pair %s/%s', async (version, code) => {
      const h = await owner((bytes, emit) => emit(frame(command(bytes), sequence(bytes), profile)))
      h.device.versionNumber = Number(version); h.device.versionCode = String(code); h.device.deviceValidationReadOnly = false
      expect(await h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).toBeNull()
      expect(h.sent).toEqual([])
    })
})
