// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CMD, JensenDevice } from '../src/index.js'

interface NativeCase { id: string; command_id: number; status: string; request_frames_hex?: string[]; response_frames_hex?: string[]; response_payloads_hex?: string[] }
const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/command-contract630-lab/native/wire-fixtures.json', import.meta.url)), 'utf8')) as { source_system_sha256: string; boundary: string; cases: NativeCase[] }
const latestNative = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/command-contract630-lab/native/wire-fixtures-next.json', import.meta.url)), 'utf8')) as typeof native
const zeroNative = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/command-contract630-lab/host/native-sequence-zero/wire-fixtures.json', import.meta.url)), 'utf8')) as typeof native
const fixture = (id: string) => {
  const value = native.cases.find(row => row.id === id)
  if (!value?.response_frames_hex?.length || !value.status.startsWith('passed_actual')) throw new Error(`Missing executed native fixture ${id}`)
  return value
}
function makeDevice() {
  const usb = { getDevices: async () => [], requestDevice: async () => { throw new Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB
  const device = new JensenDevice(usb)
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'; device.serialNumber = 'previous'
  return device
}
function decode(device: JensenDevice, frame: Uint8Array, fragmentSize = frame.length, requestFrame?: Uint8Array): unknown {
  const internals = device as unknown as { currentCommandTag: string | null; pendingPromises: Map<string, unknown>; receiveChunks: DataView[]; processBufferedData(): void }
  const tagFrame = requestFrame ?? frame
  const view = new DataView(tagFrame.buffer, tagFrame.byteOffset, tagFrame.byteLength)
  const tag = `cmd-${view.getUint16(2)}-${view.getUint32(4)}`
  let result: unknown = undefined
  internals.currentCommandTag = tag
  internals.pendingPromises.set(tag, { resolve(value: unknown) { result = value }, reject() {}, timeout: null })
  for (let offset = 0; offset < frame.length; offset += fragmentSize) {
    const slice = frame.subarray(offset, Math.min(frame.length, offset + fragmentSize))
    internals.receiveChunks.push(new DataView(slice.buffer, slice.byteOffset, slice.byteLength))
    internals.processBufferedData()
  }
  return result
}
function frame(command: number, payload: Uint8Array, sequence = 7, padding = 0): Uint8Array {
  const result = new Uint8Array(12 + payload.length + padding), view = new DataView(result.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, (padding << 24) | payload.length)
  result.set(payload, 12); return result
}

describe('actual native Jensen serialized replies decoded by current host', () => {
  it('binds fixtures to the unchanged original system and retains modeled-boundary limits', () => {
    expect(native.source_system_sha256).toBe('5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce')
    expect(native.boundary).toContain('modeled')
  })
  it.each([1, 2, 3, 7, 29])('reads exact 13-byte serial from a native 17-byte identity across%s-byte transport fragments', chunk => {
    const device = makeDevice()
    const result = decode(device, Buffer.from(fixture('cmd1-info').response_frames_hex![0], 'hex'), chunk)
    expect(result).toMatchObject({ versionCode: '6.3.0', versionNumber: 393984, serialNumber: 'LAB630SER0001' })
  })
  it.each([
    ['cmd2-time', { time: '2026-10-12 13:14:15' }],
    ['cmd3-settime', { result: 'success' }],
    ['cmd3-short', { result: 'failed' }],
    ['cmd11-settings', { autoRecord: true, autoPlay: false, notification: true }],
    ['cmd16-card', { capacity: 29792, free: 17824, used: 11968, status: '900' }],
    ['cmd18-inactive', { recording: null }],
    ['cmd18-active', { recording: 'LAB630-Rec.hda' }],
  ])('decodes%s without fabricated fields', (id, expected) => {
    expect(decode(makeDevice(), Buffer.from(fixture(String(id)).response_frames_hex![0], 'hex'), 3)).toMatchObject(expected)
  })
  it('rejects short fixed replies and impossible RTC dates instead of fabricated zero values', () => {
    for (const command of [1, 2, 6, 11, 16, 3, 7]) expect(decode(makeDevice(), frame(command, new Uint8Array()))).toBeNull()
    for (const rtc of ['20260230131415', '20261a12131415', '20261012241415']) expect(decode(makeDevice(), frame(2, Buffer.from(rtc, 'hex')))).toBeNull()
  })
  it('excludes declared transport padding from one-byte acknowledgements', () => {
    expect(decode(makeDevice(), frame(3, Uint8Array.of(0), 7, 3), 2)).toEqual({ result: 'success' })
    expect(decode(makeDevice(), frame(3, Uint8Array.of(0, 0, 0, 0)))).toBeNull()
  })
  it('discards stale same-opcode sequence before cached identity mutation', () => {
    const device = makeDevice()
    const internals = device as unknown as { currentCommandTag: string; pendingPromises: Map<string, unknown>; receiveChunks: DataView[]; processBufferedData(): void }
    internals.currentCommandTag = 'cmd-1-8'
    let resolved = false
    internals.pendingPromises.set('cmd-1-8', { resolve() { resolved = true }, timeout: null })
    const packet = Buffer.from(fixture('cmd1-info').response_frames_hex![0], 'hex')
    internals.receiveChunks.push(new DataView(packet.buffer, packet.byteOffset, packet.byteLength)); internals.processBufferedData()
    expect(resolved).toBe(false); expect(device.serialNumber).toBe('previous'); expect(internals.currentCommandTag).toBe('cmd-1-8')
  })
  it.each([8, 9, 20, 23, 25, 19, 28])('rejects actual fragmented native CMD%s ACK with distorted sequence while accepting retained unfragmented reply', command => {
    const retained = latestNative.cases.find(row => row.id === `${command.toString(16).padStart(4, '0')}-fragmented`)!
    expect(retained.status).toBe('passed_actual_parser_handler_response')
    expect(retained.request_frames_hex).toHaveLength(2)
    const request = Buffer.from(retained.request_frames_hex![0], 'hex')
    const reply = Buffer.from(retained.response_frames_hex![0], 'hex')
    expect(request.readUInt16BE(2)).toBe(command)
    expect(request.readUInt32BE(4)).toBe(7)
    expect(reply.readUInt32BE(4)).toBe(458752)
    const device = makeDevice()
    expect(decode(device, reply, 3, request)).toBeUndefined()
    const internals = device as unknown as { currentCommandTag: string; pendingPromises: Map<string, unknown> }
    expect(internals.currentCommandTag).toBe(`cmd-${command}-7`)
    expect(internals.pendingPromises.has(`cmd-${command}-7`)).toBe(true)
    const whole = latestNative.cases.find(row => row.command_id === command && row.request_frames_hex?.length === 1 && row.response_frames_hex?.length === 1 && Buffer.from(row.response_frames_hex[0], 'hex').readUInt32BE(4) === 7)!
    expect(decode(makeDevice(), Buffer.from(whole.response_frames_hex![0], 'hex'), 3, Buffer.from(whole.request_frames_hex![0], 'hex'))).toBeDefined()
  })
  it.each(['cmd9-zero-whole', 'cmd9-zero-fragmented', 'cmd9-zero-three-fragments', 'cmd9-zero-unarmed-rejection'])('correlates retained actual native%s reply against its original zero-sequence request', id => {
    const retained = zeroNative.cases.find(row => row.id === id)!
    expect(zeroNative.source_system_sha256).toBe(native.source_system_sha256)
    expect(retained.status).toBe('passed_actual_parser_handler_response')
    const request = Buffer.from(retained.request_frames_hex![0], 'hex')
    const reply = Buffer.from(retained.response_frames_hex![0], 'hex')
    expect(request.readUInt32BE(4)).toBe(0); expect(reply.readUInt32BE(4)).toBe(0)
    expect(decode(makeDevice(), reply, 2, request)).toEqual({ result: id === 'cmd9-zero-unarmed-rejection' ? 'failed' : 'success' })
  })
  it('preserves large fragmented payloads past the former 100KiB work-buffer boundary', () => {
    const device = makeDevice()
    const bytes = Uint8Array.from({ length: 180000 }, (_, index) => index % 251)
    expect(decode(device, frame(CMD.TRANSFER_FILE_PARTIAL, bytes), 16384)).toEqual(bytes)
  })
  it('decodes actual native nonempty listing and treats six opaque bytes as opaque', () => {
    const device = makeDevice()
    const payload = Buffer.from(fixture('cmd4-listing-two').response_payloads_hex![0], 'hex')
    const listing = device.parseFileListFlat(payload)
    expect(listing.headerTotal).toBe(2)
    expect(listing.files.map(file => ({ name: file.name, length: file.length, version: file.version }))).toEqual([
      { name: '20251012131415REC001.hda', length: 4096, version: 1 },
      { name: '20261012151617REC002.wav', length: 8192, version: 8 }
    ])
  })
  it('decodes native live sequence/microphone mute without relabeling it queue depth', () => {
    for (const [name, muted] of [['cmd34-active', false], ['cmd34-muted', true]] as const) {
      const result = decode(makeDevice(), Buffer.from(fixture(name).response_frames_hex![0], 'hex'), 4) as { sequenceMinusOne: number; microphoneMuted: boolean; data: Uint8Array }
      expect(result.sequenceMinusOne).toBe(1)
      expect(result.microphoneMuted).toBe(muted)
      expect(Buffer.from(result.data.subarray(8)).toString('hex')).toBe('0080ff7fe80318fc')
    }
  })
  it('returns actual native CMD32 encoding through the full public API without inventing enabled state', async () => {
    const device = makeDevice()
    const internals = device as unknown as { device: USBDevice; readLoopRunning: boolean; sequenceId: number; receiveChunks: DataView[]; processBufferedData(): void }
    internals.sequenceId = 7; internals.readLoopRunning = true
    const transferOut = vi.fn(async (_endpoint: number, request: Uint8Array) => {
      expect(Buffer.from(request).toString('hex')).toBe('123400200000000700000000')
      const reply = Buffer.from(fixture('cmd32-liveencoding').response_frames_hex![0], 'hex')
      internals.receiveChunks.push(new DataView(reply.buffer, reply.byteOffset, reply.byteLength)); internals.processBufferedData()
      return { status: 'ok', bytesWritten: request.length }
    })
    internals.device = { opened: true, transferOut } as unknown as USBDevice
    expect(await device.getRealtimeSettings()).toEqual({ encoding: 1 })
    device.versionNumber = 393733; device.versionCode = '6.2.5'
    expect(await device.getRealtimeSettings()).toBeNull()
    expect(transferOut).toHaveBeenCalledOnce()
  })
  it('rejects invalid outbound RTC/date, names and timeouts before queueing', async () => {
    const device = makeDevice()
    const send = vi.fn().mockResolvedValue({ result: 'success' })
    ;(device as unknown as { sendCommand: typeof send }).sendCommand = send
    expect(await device.setTime(new Date(NaN))).toBeNull()
    for (const name of ['', '../file.hda', 'C:bad', 'nul\0.hda', 'x'.repeat(33), '中文.wav']) expect(await device.deleteFile(name)).toBeNull()
    expect(send).not.toHaveBeenCalled()
    await device.formatCard()
    expect(send.mock.calls[0][1]).toBe(300)
  })

  it('does not report success from an early ACK until OUT completion is qualified', async () => {
    const device = makeDevice()
    const internals = device as unknown as { device: USBDevice; readLoopRunning: boolean; receiveChunks: DataView[]; processBufferedData(): void; performTeardown(): Promise<void> }
    vi.spyOn(internals, 'performTeardown').mockResolvedValue()
    vi.useFakeTimers()
    try {
      let release!: () => void
      internals.readLoopRunning = true
      internals.device = { opened: true, transferOut: async (_endpoint: number, data: Uint8Array) => {
        const request = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const ack = frame(CMD.SET_DEVICE_TIME, Uint8Array.of(0), request.getUint32(4))
        internals.receiveChunks.push(new DataView(ack.buffer)); internals.processBufferedData()
        await new Promise<void>(resolve => { release = resolve })
        return { status: 'ok', bytesWritten: 1 }
      } } as unknown as USBDevice
      let resolved = false
      const pending = device.setTime(new Date(2026, 9, 12, 13, 14, 15)).then(value => { resolved = true; return value })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      expect(resolved).toBe(false)
      release()
      expect(await pending).toBeNull()
      expect(device.isPoisoned()).toBe(true)
      expect(internals.performTeardown).toHaveBeenCalledOnce()
      expect(await device.getTime()).toBeNull()
    } finally { vi.clearAllTimers(); vi.useRealTimers() }
  })
})
