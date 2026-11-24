// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CMD, JensenDevice } from '../src/index.js'

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../../research/rea/${path}`, import.meta.url)), 'utf8')
const native = JSON.parse(file('completion630-lab/firmware/generation-upload2/wire-fixtures-qualified.json'))
const row = (id: string) => native.cases.find((value: { id: string }) => value.id === id)
const ack = Uint8Array.from(Buffer.from(row('cmdc-base').response_payloads_hex[0], 'hex'))
const rejectedAck = Uint8Array.from(Buffer.from(row('guard-000c-length-valid-values-rejected-8').response_payloads_hex[0], 'hex'))
const acceptedLengths = [8, 12, 16]
function frame(command: number, sequence: number, body: Uint8Array) {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12)
  return bytes
}
type Settings = { autoRecord: boolean; autoPlay: boolean; notification: boolean; bluetoothPrompt: boolean }
function owner(initial: Partial<Settings> = {}, override?: (command: number, sequence: number, body: Uint8Array, emit: (bytes: Uint8Array) => void) => void) {
  const settings = { autoRecord: false, autoPlay: true, notification: true, bluetoothPrompt: false, ...initial }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  const internals = device as unknown as { device: USBDevice; readLoopRunning: boolean; receiveChunks: DataView[]; processBufferedData(): void }
  const sent: Uint8Array[] = []
  const emit = (bytes: Uint8Array) => { internals.receiveChunks.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)); internals.processBufferedData() }
  internals.device = { opened: true, async close() {}, transferOut: vi.fn(async (_endpoint: number, input: Uint8Array) => {
    const bytes = input.slice(), view = new DataView(bytes.buffer), command = view.getUint16(2), seq = view.getUint32(4), body = bytes.subarray(12)
    sent.push(bytes)
    if (override) override(command, seq, body, emit)
    else if (command === CMD.SET_SETTINGS) {
      // Explicit native-selector model based on0103b44c..0103b4fa, not native execution.
      // Refuse four-byte/partial layouts instead of reading an implicit tail.
      expect(acceptedLengths).toContain(body.length)
      if (body[3]) settings.autoRecord = body[3] === 1
      if (body[7]) settings.autoPlay = body[7] === 1
      if (body.length > 8 && body[11]) settings.notification = body[11] === 1
      if (body.length > 12 && body[15]) settings.bluetoothPrompt = body[15] === 1
      emit(frame(command, seq, ack))
    } else {
      expect(command).toBe(CMD.GET_SETTINGS)
      emit(frame(command, seq, Uint8Array.of(0, 0, 0, settings.autoRecord ? 1 : 2, 0, 0, 0, settings.autoPlay ? 1 : 2, 0, 0, 0, settings.notification ? 1 : 2, 0, 0, 0, settings.bluetoothPrompt ? 1 : 2)))
    }
    return { status: 'ok', bytesWritten: bytes.length }
  }) } as unknown as USBDevice
  internals.readLoopRunning = true
  device.model = 'hidock-h1e'; device.versionNumber = 393986; device.versionCode = '6.3.2'; device.serialNumber = 'SYNTHETIC'
  return { device, sent, settings, emit }
}
afterEach(() => { vi.useRealTimers() })

describe('auto-record minimum complete native CMD12 layout', () => {
  it('binds original selectors and native compiled-guard geometry without sending any old four-byte request', () => {
    expect(native.source_system_sha256).toBe('ed69f17b23e35070f81452da177de915b1b0ac8af92f202f0f6862d6fa393b54')
    for (const length of acceptedLengths) {
      expect(row(`guard-000c-length-valid-values-rejected-${length}`)).toMatchObject({ status: 'passed_actual_parser_handler_response', native_return: -1, response_payloads_hex: ['01'] })
    }
    expect(row('guard-000c-short-4')).toMatchObject({ native_return: -22, response_payloads_hex: [] })
    for (const generation of ['generation-upload2', 'restore-build393988/generation-restore4']) {
      expect(file(`completion630-lab/firmware/${generation}/guard630.c`)).toContain('if(n!=8u&&n!=12u&&n!=16u)return 0;')
    }
    const source = file('evidence/h1e-6.3.0-functions/0103a82c.tsv')
    for (const instruction of ['0103b44c\t6385\tld.b r3,(r5,0x3)', '0103b46a\t6785\tld.b r3,(r5,0x7)', '0103b472\t0b0c\tbf 0x0103b488', '0103b48e\t3608\tbt 0x0103b4fa']) expect(source).toContain(instruction)
  })
  it.each([[393986, '6.3.2'], [393988, '6.3.4'], [393984, '6.3.0']] as const)('emits complete8-byte enabled/disabled words on%s/%s and preserves all unrelated settings', async (version, code) => {
    const h = owner(); h.device.versionNumber = version; h.device.versionCode = code
    expect(await h.device.setAutoRecord(true)).toEqual({ result: 'success' })
    expect(await h.device.setAutoRecord(false)).toEqual({ result: 'success' })
    expect(h.sent.map(bytes => Array.from(bytes.subarray(12)))).toEqual([[0, 0, 0, 1, 0, 0, 0, 0], [0, 0, 0, 2, 0, 0, 0, 0]])
    for (const bytes of h.sent) expect(new DataView(bytes.buffer).getUint32(8)).toBe(8)
    expect(h.settings).toEqual({ autoRecord: false, autoPlay: true, notification: true, bluetoothPrompt: false })
    const vendor = file('jensen-service-2026-10-11/client.js')
    expect(vendor).toContain('setAutoRecord=function($e,Ge)')
    expect(vendor).toContain('new zo(GI).body([0,0,0,$e?1:2])')
    expect(vendor).toContain('new zo(GI).body([0,0,0,0,0,0,0,$e?1:2])')
  })
  it('preserves an already-disabled autoplay instead of guessing its state or rewriting all settings', async () => {
    const h = owner({ autoPlay: false, notification: false, bluetoothPrompt: true })
    expect(await h.device.setAutoRecord(true)).toEqual({ result: 'success' })
    expect(h.settings).toEqual({ autoRecord: true, autoPlay: false, notification: false, bluetoothPrompt: true })
    expect(h.sent).toHaveLength(1)
  })
  it('decodes a complete native rejected ACK without claiming success or retrying', async () => {
    const h = owner({}, (command, seq, _body, emit) => emit(frame(command, seq, rejectedAck)))
    expect(await h.device.setAutoRecord(true)).toEqual({ result: 'failed' }); expect(h.sent).toHaveLength(1)
  })
  it.each([new Uint8Array(), Uint8Array.of(0, 0)])('returns unknown for malformed ACK geometry%s without retrying', async body => {
    const h = owner({}, (command, seq, _request, emit) => emit(frame(command, seq, body)))
    expect(await h.device.setAutoRecord(true)).toBeNull(); expect(h.sent).toHaveLength(1)
  })
  it('keeps the serialized slot on a stale ACK and queues a settings read until exact correlation', async () => {
    vi.useFakeTimers()
    const h = owner({}, (command, seq, _body, emit) => { if (command === CMD.SET_SETTINGS) emit(frame(command, seq + 1, ack)) })
    const write = h.device.setAutoRecord(true); await vi.advanceTimersByTimeAsync(1)
    const queued = h.device.getSettings(); await vi.advanceTimersByTimeAsync(10)
    expect(h.sent).toHaveLength(1); expect(h.device.getProtocolDiagnostics().currentCommand?.commandId).toBe(CMD.SET_SETTINGS)
    h.emit(frame(CMD.SET_SETTINGS, 0, ack)); await vi.advanceTimersByTimeAsync(10)
    expect(await write).toEqual({ result: 'success' }); expect(h.sent).toHaveLength(2)
    h.emit(frame(CMD.GET_SETTINGS, 1, Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 2))); await vi.advanceTimersByTimeAsync(10)
    expect(await queued).toMatchObject({ autoRecord: true, autoPlay: false })
  })
  it.each(['deviceValidationReadOnly', 'firmwareRecoveryReadOnly'] as const)('retains%s policy before any settings OUT', async flag => {
    const h = owner(); h.device[flag] = true
    expect(await h.device.setAutoRecord(true)).toBeNull(); expect(h.sent).toEqual([])
  })
  it('rejects invalid input and unsupported legacy firmware without any settings request', async () => {
    const h = owner()
    expect(await h.device.setAutoRecord(1 as unknown as boolean)).toBeNull()
    h.device.versionNumber = 327713
    expect(await h.device.setAutoRecord(true)).toEqual({ result: 'unsupported' }); expect(h.sent).toEqual([])
  })
})
