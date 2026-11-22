import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, encodeRecordingRestore, parseRecordingRestoreCapabilities, parseRecordingRestoreReply,
  isRecordingRestoreFilename, isRecordingRestoreDescriptor, isRecordingRestoreReadOnlyBody, type RecordingRestoreDescriptor,
  type RecordingRestoreSession, type RecordingRestoreWriteOptions } from '../src/index.js'
const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/restore-build393988/restore-execution.json', import.meta.url)), 'utf8'))
const row = (id: string) => native.cases.find((value: { id: string }) => value.id === id)
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
function descriptor(id = 'begin-1'): RecordingRestoreDescriptor {
  const item = row(id), request = bytes(item.request_frames_hex[0]).subarray(12), response = bytes(item.response_payloads_hex[0])
  const req = new DataView(request.buffer, request.byteOffset, request.length), view = new DataView(response.buffer, response.byteOffset, response.length)
  return { restoreId: req.getUint32(1), ownerToken: request.slice(5, 21), totalBytes: view.getUint32(12), wholeCrc32: view.getUint32(16),
    sourceSha256: response.slice(20, 52), filename: String.fromCharCode(...response.subarray(53)) }
}
const binding = descriptor(), cap = bytes(row('capability').response_payloads_hex[0])
const consent: RecordingRestoreWriteOptions = { ownedRecordingRestoreConsent: true, normalJensen: true, massStorageInactive: true, audioQuiescent: true }
describe('prospective RSTR2 codec against actual compiled native replies', () => {
  it('binds the current native prototype and exact capability limits', () => {
    expect(native.system_sha256).toBe('b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f')
    expect(parseRecordingRestoreCapabilities(cap)).toMatchObject({ protocol: 1, fileMaxBytes: 2147483647, featureFlags: 63, journalTotalBytes: 1024, imageAttested: false })
    for (const offset of [0, 1, 6, 7, 8, 12, 14, 16, 18, 20]) { const bad = cap.slice(); bad[offset] ^= 255; expect(parseRecordingRestoreCapabilities(bad)).toBeNull() }
    expect(parseRecordingRestoreCapabilities(cap.subarray(0, 23))).toBeNull()
  })
  it('encodes actual begin,1024-byte append and final8-byte append with exact IDs/token/CRC/name', () => {
    expect(encodeRecordingRestore(binding, { operation: 'begin' })).toEqual(bytes(row('begin-1').request_frames_hex[0]).subarray(12))
    for (const id of ['append-1-0', 'append-1-8192']) {
      const body = bytes(row(id).request_frames_hex[0]).subarray(12), view = new DataView(body.buffer, body.byteOffset, body.length)
      expect(encodeRecordingRestore(binding, { operation: 'append', offset: view.getUint32(21), data: body.slice(29) })).toEqual(body)
    }
  })
  it.each(['tmp-verify4096', 'tmp-verify8192', 'rename-only-after-full-tmp', 'final-verify4096', 'final-verify8192', 'finished-full-final-crc'])('parses native%s without confusing state4 and FINISHED5', id => {
    const parsed = parseRecordingRestoreReply(binding, { operation: 'verify-commit-step' }, bytes(row(id).response_payloads_hex[0]))
    expect(parsed?.checkpoint).toBe('validated-binding'); expect(parsed?.deviceFinished).toBe(id === 'finished-full-final-crc')
    expect(parsed?.sha256Provenance).toBe('stored-expected'); expect(parsed?.hostFullSha256ReadbackRequired).toBe(true)
  })
  it('retains owner STATUS error counters and binding while requiring explicit recovery', () => {
    const source = descriptor('stage-ahead-status'), parsed = parseRecordingRestoreReply(source, { operation: 'status' }, bytes(row('stage-ahead-status').response_payloads_hex[0]))
    expect(parsed).toMatchObject({ acknowledgement: 'rejected', reasonCode: 8, checkpoint: 'validated-binding', recovery: 'explicit-recover-step-required', deviceFinished: false,
      metadata: { uploadedBytes: 512, verifiedBytes: 0, totalBytes: 1024, filename: 'recover.wav' } })
    expect(parseRecordingRestoreReply(source, { operation: 'recover-step' }, bytes(row('recover-owned-prefix').response_payloads_hex[0]))).toMatchObject({ acknowledgement: 'accepted', metadata: { uploadedBytes: 512 } })
  })
  it('treats short ACK1 state only as a pre-operation hint, not a checkpoint or completion', () => {
    expect(parseRecordingRestoreReply(binding, { operation: 'abort' }, bytes(row('final-never-aborted').response_payloads_hex[0]))).toMatchObject({ stateCode: 5, reasonCode: 11,
      checkpoint: 'unavailable-preoperation-hint', metadata: null, deviceFinished: false, recovery: 'manual-investigation-required' })
    expect(parseRecordingRestoreReply(binding, { operation: 'status' }, Uint8Array.of(0, 5, 0, 0))).toBeNull()
  })
  it('accepts signed2GiB-1 native declaration without allocating file-sized buffers', () => {
    const source = descriptor('largeBEGIN-2147483647')
    expect(source.totalBytes).toBe(2147483647); expect(isRecordingRestoreDescriptor(source)).toBe(true)
    expect(encodeRecordingRestore(source, { operation: 'begin' }).length).toBeLessThanOrEqual(89)
    expect(isRecordingRestoreDescriptor({ ...source, totalBytes: 2147483648 })).toBe(false)
  })
  it('enforces explicit empty-file provenance, original flat names and nonfinal chunk bounds', () => {
    for (const name of ['../x.wav', '.x.hda', 'x.WAV', 'x.tmp', 'x.wav ', 'x:bad.wav', 'á.wav', 'x'.repeat(28) + '.wav']) expect(isRecordingRestoreFilename(name)).toBe(false)
    expect(isRecordingRestoreFilename('REA00000001.hda')).toBe(true); expect(isRecordingRestoreFilename(binding.filename)).toBe(true)
    expect(() => encodeRecordingRestore(binding, { operation: 'append', offset: 0, data: new Uint8Array(511) })).toThrow()
    expect(() => encodeRecordingRestore(binding, { operation: 'append', offset: 8199, data: new Uint8Array(2) })).toThrow()
    expect(isRecordingRestoreDescriptor({ ...binding, ownerToken: new Uint8Array(16) })).toBe(false)
    expect(isRecordingRestoreDescriptor({ ...binding, totalBytes: 0, wholeCrc32: 0 })).toBe(false)
    const empty = { ...binding, totalBytes: 0, wholeCrc32: 0, sourceSha256: bytes('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') }
    expect(isRecordingRestoreDescriptor(empty)).toBe(true)
    expect(() => encodeRecordingRestore(empty, { operation: 'append', offset: 0, data: Uint8Array.of(1) })).toThrow()
  })
  it('rejects altered full bindings/geometry/counters and only whitelists exact cap/status bodies', () => {
    const body = bytes(row('readonly-finished').response_payloads_hex[0])
    for (const offset of [0, 1, 2, 4, 8, 12, 16, 20, 52, 53]) { const bad = body.slice(); bad[offset] ^= 255; expect(parseRecordingRestoreReply(binding, { operation: 'status' }, bad)).toBeNull() }
    expect(isRecordingRestoreReadOnlyBody(Uint8Array.of(5))).toBe(true)
    expect(isRecordingRestoreReadOnlyBody(encodeRecordingRestore(binding, { operation: 'status' }))).toBe(true)
    for (const operation of ['begin', 'verify-commit-step', 'abort', 'recover-step'] as const) expect(isRecordingRestoreReadOnlyBody(encodeRecordingRestore(binding, { operation }))).toBe(false)
    expect(isRecordingRestoreReadOnlyBody(Uint8Array.of(5, 0))).toBe(false)
  })
})

function frame(id: number, seq: number, body: Uint8Array) {
  const result = new Uint8Array(12 + body.length), view = new DataView(result.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, id); view.setUint32(4, seq); view.setUint32(8, body.length); result.set(body, 12); return result
}
const devices: JensenDevice[] = []
async function owner(restoreReply?: (request: Uint8Array) => Uint8Array | null,
  options: { capability?: Uint8Array; nativeStatus?: Uint8Array; holdCount?: boolean; onRequest?: (id: number) => void } = {}) {
  const pending: Uint8Array[] = [], sent: Uint8Array[] = []
  const endpoint = Object.assign(new EventEmitter(), { startPoll() { for (const value of pending.splice(0)) this.emit('data', value) }, stopPoll(done?: () => void) { done?.() } })
  const emit = (value: Uint8Array) => { if (endpoint.listenerCount('data')) endpoint.emit('data', value); else pending.push(value) }
  const handle = { vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: false, async open() { this.opened = true }, async close() { this.opened = false }, async reset() { throw Error('Unexpected reset') },
    async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {}, device: { interface: () => ({ endpoint: () => endpoint }) },
    async transferOut(_ep: number, input: Uint8Array) {
      const request = input.slice(), view = new DataView(request.buffer), id = view.getUint16(2), seq = view.getUint32(4); sent.push(request)
      options.onRequest?.(id)
      const body = id === 0xf119 ? request[12] === 5 ? options.capability ?? cap : restoreReply?.(request) ?? null :
        id === 6 ? options.holdCount ? null : Uint8Array.of(0, 0, 0, 2) : id === 29 ? options.nativeStatus ?? new Uint8Array() : new Uint8Array()
      if (body) emit(frame(id, seq, body)); return { status: 'ok', bytesWritten: request.length }
    } }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  devices.push(device); expect(await device.tryConnect(handle as unknown as USBDevice)).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393988; device.versionCode = '6.3.4'; device.serialNumber = 'SYNTHETIC-RSTR'
  const session = device.createRecordingRestoreSession(binding)!; expect(session).not.toBeNull()
  return { device, session, sent, emit }
}
afterEach(async () => { for (const device of devices.splice(0)) await device.disconnect() })
describe('future RSTR2 public SDK helpers at the actual queue with synthetic transport', () => {
  it('rejects current393986 and forward393989 before any capability request', async () => {
    const h = await owner()
    for (const version of [393986, 393987, 393989]) {
      h.device.versionNumber = version; h.device.versionCode = `6.3.${version - 393984}`
      expect(h.device.createRecordingRestoreSession(binding)).toBeNull(); expect(await h.device.getRecordingRestoreCapabilities()).toBeNull()
      expect(await h.device.getRecordingRestoreStatus(h.session)).toBeNull()
      expect(await h.device.applyRecordingRestore(h.session, { operation: 'begin' }, consent)).toMatchObject({ status: 'rejected-before-dispatch' })
    }
    expect(h.sent).toEqual([])
  })
  it('uses fresh exact capability/idle reads and one native begin body without commit loops', async () => {
    const h = await owner(request => { expect(request.subarray(12)).toEqual(encodeRecordingRestore(binding, { operation: 'begin' })); return bytes(row('begin-1').response_payloads_hex[0]) })
    expect(await h.device.applyRecordingRestore(h.session, { operation: 'begin' }, consent)).toMatchObject({ status: 'reply', reply: { deviceFinished: false, metadata: { uploadedBytes: 0 } } })
    expect(h.sent.map(bytes => new DataView(bytes.buffer).getUint16(2))).toEqual([0xf119, 29, 18, 0xf119])
    expect(h.sent.filter(value => new DataView(value.buffer).getUint16(2) === 0xf119).map(value => value[12])).toEqual([5, 0])
  })
  it('returns full ACK1 STATUS binding under both readonly policies without automatically recovering', async () => {
    const h = await owner(() => bytes(row('stage-ahead-status').response_payloads_hex[0])), session = h.device.createRecordingRestoreSession(descriptor('stage-ahead-status'))!
    h.device.deviceValidationReadOnly = true; h.device.firmwareRecoveryReadOnly = true
    expect(await h.device.getRecordingRestoreStatus(session)).toMatchObject({ acknowledgement: 'rejected', reasonCode: 8, metadata: { uploadedBytes: 512 }, recovery: 'explicit-recover-step-required' })
    for (const operation of ['begin', 'verify-commit-step', 'abort', 'recover-step'] as const) expect(await h.device.applyRecordingRestore(session, { operation }, consent)).toMatchObject({ status: 'rejected-before-dispatch' })
    expect(h.sent.map(value => value[12])).toEqual([5, 4])
  })
  it('requires explicit consent and returns uncertain on missing mutation ACK without retry', async () => {
    const h = await owner()
    expect(await h.device.applyRecordingRestore(h.session, { operation: 'begin' }, {} as RecordingRestoreWriteOptions)).toMatchObject({ commandAttempted: false })
    expect(h.sent).toEqual([])
    expect(await h.device.applyRecordingRestore(h.session, { operation: 'begin' }, { ...consent, timeout: .2 })).toMatchObject({ status: 'uncertain', commandAttempted: true })
    expect(h.sent.filter(value => new DataView(value.buffer).getUint16(2) === 0xf119).map(value => value[12])).toEqual([5, 0])
  })
  it('rejects stale connection metadata and cancelled requests before OUT', async () => {
    const h = await owner(), aborted = new AbortController(); aborted.abort()
    expect(await h.device.getRecordingRestoreCapabilities(5, aborted.signal)).toBeNull()
    const stale = { ...h.session, connectionSessionId: h.session.connectionSessionId + 1 } as RecordingRestoreSession
    expect(await h.device.getRecordingRestoreStatus(stale)).toBeNull()
    expect(await h.device.applyRecordingRestore(stale, { operation: 'recover-step' }, consent)).toMatchObject({ commandAttempted: false })
    expect(h.sent).toEqual([])
  })
  it('blocks wrong capability limits and native active state before any write', async () => {
    const incompatible = cap.slice(); incompatible[19] &= ~16
    const rejected = await owner(undefined, { capability: incompatible })
    expect(await rejected.device.applyRecordingRestore(rejected.session, { operation: 'begin' }, consent)).toMatchObject({ commandAttempted: false, reason: 'capability-unavailable' })
    expect(rejected.sent.map(value => value[12])).toEqual([5])
    const active = await owner(undefined, { nativeStatus: Uint8Array.of(0, 1, 65, 0, 1, 0) })
    expect(await active.device.applyRecordingRestore(active.session, { operation: 'begin' }, consent)).toMatchObject({ commandAttempted: false, reason: 'native-idle-unavailable' })
    expect(active.sent.map(value => new DataView(value.buffer).getUint16(2))).toEqual([0xf119, 29])
  })
  it('rejects a changed device after capability instead of continuing preflight or writing', async () => {
    let device: JensenDevice
    const h = await owner(undefined, { onRequest: id => { if (id === 0xf119) device.serialNumber = 'DIFFERENT'; } }); device = h.device
    expect(await h.device.applyRecordingRestore(h.session, { operation: 'begin' }, consent)).toMatchObject({ commandAttempted: false })
    expect(h.sent.map(value => value[12])).toEqual([5])
  })
  it('retains the exact slot after cancellation until correlated reply and then returns uncertain without retry', async () => {
    const h = await owner(), cancel = new AbortController()
    const writing = h.device.applyRecordingRestore(h.session, { operation: 'begin' }, { ...consent, signal: cancel.signal })
    await vi.waitFor(() => expect(h.sent).toHaveLength(4))
    const last = h.sent[3], seq = new DataView(last.buffer).getUint32(4)
    cancel.abort(); const next = h.device.getFileCount()
    h.emit(frame(0xf119, seq + 1, bytes(row('begin-1').response_payloads_hex[0])))
    await new Promise(resolve => setTimeout(resolve, 20)); expect(h.sent).toHaveLength(4)
    h.emit(frame(0xf119, seq, bytes(row('begin-1').response_payloads_hex[0])))
    expect(await writing).toMatchObject({ status: 'uncertain', commandAttempted: true })
    expect(await next).toEqual({ count: 2 })
    expect(h.sent.filter(value => new DataView(value.buffer).getUint16(2) === 0xf119).map(value => value[12])).toEqual([5, 0])
  })
  it('copies token, provenance and append bytes before waiting for another queued operation', async () => {
    const body = bytes(row('append-1-0').request_frames_hex[0]).subarray(12), original = body.slice(29), data = original.slice()
    const h = await owner(request => {
      expect(request.subarray(12)).toEqual(body)
      return bytes(row('append-1-0').response_payloads_hex[0])
    }, { holdCount: true })
    const first = h.device.getFileCount(); await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    const writing = h.device.applyRecordingRestore(h.session, { operation: 'append', offset: 0, data }, consent)
    data.fill(0); h.session.ownerToken.fill(0); h.session.sourceSha256.fill(0)
    const seq = new DataView(h.sent[0].buffer).getUint32(4)
    h.emit(frame(6, seq, Uint8Array.of(0, 0, 0, 2))); expect(await first).toEqual({ count: 2 })
    expect(await writing).toMatchObject({ status: 'reply', reply: { metadata: { uploadedBytes: 1024 } } })
  })
})
