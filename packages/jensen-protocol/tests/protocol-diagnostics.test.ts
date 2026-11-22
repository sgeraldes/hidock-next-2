import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JensenDevice, USB_PRODUCT_IDS } from '../src/index.js'

const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/native-full-file/wire-fixtures.json', import.meta.url)), 'utf8'))
const nativePages = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/native-range/wire-fixtures.json', import.meta.url)), 'utf8'))
function response(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12); return bytes
}
const opened: JensenDevice[] = []
async function connect(makeReply?: (command: number, sequence: number) => Uint8Array[], existing?: JensenDevice) {
  const replies: Uint8Array[] = []
  let waiting: ((reply: USBInTransferResult) => void) | null = null
  const transfer = (bytes: Uint8Array): USBInTransferResult => ({ status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) })
  const publish = (bytes: Uint8Array) => { if (waiting) { const resolve = waiting; waiting = null; resolve(transfer(bytes)) } else replies.push(bytes) }
  const handle = {
    vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: false,
    async open() { this.opened = true }, async close() { this.opened = false; const resolve = waiting; waiting = null; resolve?.(transfer(new Uint8Array())) },
    async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {},
    async reset() { throw Error('Unexpected reset') },
    async transferOut(_endpoint: number, request: Uint8Array) {
      const bytes = new Uint8Array(request), view = new DataView(bytes.buffer), command = view.getUint16(2), sequence = view.getUint32(4)
      for (const frame of makeReply?.(command, sequence) ?? [response(command, sequence, Uint8Array.of(0, 0, 0, 2))]) {
        for (let offset = 0; offset < frame.length; offset += 512) publish(frame.slice(offset, offset + 512))
      }
      return { status: 'ok' as const, bytesWritten: request.length }
    },
    async transferIn() { return replies.length ? transfer(replies.shift()!) : new Promise<USBInTransferResult>(resolve => { waiting = resolve }) }
  }
  const device = existing ?? new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  if (!existing) opened.push(device)
  expect(await device.tryConnect(handle as unknown as USBDevice)).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'; device.deviceValidationReadOnly = true
  return device
}
afterEach(async () => { for (const device of opened.splice(0)) await device.disconnect() })

describe('sanitized diagnostics through public owner operations and transport', () => {
  it('retains failed page counts across reconnect, ring rollover and a later successful page', async () => {
    const row = nativePages.cases.find((item: { id: string }) => item.id === 'page-0-2')
    expect(row.status).toBe('passed_actual_original_entry_page_accounting')
    const original = Uint8Array.from(Buffer.from(row.response_frames_hex[0], 'hex')).subarray(12)
    // Native body geometry/content retained; only its total is changed to model
    // a stale advertised directory count. This does not reproduce the physical defect.
    const stale = original.slice(); new DataView(stale.buffer).setUint32(0, 558)
    const device = await connect((command, sequence) => [response(command, sequence, stale)])
    expect(await device.listFilesPage(0, 128)).toMatchObject({ status: 'error', reason: 'page-count-mismatch', totalCount: 558, expectedCount: 128, parsedCount: 0 })
    const failed = device.getProtocolDiagnostics().lastPageFault
    expect(failed).toMatchObject({ commandId: 26, sequence: 0, versionNumber: 393984, firstIndex: 0, requestedCount: 128,
      reason: 'page-count-mismatch', declaredTotalCount: 558, expectedCount: 128, expectedBodyBytes: 7300,
      responseBodyBytes: 118, completeRecordSlots: 2, trailingRecordBytes: 0, parsedCount: 0, retainedCount: 0 })
    await device.disconnect()
    await connect((command, sequence) => [response(command, sequence, command === 26 ? original : Uint8Array.of(0, 0, 0, 2))], device)
    for (let i = 0; i < 70; i++) expect(await device.getFileCount()).toEqual({ count: 2 })
    expect(await device.listFilesPage(0, 128)).toMatchObject({ status: 'complete', totalCount: 2, parsedCount: 2 })
    const after = device.getProtocolDiagnostics()
    expect(after.lastPageFault).toEqual(failed); expect(after.connectionSessionId).toBeGreaterThan(failed!.connectionSessionId)
    expect(after.events).toHaveLength(64); expect(after.events.some(event => event.kind === 'fault')).toBe(false)
    expect(JSON.stringify(after)).not.toMatch(/REC002|REC001|\.wav|\.hda|serialNumber|filename|rawPayload/)
    after.lastPageFault!.declaredTotalCount = -1
    expect(device.getProtocolDiagnostics().lastPageFault?.declaredTotalCount).toBe(558)
  })
  it.each([3, 62])('records short page body %s bytes without interpreting absent records', async bodyBytes => {
    const body = new Uint8Array(bodyBytes)
    if (bodyBytes >= 4) new DataView(body.buffer).setUint32(0, 1)
    const device = await connect((command, sequence) => [response(command, sequence, body)])
    expect(await device.listFilesPage(0, 128)).toMatchObject({ status: 'error' })
    expect(device.getProtocolDiagnostics().lastPageFault).toMatchObject({ firstIndex: 0, requestedCount: 128, responseBodyBytes: bodyBytes,
      declaredTotalCount: bodyBytes < 4 ? null : 1, expectedCount: bodyBytes < 4 ? null : 1,
      completeRecordSlots: bodyBytes < 4 ? null : 1, trailingRecordBytes: bodyBytes < 4 ? null : 1,
      parsedCount: 0, retainedCount: 0, reason: bodyBytes < 4 ? 'page-unavailable' : 'page-count-mismatch' })
  })
  it('observes actual native aligned prefix framing, raw aggregate sizes and strict correlation', async () => {
    const row = native.cases.find((item: { id: string }) => item.id === 'prefix-8180')
    const device = await connect((command, sequence) => row.response_frames_hex.map((hex: string) => {
      const bytes = Uint8Array.from(Buffer.from(hex, 'hex')); new DataView(bytes.buffer).setUint32(4, sequence); expect(command).toBe(13); return bytes
    }))
    expect(await device.readFilePrefix('PRIVATE-Recording.hda', 8180, 8180, () => {})).toMatchObject({ status: 'complete', received: 8180 })
    const diagnostic = device.getProtocolDiagnostics()
    expect(diagnostic.currentCommand).toBeNull(); expect(diagnostic.poisoned).toBe(false)
    expect(diagnostic.events).toContainEqual(expect.objectContaining({ kind: 'frame', commandId: 13, logicalBytes: 8180, bodyBytes: 8180, wireBytes: 8192, paddingBytes: 0, correlated: true }))
    expect(diagnostic.events.filter(event => event.kind === 'in').map(event => event.bytes)).toEqual(Array(16).fill(512))
    expect(diagnostic.inboundBytes).toBe(8192)
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|Recording|rawPayload|serialNumber|filename/)
  })
  it('keeps the ring bounded and returns independent snapshot copies without any private access', async () => {
    const device = await connect()
    for (let i = 0; i < 70; i++) expect(await device.getFileCount()).toEqual({ count: 2 })
    const first = device.getProtocolDiagnostics()
    expect(first.events).toHaveLength(64); expect(first.events.at(-1)).toMatchObject({ kind: 'frame', commandId: 6, sequence: 69 })
    first.events.length = 0
    expect(device.getProtocolDiagnostics().events).toHaveLength(64)
    const second = device.getProtocolDiagnostics(); second.events[0].atMs = -1
    expect(device.getProtocolDiagnostics().events[0].atMs).toBeGreaterThan(0)
  })
  it('classifies malformed stream failure and retains it through disconnect, without arbitrary error text', async () => {
    const device = await connect((command, sequence) => { const bytes = response(command, sequence, Uint8Array.of(1, 2)); bytes[0] = 99; return [bytes] })
    expect(await device.readFilePrefix('PRIVATE-Recording.hda', 52, 52, () => {})).toMatchObject({ status: 'error', reason: 'malformed-response' })
    await device.getActiveDownloadSettlement()
    const before = device.getProtocolDiagnostics()
    expect(before.lastFault?.code).toBe('malformed-response'); expect(before.events.some(event => event.kind === 'fault')).toBe(true)
    await device.disconnect()
    const after = device.getProtocolDiagnostics()
    expect(after.lastFault).toEqual(before.lastFault); expect(after.connectionSessionId).toBeGreaterThan(before.connectionSessionId)
    expect(JSON.stringify(after)).not.toMatch(/PRIVATE|Recording|rawPayload|serialNumber|filename/)
  })
  it('exposes zero-payload cancellation drain and lets explicit disconnect safely preempt it', async () => {
    const device = await connect(() => []), abort = new AbortController()
    const reading = device.readFilePrefix('PRIVATE-Recording.hda', 8180, 8180, () => {}, undefined, abort.signal)
    await vi.waitFor(() => expect(device.getProtocolDiagnostics().stream).toMatchObject({ commandId: 13, expectedBytes: 8180, receivedBytes: 0, phase: 'receiving', cancelRequested: false }))
    abort.abort('user-cancel')
    expect(await reading).toMatchObject({ status: 'cancelled', reason: 'cancelled', received: 0 })
    const diagnostic = device.getProtocolDiagnostics()
    expect(diagnostic).toMatchObject({ currentCommand: { commandId: 13 }, activeDownload: true, fileStreamPending: true, lastFault: null,
      stream: { phase: 'draining', receivedBytes: 0, cancelRequested: true } })
    const settlement = device.getActiveDownloadSettlement(), epoch = device.getConnectionSessionId()
    expect(settlement).not.toBeNull()
    await device.disconnect(); await settlement
    expect(device.getProtocolDiagnostics()).toMatchObject({ connected: false, fileStreamPending: false, activeDownload: false, stream: null })
    expect(device.getConnectionSessionId()).toBeGreaterThan(epoch)
  })
})
