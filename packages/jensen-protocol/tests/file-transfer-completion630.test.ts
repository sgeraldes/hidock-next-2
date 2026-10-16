// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CMD, JensenDevice } from '../src/index.js'
const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/command-contract630-lab/native/wire-fixtures-next.json', import.meta.url)), 'utf8'))
const retained = (id: string): Uint8Array => Uint8Array.from(Buffer.from(native.cases.find((row: { id: string }) => row.id === id).response_frames_hex[0], 'hex'))
const nativeRanges = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/native-range/wire-fixtures.json', import.meta.url)), 'utf8'))
const nativeFullFiles = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/native-full-file/wire-fixtures.json', import.meta.url)), 'utf8'))
function packet(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12); return bytes
}
type Internals = { device: USBDevice; sequenceId: number; readLoopRunning: boolean; receiveChunks: DataView[]; currentCommandTag: string | null; processBufferedData(): void; transferStallTimeoutMs: number }
const devices: JensenDevice[] = []
function setup(response?: (bytes: Uint8Array, feed: (bytes: Uint8Array, split?: number) => void) => void) {
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  const internal = device as unknown as Internals
  const out: Uint8Array[] = []
  const feed = (bytes: Uint8Array, split = bytes.length) => {
    for (let offset = 0; offset < bytes.length; offset += split) { const part = bytes.subarray(offset, offset + split); internal.receiveChunks.push(new DataView(part.buffer, part.byteOffset, part.byteLength)) }
    internal.processBufferedData()
  }
  internal.device = { opened: true, transferOut: vi.fn(async (_ep: number, request: Uint8Array) => { const bytes = Uint8Array.from(request); out.push(bytes); response?.(bytes, feed); return { status: 'ok', bytesWritten: bytes.length } }), transferIn: vi.fn(() => new Promise(() => {})), reset: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as USBDevice
  internal.sequenceId = 7; internal.readLoopRunning = true
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'
  devices.push(device)
  return { device, internal, out, feed }
}
afterEach(async () => { for (const device of devices.splice(0)) { (device as unknown as Internals).readLoopRunning = false; await device.disconnect() } vi.useRealTimers() })
const id = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(2)
const sequence = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4)
function entry(name: string): Uint8Array {
  const bytes = new Uint8Array(57); bytes[0] = 1; bytes[3] = 27
  bytes.set(new TextEncoder().encode(name), 4); new DataView(bytes.buffer).setUint32(31, 1234); return bytes
}
describe('truthful listing completion at the actual SDK queue', () => {
  it.each([28, 32])('rejects H1E delete filename length%s before OUT or quarantine', async length => {
    const state = setup()
    expect(await state.device.deleteFile('a'.repeat(length - 4) + '.hda')).toBeNull()
    expect(state.out).toEqual([]); expect(state.device.isPoisoned()).toBe(false)
  })
  it.each([['hidock-h1e', 27], ['hidock-p1', 32]] as const)('preserves the exact%s filename boundary%s', async (model, length) => {
    const state = setup((bytes, feed) => feed(packet(7, sequence(bytes), Uint8Array.of(0))))
    state.device.model = model
    expect(await state.device.deleteFile('a'.repeat(length - 4) + '.hda')).toEqual({ result: 'success' })
    expect(state.out).toHaveLength(1); expect(state.out[0].length).toBe(12 + length)
  })
  it.each([[0x7fffffff, 1], [0x80000000, 1], [0xffffffff - 3, 4]])('rejects native signed range overflow%s+%s before OUT', async (offset, count) => {
    const state = setup()
    expect(await state.device.readFileRange('LAB630.hda', 0xffffffff, offset, count, vi.fn())).toMatchObject({ reason: 'invalid-range', received: 0 })
    expect(state.out).toEqual([]); expect(state.device.isPoisoned()).toBe(false)
  })
  it('preserves a range ending at the exact native signed boundary', async () => {
    const state = setup((bytes, feed) => feed(packet(21, sequence(bytes), Uint8Array.of(19))))
    const bytes: number[] = []
    expect(await state.device.readFileRange('LAB630.hda', 0x7fffffff, 0x7ffffffe, 1, chunk => bytes.push(...chunk))).toMatchObject({ status: 'complete', received: 1 })
    expect(bytes).toEqual([19]); expect(state.out.map(id)).toEqual([21])
    expect(new DataView(state.out[0].buffer).getUint32(12)).toBe(0x7ffffffe)
  })
  it('rejects a page whose record offsets exceed signed native arithmetic', async () => {
    const state = setup(), maximum = Math.floor(0x7fffffff / 57)
    expect(await state.device.listFilesPage(maximum, 1)).toMatchObject({ reason: 'invalid-page' })
    expect(state.out).toEqual([]); expect(state.device.isPoisoned()).toBe(false)
  })
  it('preserves the page at the exact native record offset limit', async () => {
    const state = setup((bytes, feed) => feed(packet(26, sequence(bytes), new Uint8Array(4)))), maximum = Math.floor(0x7fffffff / 57)
    expect(await state.device.listFilesPage(maximum - 1, 1)).toMatchObject({ status: 'complete', totalCount: 0, parsedCount: 0 })
    expect(state.out.map(id)).toEqual([26]); expect(new DataView(state.out[0].buffer).getUint32(12)).toBe(maximum - 1)
  })
  it.each([393986, 393987, 393988, 393989])('preserves bounded original prefix and offset data on accepted firmware%s', async version => {
    for (const command of [13, 21]) {
      const row = command === 13 ? nativeFullFiles.cases.find((item: { id: string }) => item.id === 'prefix-52')
        : nativeRanges.cases.find((item: { id: string }) => item.id === 'range-4-4')
      const state = setup((_bytes, feed) => { for (const hex of row.response_frames_hex) feed(Uint8Array.from(Buffer.from(hex, 'hex')), 11) })
      state.device.versionNumber = version; state.device.versionCode = `6.3.${version - 393984}`
      const chunks: Uint8Array[] = []
      const result = command === 13 ? await state.device.readFilePrefix('LAB630.hda', 52, 52, bytes => chunks.push(bytes))
        : await state.device.readFileRange('LAB630.hda', 32, 4, 4, bytes => chunks.push(bytes))
      expect(result).toMatchObject({ status: 'complete', received: command === 13 ? 52 : 4 })
      const actual = Buffer.concat(chunks.map(value => Buffer.from(value)))
      expect(actual).toEqual(Buffer.from(Array.from({ length: command === 13 ? 52 : 4 }, (_, i) => command === 13 ? i % 251 : i + 4)))
      expect(state.out.map(id)).toEqual([command])
    }
  })
  it.each([393986, 393987, 393988, 393989])('preserves original entry geometry for accepted firmware%s', async version => {
    const row = nativeRanges.cases.find((item: { id: string }) => item.id === 'page-1-128')
    const state = setup((_bytes, feed) => feed(Uint8Array.from(Buffer.from(row.response_frames_hex[0], 'hex')), 17))
    state.device.versionNumber = version; state.device.versionCode = `6.3.${version - 393984}`
    expect(await state.device.listFilesPage(1, 128)).toMatchObject({ status: 'complete', totalCount: 2, parsedCount: 1, expectedCount: 1 })
    expect(state.out.map(id)).toEqual([26])
  })
  it.each([[393986, '6.3.1'], [393987, '6.3.2'], [393988, '6.3.2'], [393989, '6.3.4'], [393990, '6.3.6']])('refuses incoherent/unknown segment/page identity%s/%s without OUT', async (version, code) => {
    const state = setup(); state.device.versionNumber = version as number; state.device.versionCode = code as string
    expect(await state.device.listFilesPage(0, 128)).toMatchObject({ reason: 'page-capability-unqualified' })
    expect(await state.device.readFileRange('LAB630.hda', 32, 4, 4, vi.fn())).toMatchObject({ reason: 'range-capability-unqualified' })
    expect(await state.device.readFilePrefix('LAB630.hda', 32, 4, vi.fn())).toMatchObject({ reason: 'range-capability-unqualified' })
    expect(state.out).toEqual([])
  })
  it.each(['page-0-2', 'page-1-1', 'page-1-128'])('reads actual original%s as entry units and reports the clamped page count', async name => {
    const row = nativeRanges.cases.find((item: { id: string }) => item.id === name)
    expect(row.status).toBe('passed_actual_original_entry_page_accounting')
    const state = setup((_bytes, feed) => feed(Uint8Array.from(Buffer.from(row.response_frames_hex[0], 'hex')), 5))
    const result = await state.device.listFilesPage(row.independent_first_index, row.independent_requested_entries)
    expect(result).toMatchObject({ status: 'complete', totalCount: 2, firstIndex: row.independent_first_index, requestedCount: row.independent_requested_entries, parsedCount: row.independently_verified_entries, expectedCount: row.independently_verified_entries })
    if (row.independent_first_index === 1) expect(result.files.map(file => file.name)).toEqual(['20261012151617REC002.wav'])
    expect(id(state.out[0])).toBe(26)
  })
  it('settles actual native zero-total listing immediately without the watchdog', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmd4-base'), 1))
    expect(await state.device.listFilesDetailed()).toEqual({ status: 'complete', files: [], expectedCount: 0, parsedCount: 0, reason: null })
    expect(state.out.map(id)).toEqual([4]); expect(state.device.isPoisoned()).toBe(false)
  })
  it('parses actual native nonempty listing across arbitrary transport boundaries', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmd4-listing-two'), 3))
    const result = await state.device.listFilesDetailed(undefined, 1)
    expect(result).toMatchObject({ status: 'complete', expectedCount: 2, parsedCount: 2 })
    expect(result.files.map(file => file.length)).toEqual([4096, 8192])
  })
  it('preserves valid non-date filenames instead of fabricating an empty directory', async () => {
    const body = new Uint8Array(63); body.set([255, 255, 0, 0, 0, 1]); body.set(entry('LAB630.hda'), 6)
    const state = setup((_bytes, feed) => feed(packet(4, 7, body)))
    const result = await state.device.listFilesDetailed()
    expect(result.status).toBe('complete'); expect(result.parsedCount).toBe(1)
    expect(result.files[0]).toMatchObject({ name: 'LAB630.hda', time: null })
  })
  it('counts invalid raw entries but never labels dropped records complete', async () => {
    const body = new Uint8Array(63); body.set([255, 255, 0, 0, 0, 1]); body.set(entry('../BAD.hda'), 6)
    const state = setup((_bytes, feed) => feed(packet(4, 7, body)))
    expect(await state.device.listFilesDetailed()).toMatchObject({ status: 'partial', parsedCount: 1, files: [], reason: 'invalid-file-name' })
  })
  it('keeps legacy partial/error unavailable for reconciliation', async () => {
    const body = new Uint8Array(63); body.set([255, 255, 0, 0, 0, 2]); body.set(entry('LAB630.hda'), 6)
    const state = setup((_bytes, feed) => { feed(packet(4, 7, body)); feed(packet(4, 7, new Uint8Array())) })
    expect(await state.device.listFiles()).toBeNull()
  })
  it('reports partial count and reason when a qualified stream ends before its count', async () => {
    const body = new Uint8Array(63); body.set([255, 255, 0, 0, 0, 2]); body.set(entry('LAB630.hda'), 6)
    const state = setup((_bytes, feed) => { feed(packet(4, 7, body)); feed(packet(4, 7, new Uint8Array())) })
    expect(await state.device.listFilesDetailed()).toMatchObject({ status: 'partial', expectedCount: 2, parsedCount: 1, reason: 'listing-ended-before-count' })
  })
})
describe('exact full-file boundaries and safe abnormal settlement', () => {
  it.each([0, 52, 8180, 8181, 16360, 16361])('preserves all actual original full-file bytes and native EOF for size%s', async size => {
    const row = nativeFullFiles.cases.find((item: { id: string }) => item.id === `full-${size}`)
    const state = setup((_bytes, feed) => { for (const hex of row.response_frames_hex) feed(Uint8Array.from(Buffer.from(hex, 'hex')), 31) }), chunks: Uint8Array[] = []
    expect(await state.device.downloadFile('LAB630.hda', size, bytes => chunks.push(bytes))).toBe(true)
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from(Array.from({ length: size }, (_, i) => i % 251)))
  })
  it.each([393984, 393985, 393986, 393987, 393988, 393989])('holds an aligned full-file slot until the actual empty EOF (version=%s)', async version => {
    const row = nativeFullFiles.cases.find((item: { id: string }) => item.id === 'full-8180')
    const state = setup((bytes, feed) => { if (id(bytes) === 5) feed(Uint8Array.from(Buffer.from(row.response_frames_hex[0], 'hex'))); else feed(packet(6, sequence(bytes), Uint8Array.of(0, 0, 0, 2))) })
    state.device.versionNumber = version; state.device.versionCode = `6.3.${version - 393984}`
    const reading = state.device.downloadFile('LAB630.hda', 8180, vi.fn())
    await vi.waitFor(() => expect(state.out.map(id)).toEqual([5]))
    const queued = state.device.getFileCount()
    await new Promise(resolve => setTimeout(resolve, 10)); expect(state.out.map(id)).toEqual([5])
    state.feed(Uint8Array.from(Buffer.from(row.response_frames_hex[1], 'hex')))
    expect(await reading).toBe(true); expect(await queued).toEqual({ count: 2 }); expect(state.out.map(id)).toEqual([5, 6])
  })
  it.each([393984, 393985, 393986, 393987, 393988, 393989])('cancelled aligned full-file drain also waits for native empty EOF (version=%s)', async version => {
    vi.useFakeTimers()
    const row = nativeFullFiles.cases.find((item: { id: string }) => item.id === 'full-8180')
    const state = setup((bytes, feed) => { if (id(bytes) === 5) feed(Uint8Array.from(Buffer.from(row.response_frames_hex[0], 'hex'))); else feed(packet(6, sequence(bytes), Uint8Array.of(0, 0, 0, 2))) })
    state.device.versionNumber = version; state.device.versionCode = `6.3.${version - 393984}`
    const abort = new AbortController(), reading = state.device.downloadFile('LAB630.hda', 8180, vi.fn(), undefined, abort.signal)
    await vi.advanceTimersByTimeAsync(1); abort.abort()
    expect(await reading).toBe(false)
    const queued = state.device.getFileCount()
    await vi.advanceTimersByTimeAsync(100); expect(state.out.map(id)).toEqual([5])
    state.feed(Uint8Array.from(Buffer.from(row.response_frames_hex[1], 'hex')))
    await vi.advanceTimersByTimeAsync(100); expect(await queued).toEqual({ count: 2 }); expect(state.out.map(id)).toEqual([5, 6])
  })
  it('forwards native bytes exactly and reports payload progress without headers', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmd5-base'), 1)), chunks: Uint8Array[] = [], progress = vi.fn(), started = vi.fn()
    expect(await state.device.downloadFile('LAB630.hda', 32, bytes => chunks.push(bytes), progress, undefined, started)).toBe(true)
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes))).toString('hex')).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    expect(progress.mock.calls).toEqual([[32]]); expect(started).toHaveBeenCalledOnce()
  })
  it.each(['overshoot', 'consumer', 'malformed', 'short'])('holds queue through quarantine on%s instead of forwarding/advancing', async kind => {
    vi.useFakeTimers()
    const state = setup((bytes, feed) => {
      if (id(bytes) === 5) {
        if (kind === 'malformed') { const invalid = packet(5, sequence(bytes), Uint8Array.of(1)); invalid[0] = 0; feed(invalid) }
        else if (kind === 'short') { feed(packet(5, sequence(bytes), Uint8Array.of(1, 2))); feed(packet(5, sequence(bytes), new Uint8Array())) }
        else feed(retained('cmd5-base'))
      }
    })
    const onChunk = vi.fn(() => { if (kind === 'consumer') throw Error('disk consumer broke') })
    const download = state.device.downloadFile('LAB630.hda', kind === 'overshoot' ? 16 : 64, onChunk)
    const queued = state.device.getFileCount()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await download).toBe(false); expect(await queued).toBeNull()
    await state.device.getActiveDownloadSettlement()
    expect(state.out.map(id)).toEqual([5]); expect(state.device.isPoisoned()).toBe(true)
    if (kind === 'overshoot' || kind === 'malformed') expect(onChunk).not.toHaveBeenCalled()
  })
  it('owner callback exception sends no OUT and cannot report success', async () => {
    vi.useFakeTimers(); const state = setup()
    const pending = state.device.downloadFile('LAB630.hda', 32, vi.fn(), undefined, undefined, () => { throw Error('owner invalid') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(false); expect(state.out).toEqual([]); expect(state.device.isPoisoned()).toBe(true)
  })
})
describe('bounded CMD21 byte ranges', () => {
  it('CMD13 emits count+filename without inventing an offset and reads actual native prefix', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmdd-base'))), chunks: Uint8Array[] = []
    expect(await state.device.readFilePrefix('LAB630.hda', 32, 4, bytes => chunks.push(bytes))).toEqual({ status: 'complete', offset: 0, count: 4, received: 4, reason: null })
    expect(Buffer.from(state.out[0]).toString('hex')).toBe('1234000d000000070000000e000000044c41423633302e686461')
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from([0, 1, 2, 3]))
  })
  it.each(['range-65535-16384', 'range-65536-1048576', 'range-0-8180', 'range-0-52'])('consumes actual original%s packets with exact correlation, logical padding and bytes', async name => {
    const row = nativeRanges.cases.find((item: { id: string }) => item.id === name)
    expect(row.status).toBe('passed_actual_original_range_framing_and_accounting')
    const state = setup((_bytes, feed) => { for (const hex of row.response_frames_hex) feed(Uint8Array.from(Buffer.from(hex, 'hex')), 127) })
    const chunks: Uint8Array[] = [], offset = row.independent_expected_offset, count = row.independent_expected_count
    expect(await state.device.readFileRange('LAB630.hda', 2097152, offset, count, bytes => chunks.push(bytes))).toEqual({ status: 'complete', offset, count, received: count, reason: null })
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from(Array.from({ length: count }, (_, i) => (offset + i) % 251)))
  })
  it('emits the exact retained native offset4/count4 request and consumes its native reply', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmd15-base'), 2)), chunks: Uint8Array[] = []
    expect(await state.device.readFileRange('LAB630.hda', 32, 4, 4, bytes => chunks.push(bytes))).toEqual({ status: 'complete', offset: 4, count: 4, received: 4, reason: null })
    expect(Buffer.from(state.out[0]).toString('hex')).toBe('12340015000000070000001200000004000000044c41423633302e686461')
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes))).toString('hex')).toBe('04050607')
  })
  it('accumulates multiple correlated response frames and ignores wrong sequence', async () => {
    const state = setup((bytes, feed) => {
      const seq = sequence(bytes)
      feed(packet(21, seq + 1, Uint8Array.of(99, 99)))
      feed(packet(21, seq, Uint8Array.of(4, 5))); feed(packet(21, seq, Uint8Array.of(6, 7)))
    }), chunks: Uint8Array[] = [], progress = vi.fn()
    expect(await state.device.readFileRange('LAB630.hda', 32, 4, 4, bytes => chunks.push(bytes), progress)).toMatchObject({ status: 'complete', received: 4 })
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from([4, 5, 6, 7]))
    expect(progress.mock.calls).toEqual([[2], [4]])
  })
  it.each([[-1, 4], [0, 1048577], [31, 2], [33, 0], [0, NaN], [0, 0]])('rejects invalid range%s/%s without OUT', async (offset, count) => {
    const state = setup()
    expect(await state.device.readFileRange('LAB630.hda', 32, offset, count, vi.fn())).toMatchObject({ status: 'error' })
    expect(state.out).toEqual([])
  })
  it('returns known EOF without a device request or dispatch owner callback', async () => {
    const state = setup(), started = vi.fn()
    expect(await state.device.readFileRange('LAB630.hda', 32, 32, 0, vi.fn(), undefined, undefined, started)).toMatchObject({ status: 'complete', received: 0, reason: 'known-eof-no-request' })
    expect(state.out).toEqual([]); expect(started).not.toHaveBeenCalled()
  })
  it('activates only at the actual command slot and cancelled pending work sends no OUT', async () => {
    const state = setup(), started = vi.fn(), abort = new AbortController()
    const previous = state.device.getFileCount()
    await vi.waitFor(() => expect(state.out.map(id)).toEqual([6]))
    const pending = state.device.readFileRange('LAB630.hda', 32, 4, 4, vi.fn(), undefined, abort.signal, started)
    abort.abort()
    expect(started).not.toHaveBeenCalled(); expect(state.internal.currentCommandTag).toBe('cmd-6-7')
    state.feed(packet(6, 7, Uint8Array.of(0, 0, 0, 2)))
    expect(await previous).toEqual({ count: 2 })
    expect(await pending).toMatchObject({ status: 'cancelled', reason: 'cancelled-before-start' })
    expect(state.out.map(id)).toEqual([6]); expect(started).not.toHaveBeenCalled()
  })
  it('cancelled range holds its slot until all requested bytes are drained', async () => {
    vi.useFakeTimers()
    const state = setup((bytes, feed) => { if (id(bytes) === 21) feed(packet(21, sequence(bytes), Uint8Array.of(4, 5))); else if (id(bytes) === 6) feed(packet(6, sequence(bytes), Uint8Array.of(0, 0, 0, 2))) })
    const abort = new AbortController(), chunks = vi.fn()
    const reading = state.device.readFileRange('LAB630.hda', 32, 4, 4, chunks, undefined, abort.signal)
    await vi.advanceTimersByTimeAsync(1)
    abort.abort()
    expect(await reading).toMatchObject({ status: 'cancelled', received: 2, reason: 'cancelled' })
    const queued = state.device.getFileCount()
    await vi.advanceTimersByTimeAsync(20); expect(state.out.map(id)).toEqual([21])
    state.feed(packet(21, 7, Uint8Array.of(6, 7)))
    await vi.advanceTimersByTimeAsync(100)
    expect(await queued).toEqual({ count: 2 }); await state.device.getActiveDownloadSettlement()
    expect(chunks).toHaveBeenCalledOnce(); expect(state.out.map(id)).toEqual([21, 6])
  })
})
describe('explicit device validation read policy intersects recovery fences', () => {
  it('exposes a monotonic owner epoch across disconnect without a handle or identity', async () => {
    const state = setup(), before = state.device.getConnectionSessionId()
    state.internal.readLoopRunning = false
    await state.device.disconnect()
    expect(typeof before).toBe('number'); expect(state.device.getConnectionSessionId()).toBeGreaterThan(before)
  })
  it('invalidates checkpoints before automatic teardown and publishes a fresh epoch before reconnect callbacks', async () => {
    vi.useFakeTimers()
    const state = setup(), internals = state.device as unknown as {
      sessionGeneration: number; performTeardown(): Promise<void>; runQuarantineRecoveryAttempt(gen: number): Promise<void>;
      usb: { getDevices: () => Promise<USBDevice[]> }
    }
    const before = state.device.getConnectionSessionId(), recoveryGeneration = internals.sessionGeneration
    state.internal.readLoopRunning = false
    const tearingDown = internals.performTeardown()
    expect(state.device.getConnectionSessionId()).toBeGreaterThan(before)
    await tearingDown
    const detachedEpoch = state.device.getConnectionSessionId()
    const handle = { vendorId: 0x10d6, productId: 0xb00d, opened: false, open: vi.fn(async () => {}), close: vi.fn(async () => {}), selectConfiguration: vi.fn(async () => {}), claimInterface: vi.fn(async () => {}), selectAlternateInterface: vi.fn(async () => {}) } as unknown as USBDevice
    internals.usb.getDevices = async () => [handle]
    const observed: number[] = []
    state.device.onconnect = () => observed.push(state.device.getConnectionSessionId())
    const reconnecting = internals.runQuarantineRecoveryAttempt(recoveryGeneration)
    await vi.advanceTimersByTimeAsync(301); await reconnecting
    expect(observed).toHaveLength(1); expect(observed[0]).toBeGreaterThan(detachedEpoch)
    expect(internals.sessionGeneration).toBe(recoveryGeneration)
  })
  it('allows a native bounded range while blocking writes before enqueue', async () => {
    const state = setup((_bytes, feed) => feed(retained('cmd15-base'))); state.device.deviceValidationReadOnly = true
    expect(await state.device.setTime(new Date())).toBeNull(); expect(await state.device.formatCard()).toBeNull()
    expect(await state.device.addNativeMarker()).toBeNull()
    expect(await state.device.uploadFirmware(undefined as never, undefined as never)).toMatchObject({ status: 'rejected', reason: 'device-validation-read-only' })
    expect(await state.device.readFileRange('LAB630.hda', 32, 4, 4, vi.fn())).toMatchObject({ status: 'complete' })
    expect(state.out.map(id)).toEqual([21])
  })
  it('rechecks policy at dispatch after an older operation releases its lock', async () => {
    const state = setup()
    const first = state.device.getFileCount()
    await vi.waitFor(() => expect(state.out.map(id)).toEqual([6]))
    const write = state.device.setTime(new Date())
    state.device.deviceValidationReadOnly = true
    state.feed(packet(6, 7, Uint8Array.of(0, 0, 0, 2)))
    expect(await first).toEqual({ count: 2 }); expect(await write).toBeNull(); expect(state.out.map(id)).toEqual([6])
  })
  it('does not let validation mode bypass the stricter durable firmware recovery read policy', async () => {
    const state = setup(); state.device.deviceValidationReadOnly = true; state.device.firmwareRecoveryReadOnly = true
    expect(await state.device.readFileRange('LAB630.hda', 32, 4, 4, vi.fn())).toMatchObject({ status: 'error', reason: 'owner-unavailable' })
    expect(await state.device.getTime()).toBeNull(); expect(state.out).toEqual([])
  })
  it('blocks explicit and stalled fallback teardown reset while retaining bounded close', async () => {
    vi.useFakeTimers(); const state = setup(); state.device.deviceValidationReadOnly = true
    const handle = state.internal.device
    state.internal.readLoopRunning = false
    ;(state.device as unknown as { startReadLoop(): void }).startReadLoop()
    expect(handle.transferIn).toHaveBeenCalledOnce()
    expect(await state.device.reset()).toBe(false)
    const closing = state.device.disconnect()
    await vi.advanceTimersByTimeAsync(1000); await closing
    expect(handle.reset).not.toHaveBeenCalled(); expect(handle.close).toHaveBeenCalledOnce()
    expect(state.device.deviceValidationReadOnly).toBe(true)
  })
})
