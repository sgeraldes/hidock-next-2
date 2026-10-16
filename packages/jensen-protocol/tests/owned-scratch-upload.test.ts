import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, ownedScratchCrc32, ownedScratchFilename, encodeOwnedScratchUpload, parseOwnedScratchUploadReply,
  isOwnedScratchStatusBody, encodeCustomRecordingProfile, type OwnedScratchUploadOperation, type OwnedScratchWriteOptions } from '../src/index.js'

const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/f118-native-replies-snapshot.json', import.meta.url)), 'utf8'))
const acceptedNative = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/generation-upload2/upload-execution.json', import.meta.url)), 'utf8'))
const row = (id: string) => native.cases.find((value: { id: string }) => value.id === id)
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
const descriptor = { uploadId: 1, ownerToken: 123, totalBytes: 8200, wholeCrc32: 0x496bd268 }
const consent: OwnedScratchWriteOptions = { ownedScratchWriteConsent: true, normalJensen: true, massStorageInactive: true, audioQuiescent: true }
const profile = Uint8Array.of(0, ...encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }))
const id = (data: Uint8Array) => new DataView(data.buffer).getUint16(2)
const sequence = (data: Uint8Array) => new DataView(data.buffer).getUint32(4)
function packet(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const value = new Uint8Array(12 + body.length), view = new DataView(value.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); value.set(body, 12); return value
}
describe('bounded owned scratch wire contract and actual native replies', () => {
  it('implements IEEE CRC32 and only fixed new scratch names', () => {
    expect(ownedScratchCrc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(ownedScratchCrc32(new Uint8Array())).toBe(0)
    expect(ownedScratchFilename(1)).toBe('REA00000001.hda'); expect(ownedScratchFilename(0xffffffff)).toBe('REAFFFFFFFF.hda')
    expect(() => ownedScratchFilename(0)).toThrow()
  })
  it('matches native begin and whole1024/final8 append bytes, without silently shortening nonfinal chunks', () => {
    expect(encodeOwnedScratchUpload(descriptor, { operation: 'begin' })).toEqual(bytes(row('begin-1').request_frames_hex[0]).subarray(12))
    for (const name of ['append-1-0', 'append-1-8192']) {
      const nativeBody = bytes(row(name).request_frames_hex[0]).subarray(12), offset = new DataView(nativeBody.buffer, nativeBody.byteOffset).getUint32(9)
      expect(encodeOwnedScratchUpload(descriptor, { operation: 'append', offset, data: nativeBody.subarray(17) })).toEqual(nativeBody)
    }
    expect(() => encodeOwnedScratchUpload(descriptor, { operation: 'append', offset: 0, data: new Uint8Array(483) })).toThrow()
  })
  it.each([0, -1, NaN, 0x800000])('rejects invalid total%s before encoding', totalBytes => {
    expect(() => encodeOwnedScratchUpload({ ...descriptor, totalBytes }, { operation: 'begin' })).toThrow()
  })
  it.each([0, -1, 0x100000000, 1.5, NaN])('rejects invalid owner token%s', ownerToken => {
    expect(() => encodeOwnedScratchUpload({ ...descriptor, ownerToken }, { operation: 'begin' })).toThrow()
  })
  it('accepts only exact9-byte op4 read requests with nonzero identity/token', () => {
    const status = encodeOwnedScratchUpload(descriptor, { operation: 'status' })
    expect(isOwnedScratchStatusBody(status)).toBe(true)
    for (const op of [0, 1, 2, 3, 5]) { const bad = status.slice(); bad[0] = op; expect(isOwnedScratchStatusBody(bad)).toBe(false) }
    expect(isOwnedScratchStatusBody(status.subarray(0, 8))).toBe(false); expect(isOwnedScratchStatusBody(Uint8Array.of(...status, 0))).toBe(false)
    const noToken = status.slice(); noToken.fill(0, 5); expect(isOwnedScratchStatusBody(noToken)).toBe(false)
  })
  it.each(['verify-first4096', 'verify-second4096', 'commit-final8', 'idempotent-commit'])('interprets native%s commit phase and exact completion', name => {
    const parsed = parseOwnedScratchUploadReply(descriptor, { operation: 'commit' }, bytes(row(name).response_payloads_hex[0]))
    expect(parsed?.finished).toBe(name === 'commit-final8' || name === 'idempotent-commit')
    expect(parsed?.acknowledgement).toBe('accepted'); expect(parsed?.progressKind).toBe('readback')
  })
  it('never promotes native ACK1state4 or ready to finished and rejects dishonest reply geometry/progress', () => {
    expect(parseOwnedScratchUploadReply(descriptor, { operation: 'abort' }, bytes(row('final-abort-forbidden').response_payloads_hex[0]))).toMatchObject({ acknowledgement: 'rejected', stateCode: 4, finished: false })
    expect(parseOwnedScratchUploadReply(descriptor, { operation: 'commit' }, Uint8Array.of(1, 4, 0, 0, 32, 8))).toMatchObject({ acknowledgement: 'rejected', stateCode: 4, progressBytes: 8200, finished: false })
    expect(parseOwnedScratchUploadReply(descriptor, { operation: 'commit' }, Uint8Array.of(0, 3, 0, 0, 32, 8))?.finished).toBe(false)
    for (const bad of [new Uint8Array(5), new Uint8Array(7), Uint8Array.of(2, 1, 0, 0, 0, 0), Uint8Array.of(0, 6, 0, 0, 0, 0), Uint8Array.of(0, 4, 0, 0, 32, 7), Uint8Array.of(0, 4, 0, 0, 32, 9)]) expect(parseOwnedScratchUploadReply(descriptor, { operation: 'commit' }, bad)).toBeNull()
  })
  it('binds strict readonly open/race proof while preserving the known pre-aggregation fragment rejection', () => {
    expect(native.readonlyProof).toMatchObject({ lowerOpenModes: [1], missingRacedJournalNotRecreated: true })
    expect(row('fragmented-nonstream').response_frames_hex).toEqual([])
  })
  it('matches accepted-system fragmented begin/commit serialization without replacing the earlier rejection evidence', () => {
    expect(acceptedNative.system_sha256).toBe('ed69f17b23e35070f81452da177de915b1b0ac8af92f202f0f6862d6fa393b54')
    const begin = acceptedNative.cases.find((value: { id: string }) => value.id === 'fragmented-begin')
    const commit = acceptedNative.cases.find((value: { id: string }) => value.id === 'fragmented-commit')
    for (const value of [begin, commit]) expect(value.status).toBe('passed_actual_parser_handler_response')
    const request = Buffer.concat(begin.request_frames_hex.map((hex: string) => Buffer.from(hex, 'hex')))
    const view = new DataView(request.buffer, request.byteOffset + 12, 17)
    const actualDescriptor = { uploadId: view.getUint32(1), ownerToken: view.getUint32(5), totalBytes: view.getUint32(9), wholeCrc32: view.getUint32(13) }
    expect(encodeOwnedScratchUpload(actualDescriptor, { operation: 'begin' })).toEqual(new Uint8Array(request.subarray(12)))
    expect(parseOwnedScratchUploadReply(actualDescriptor, { operation: 'begin' }, bytes(begin.response_payloads_hex[0]))).toMatchObject({ stateCode: 1, progressBytes: 0, finished: false })
    expect(parseOwnedScratchUploadReply(actualDescriptor, { operation: 'commit' }, bytes(commit.response_payloads_hex[0]))).toMatchObject({ stateCode: 4, progressBytes: 1024, finished: true, persistence: 'unverified', imageAttested: false })
    for (const value of [begin, commit]) expect(new DataView(bytes(value.response_frames_hex[0]).buffer).getUint32(4)).toBe(7)
  })
})

const devices: JensenDevice[] = []
async function owner(onUpload?: (request: Uint8Array, emit: (bytes: Uint8Array) => void) => void, nativeRecording = new Uint8Array()) {
  vi.useFakeTimers()
  const sent: Uint8Array[] = [], pending: Uint8Array[] = []
  const endpoint = Object.assign(new EventEmitter(), { startPoll() { for (const value of pending.splice(0)) this.emit('data', value) }, stopPoll(done?: () => void) { done?.() } })
  const emit = (value: Uint8Array) => { if (endpoint.listenerCount('data')) endpoint.emit('data', value); else pending.push(value) }
  const handle = { vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: true, async open() {}, async close() {}, async reset() { throw Error('Unexpected reset') }, async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {},
    async transferOut(_endpoint: number, data: Uint8Array) {
      const request = data.slice(); sent.push(request)
      if (id(request) === 0xf118) onUpload?.(request, emit)
      else emit(packet(id(request), sequence(request), id(request) === 0xf111 ? profile : id(request) === 6 ? Uint8Array.of(0, 0, 0, 2) : id(request) === 29 ? nativeRecording : new Uint8Array()))
      return { status: 'ok', bytesWritten: request.length }
    }, device: { interface: () => ({ endpoint: () => endpoint }) } }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  devices.push(device); const connecting = device.tryConnect(handle as unknown as USBDevice); await vi.advanceTimersByTimeAsync(350); expect(await connecting).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393986; device.versionCode = '6.3.2'; device.serialNumber = 'SYNTHETIC0001'
  const session = device.createOwnedScratchUploadSession(descriptor.uploadId, descriptor.ownerToken, descriptor.totalBytes, descriptor.wholeCrc32)!
  expect(session).not.toBeNull(); expect(sent).toEqual([])
  return { device, session, sent, emit }
}
afterEach(async () => { vi.useRealTimers(); for (const device of devices.splice(0)) await device.disconnect() })

describe('public owned scratch helper ownership and per-request settlement', () => {
  it('binds a new future393988 session and preserves the same fresh capability/idle/strict f118 ABI', async () => {
    const h = await owner((request, emit) => emit(packet(0xf118, sequence(request), bytes(row('begin-1').response_payloads_hex[0]))))
    h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    const session = h.device.createOwnedScratchUploadSession(descriptor.uploadId, descriptor.ownerToken, descriptor.totalBytes, descriptor.wholeCrc32)!
    expect(session).toMatchObject({ versionNumber: 393988, connectionSessionId: h.device.getConnectionSessionId() })
    expect(h.sent).toEqual([])
    const writing = h.device.applyOwnedScratchUpload(session, { operation: 'begin' }, consent); await vi.advanceTimersByTimeAsync(60)
    expect(await writing).toMatchObject({ status: 'reply', commandAttempted: true, reply: { stateCode: 1, progressBytes: 0, imageAttested: false } })
    expect(h.sent.map(id)).toEqual([0xf111, 29, 18, 0xf118])
    const reading = h.device.getOwnedScratchUploadStatus(session); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ operation: 'status', stateCode: 1 })
    expect(h.sent.slice(4).map(id)).toEqual([0xf111, 0xf118])
  })
  it('does not silently migrate an existing393986 session onto supported393988 firmware', async () => {
    const h = await owner(); h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'
    expect(await h.device.getOwnedScratchUploadStatus(h.session)).toBeNull()
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent)).toMatchObject({ status: 'rejected-before-dispatch', reason: 'session-unqualified', commandAttempted: false })
    expect(h.sent).toEqual([])
  })
  it.each([[393988, '6.3.2'], [393986, '6.3.4'], [393989, '6.3.5']] as const)('rejects incoherent or unknown%s/%s before capability probing', async (version, code) => {
    const h = await owner(); h.device.versionNumber = version; h.device.versionCode = code
    expect(h.device.createOwnedScratchUploadSession(descriptor.uploadId, descriptor.ownerToken, descriptor.totalBytes, descriptor.wholeCrc32)).toBeNull()
    expect(await h.device.getOwnedScratchUploadStatus(h.session)).toBeNull(); expect(h.sent).toEqual([])
  })
  it('rechecks bound firmware version after fresh capability before any scratch mutation', async () => {
    const h = await owner(), writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent)
    await vi.advanceTimersByTimeAsync(1); h.device.versionNumber = 393988; h.device.versionCode = '6.3.4'; await vi.advanceTimersByTimeAsync(30)
    expect(await writing).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false }); expect(h.sent.map(id)).toEqual([0xf111])
  })
  it('consumes an actual unchanged native begin ACK at its exact seq7 after fresh capability/idle reads', async () => {
    const h = await owner((request, emit) => { expect(sequence(request)).toBe(7); emit(bytes(row('begin-1').response_frames_hex[0])) })
    for (let i = 0; i < 4; i++) { const reading = h.device.getFileCount(); await vi.advanceTimersByTimeAsync(20); expect(await reading).toEqual({ count: 2 }) }
    const writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent); await vi.advanceTimersByTimeAsync(60)
    expect(await writing).toMatchObject({ status: 'reply', commandAttempted: true, reply: { acknowledgement: 'accepted', stateCode: 1, progressBytes: 0, finished: false } })
    expect(h.sent.slice(4).map(id)).toEqual([0xf111, 29, 18, 0xf118]); expect(h.sent.at(-1)).toEqual(bytes(row('begin-1').request_frames_hex[0]))
  })
  it.each(['begin', 'commit', 'abort'] as const)('blocks%s before any IO without explicit consent or under validation/recovery policy', async operation => {
    const h = await owner()
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation }, {} as OwnedScratchWriteOptions)).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false })
    h.device.deviceValidationReadOnly = true
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation }, consent)).toMatchObject({ status: 'rejected-before-dispatch', reason: 'read-only-or-update-policy' })
    h.device.deviceValidationReadOnly = false; h.device.firmwareRecoveryReadOnly = true
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation }, consent)).toMatchObject({ status: 'rejected-before-dispatch' }); expect(h.sent).toEqual([])
  })
  it('allows source-qualified op4 status through both readonly flags while no mutation is authorized', async () => {
    const h = await owner((request, emit) => emit(packet(0xf118, sequence(request), bytes(row('finished-status').response_payloads_hex[0]))))
    h.device.deviceValidationReadOnly = true; h.device.firmwareRecoveryReadOnly = true
    const reading = h.device.getOwnedScratchUploadStatus(h.session); await vi.advanceTimersByTimeAsync(30)
    expect(await reading).toMatchObject({ operation: 'status', stateCode: 4, finished: true, persistence: 'unverified' })
    expect(h.sent.map(id)).toEqual([0xf111, 0xf118]); expect(isOwnedScratchStatusBody(h.sent.at(-1)!.subarray(12))).toBe(true)
  })
  it('blocks append and a cast status operation before any IO under the mutation API', async () => {
    const h = await owner(); h.device.deviceValidationReadOnly = true
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation: 'append', offset: 0, data: new Uint8Array(1024) }, consent)).toMatchObject({ status: 'rejected-before-dispatch' })
    h.device.deviceValidationReadOnly = false
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation: 'status' } as unknown as OwnedScratchUploadOperation, consent)).toMatchObject({ status: 'rejected-before-dispatch', reason: 'invalid-operation' })
    expect(h.sent).toEqual([])
  })
  it('rechecks a policy change after capability dispatch and never emits a mutation', async () => {
    const h = await owner(), writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent)
    await vi.advanceTimersByTimeAsync(1); h.device.deviceValidationReadOnly = true
    await vi.advanceTimersByTimeAsync(20)
    expect(await writing).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false }); expect(h.sent.map(id)).toEqual([0xf111])
  })
  it('rejects cached identity invalidation during preflight without any f118 mutation', async () => {
    const h = await owner()
    // Change cached identity during preflight to simulate an invalidated owner;
    // the exclusive command slot must still never progress to mutation.
    const writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent); await vi.advanceTimersByTimeAsync(1)
    h.device.serialNumber = 'DIFFERENT0001'; await vi.advanceTimersByTimeAsync(20)
    expect(await writing).toMatchObject({ status: 'rejected-before-dispatch' }); expect(h.sent.map(id)).toEqual([0xf111])
  })
  it('fails closed for active native recording without emitting corroboration or mutation', async () => {
    const h = await owner(undefined, Uint8Array.of(0, 1, 65, 0, 0, 0))
    const writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent); await vi.advanceTimersByTimeAsync(40)
    expect(await writing).toMatchObject({ status: 'rejected-before-dispatch', reason: 'native-idle-unavailable' }); expect(h.sent.map(id)).toEqual([0xf111, 29])
  })
  it('never retries a missing mutation ACK and returns uncertainty rather than no-write success', async () => {
    const h = await owner(), writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, { ...consent, timeout: 1 })
    await vi.advanceTimersByTimeAsync(1100)
    expect(await writing).toMatchObject({ status: 'uncertain', commandAttempted: true }); expect(h.sent.map(id)).toEqual([0xf111, 29, 18, 0xf118])
  })
  it('rejects stale sessions after disconnect and refuses stock/restore versions with zero IO', async () => {
    const h = await owner(); await h.device.disconnect()
    expect(await h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, consent)).toMatchObject({ status: 'rejected-before-dispatch' })
    expect(await h.device.getOwnedScratchUploadStatus(h.session)).toBeNull(); expect(h.sent).toEqual([])
    for (const [number, code] of [[393984, '6.3.0'], [393985, '6.3.1'], [393987, '6.3.3']] as const) {
      h.device.versionNumber = number; h.device.versionCode = code
      expect(h.device.createOwnedScratchUploadSession(1, 123, 8200, descriptor.wholeCrc32)).toBeNull()
    }
  })
  it('keeps caller byte mutation outside the already encoded append request', async () => {
    const data = bytes(row('append-1-0').request_frames_hex[0]).subarray(29)
    const h = await owner((request, emit) => emit(packet(0xf118, sequence(request), bytes(row('append-1-0').response_payloads_hex[0]))))
    const writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'append', offset: 0, data }, consent); data.fill(99)
    await vi.advanceTimersByTimeAsync(60); expect(await writing).toMatchObject({ status: 'reply' })
    expect(h.sent.at(-1)!.subarray(12)).toEqual(bytes(row('append-1-0').request_frames_hex[0]).subarray(12))
  })
  it('cancel after mutation OUT waits for the exact reply and reports uncertainty without advancing another slot', async () => {
    const h = await owner(), abort = new AbortController()
    const writing = h.device.applyOwnedScratchUpload(h.session, { operation: 'begin' }, { ...consent, signal: abort.signal }); await vi.advanceTimersByTimeAsync(40)
    expect(h.sent.map(id)).toEqual([0xf111, 29, 18, 0xf118]); abort.abort()
    const queued = h.device.getFileCount(); await vi.advanceTimersByTimeAsync(10); expect(h.sent).toHaveLength(4)
    h.emit(packet(0xf118, 3, bytes(row('begin-1').response_payloads_hex[0]))); await vi.advanceTimersByTimeAsync(30)
    expect(await writing).toMatchObject({ status: 'uncertain', commandAttempted: true }); expect(await queued).toEqual({ count: 2 })
    expect(h.sent.map(id)).toEqual([0xf111, 29, 18, 0xf118, 6])
  })
})
