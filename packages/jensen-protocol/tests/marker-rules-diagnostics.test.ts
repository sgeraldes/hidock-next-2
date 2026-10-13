import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS, encodeCustomRecordingProfile, encodeCustomMarkerRules } from '../src/index.js'

const rules = { enabled: false, lane: 2 as const, meanMagnitudeThreshold: 1000 }
const profile = Uint8Array.of(0, ...encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }))
const currentRules = Uint8Array.of(0, ...encodeCustomMarkerRules({ ...rules, enabled: true, meanMagnitudeThreshold: 100 }))
const command = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint16(2)
const sequence = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(4)
function frame(id: number, seq: number, body: Uint8Array) {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, id); view.setUint32(4, seq); view.setUint32(8, body.length); bytes.set(body, 12); return bytes
}
const devices: JensenDevice[] = []
async function connect(reply?: (id: number, seq: number, body: Uint8Array) => Uint8Array | null) {
  const pending: Uint8Array[] = [], sent: Uint8Array[] = []
  const endpoint = Object.assign(new EventEmitter(), { startPoll() { for (const bytes of pending.splice(0)) this.emit('data', bytes) }, stopPoll(done?: () => void) { done?.() } })
  const emit = (bytes: Uint8Array) => { if (endpoint.listenerCount('data')) endpoint.emit('data', bytes); else pending.push(bytes) }
  const handle = { vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: false, async open() { this.opened = true }, async close() { this.opened = false },
    async reset() { throw Error('Unexpected reset') }, async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {},
    device: { interface: () => ({ endpoint: () => endpoint }) }, async transferOut(_ep: number, data: Uint8Array) {
      const bytes = data.slice(); sent.push(bytes); const id = command(bytes), seq = sequence(bytes)
      const body = id === 0xf111 ? profile : id === 0xf116 ? currentRules : id === 6 ? Uint8Array.of(0, 0, 0, 2) : Uint8Array.of(0)
      const response = reply ? reply(id, seq, body) : body
      if (response) emit(frame(id, seq, response))
      return { status: 'ok', bytesWritten: bytes.length }
    } }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  devices.push(device); expect(await device.tryConnect(handle as unknown as USBDevice)).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393986; device.versionCode = '6.3.2'; device.serialNumber = 'SECRET-ID'
  return { device, sent }
}
afterEach(async () => { for (const device of devices.splice(0)) await device.disconnect() })

describe('persistent sanitized marker setter attempts through the public command queue', () => {
  it.each([[0xf111, 'profile', 1], [0xf116, 'rules', 1], [0xf115, 'mutation', 2]] as const)('distinguishes malformed command%s at phase%s', async (id, stage, length) => {
    const h = await connect((command, _seq, body) => command === id ? new Uint8Array(length) : body)
    expect(await h.device.setCustomMarkerRules(rules)).toBeNull()
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ attempt: 1, stage, commandId: id,
      outcome: 'malformed-reply', responseBodyBytes: length, mutationAttempted: stage === 'mutation', ackCode: null })
    expect(h.sent.map(command)).toEqual(stage === 'profile' ? [0xf111] : stage === 'rules' ? [0xf111, 0xf116] : [0xf111, 0xf116, 0xf115])
  })
  it.each([0, 1])('returns the exact single native-style ACK%s without classifying rejection as null', async ack => {
    const h = await connect((id, _seq, body) => id === 0xf115 ? Uint8Array.of(ack) : body)
    expect(await h.device.setCustomMarkerRules(rules)).toEqual({ result: ack === 0 ? 'success' : 'failed', persistence: 'unverified' })
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ stage: 'mutation', outcome: ack === 0 ? 'acknowledged' : 'rejected',
      commandId: 0xf115, sequence: 2, ackCode: ack, responseBodyBytes: 1, mutationAttempted: true })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf116, 0xf115])
  })
  it.each([0xf116, 0xf115])('distinguishes missing reply after command%s and never retries the mutation', async id => {
    const h = await connect((command, _seq, body) => command === id ? null : body)
    expect(await h.device.setCustomMarkerRules(rules, .02)).toBeNull()
    const before = h.device.getProtocolDiagnostics().lastMarkerRulesAttempt
    expect(before).toMatchObject({ stage: id === 0xf115 ? 'mutation' : 'rules', commandId: id, responseBodyBytes: null,
      mutationAttempted: id === 0xf115, outcome: id === 0xf115 ? 'mutation-unavailable' : 'preflight-unavailable' })
    expect(await h.device.getFileCount()).toEqual({ count: 2 })
    expect(h.sent.filter(bytes => command(bytes) === 0xf115)).toHaveLength(id === 0xf115 ? 1 : 0)
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toEqual(before)
  })
  it('retains the setter record through getter/ring rollover/disconnect and returns an independent copy', async () => {
    const h = await connect(); expect(await h.device.setCustomMarkerRules(rules)).toMatchObject({ result: 'success' })
    const record = h.device.getProtocolDiagnostics().lastMarkerRulesAttempt
    expect(await h.device.getCustomMarkerRules()).toMatchObject({ enabled: true, meanMagnitudeThreshold: 100 })
    for (let i = 0; i < 70; i++) expect(await h.device.getFileCount()).toEqual({ count: 2 })
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toEqual(record)
    await h.device.disconnect()
    const after = h.device.getProtocolDiagnostics(); expect(after.lastMarkerRulesAttempt).toEqual(record)
    expect(JSON.stringify(after)).not.toMatch(/SECRET|meanMagnitudeThreshold|enabled|serialNumber|filename|rawPayload/)
    after.lastMarkerRulesAttempt!.attempt = -1
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt?.attempt).toBe(1)
  })
  it('records invalid input and unsupported owner without dispatch or rule contents', async () => {
    const h = await connect()
    expect(await h.device.setCustomMarkerRules({ ...rules, meanMagnitudeThreshold: 0 })).toBeNull()
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ attempt: 1, stage: 'input', outcome: 'invalid-input', mutationAttempted: false })
    h.device.versionNumber = 393987; h.device.versionCode = '6.3.3'
    expect(await h.device.setCustomMarkerRules(rules)).toBeNull()
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ attempt: 2, stage: 'queued', outcome: 'owner-unqualified', mutationAttempted: false })
    expect(h.sent).toEqual([])
  })
  it('records validation policy denying the mutation after permitted capability reads', async () => {
    const h = await connect(); h.device.deviceValidationReadOnly = true
    expect(await h.device.setCustomMarkerRules(rules)).toBeNull()
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ stage: 'mutation', mutationAttempted: false,
      outcome: 'mutation-unavailable', validationReadOnly: true })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf116])
  })
  it('rejects an identity change after REM1 before any mutation', async () => {
    let device: JensenDevice | undefined
    const h = await connect((id, _seq, body) => { if (id === 0xf116) device!.serialNumber = 'CHANGED-ID'; return body }); device = h.device
    expect(await h.device.setCustomMarkerRules(rules)).toBeNull()
    expect(h.device.getProtocolDiagnostics().lastMarkerRulesAttempt).toMatchObject({ stage: 'rules', outcome: 'session-changed', mutationAttempted: false })
    expect(h.sent.map(command)).toEqual([0xf111, 0xf116])
  })
})
