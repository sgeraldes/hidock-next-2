import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { JensenDevice, USB_PRODUCT_IDS } from '../src/index.js'

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/protocol/native-full-file/wire-fixtures.json', import.meta.url)), 'utf8'))
const frame = (id: string): Uint8Array[] => corpus.cases.find((row: { id: string }) => row.id === id).response_frames_hex.map((hex: string) => Uint8Array.from(Buffer.from(hex, 'hex')))

/** Models read completion at requested bytes OR a USB short packet, never Jensen frame boundaries. */
class PacketReadGate {
  readonly packets: Uint8Array[] = []
  private parts: Uint8Array[] = []
  heldBytes = 0
  requestedBytes = 0
  complete: ((bytes: Uint8Array) => void) | null = null
  enqueue(wire: Uint8Array): void { for (let i = 0; i < wire.length; i += 512) this.packets.push(wire.slice(i, i + 512)); this.pump() }
  pump(): void {
    while (this.complete && this.packets.length) {
      const packet = this.packets.shift()!
      this.parts.push(packet); this.heldBytes += packet.length
      if (this.heldBytes === this.requestedBytes || packet.length < 512) {
        const bytes = new Uint8Array(this.heldBytes); let offset = 0
        for (const part of this.parts) { bytes.set(part, offset); offset += part.length }
        this.parts = []; this.heldBytes = 0
        this.complete(bytes)
      }
    }
  }
}
class PollGate extends EventEmitter {
  readonly gate = new PacketReadGate()
  readonly starts: [number, number][] = []
  startPoll(transfers: number, bytes: number): void { this.starts.push([transfers, bytes]); this.gate.requestedBytes = bytes; this.gate.complete = data => this.emit('data', data); this.gate.pump() }
  stopPoll(done?: () => void): void { this.gate.complete = null; done?.() }
}
const devices: JensenDevice[] = []
afterEach(async () => { for (const device of devices.splice(0)) await device.disconnect() })

async function owner(mode: 'native-poll' | 'webusb', frames: Uint8Array[]) {
  const poll = new PollGate(), gate = mode === 'native-poll' ? poll.gate : new PacketReadGate(), reads: number[] = []
  let browserPending: ((result: USBInTransferResult) => void) | null = null
  const handle = {
    vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, opened: false,
    async open() { this.opened = true }, async close() { this.opened = false; browserPending?.({ status: 'ok', data: new DataView(new ArrayBuffer(0)) }); browserPending = null },
    async reset() { throw Error('Unexpected reset') }, async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {},
    async transferOut(_endpoint: number, input: Uint8Array) {
      const request = new Uint8Array(input), sequence = new DataView(request.buffer).getUint32(4)
      for (const original of frames) { const bytes = original.slice(); new DataView(bytes.buffer).setUint32(4, sequence); gate.enqueue(bytes) }
      return { status: 'ok' as const, bytesWritten: request.length }
    },
    async transferIn(_endpoint: number, bytes: number): Promise<USBInTransferResult> {
      if (mode === 'native-poll') throw Error('Native poll must own reads')
      reads.push(bytes); gate.requestedBytes = bytes
      return new Promise(resolve => { browserPending = resolve; gate.complete = value => { gate.complete = null; browserPending = null; resolve({ status: 'ok', data: new DataView(value.buffer) }) }; gate.pump() })
    },
    ...(mode === 'native-poll' ? { device: { interface: () => ({ endpoint: () => poll }) } } : {})
  }
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  devices.push(device); expect(await device.tryConnect(handle as unknown as USBDevice)).toBe(true)
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'; device.deviceValidationReadOnly = true
  return { device, poll, gate, reads }
}

describe('8192-byte native frame versus USB read completion', () => {
  it('reproduces withheld callbacks for the previous32768-byte read without pretending the device emitted nothing', () => {
    const poll = new PollGate(), delivered: Uint8Array[] = []
    poll.on('data', bytes => delivered.push(bytes)); poll.startPoll(3, 32768)
    poll.gate.enqueue(frame('prefix-8180')[0])
    expect(poll.gate.heldBytes).toBe(8192); expect(delivered).toEqual([])
    // A genuine USB short packet completes that same pending aggregate.
    poll.gate.enqueue(Uint8Array.of(1))
    expect(delivered.map(bytes => bytes.length)).toEqual([8193])
  })
  it.each(['native-poll', 'webusb'] as const)('delivers exact native8192 frames through public%s reads without a ZLP or later command', async mode => {
    const { device, poll, reads } = await owner(mode, frame('prefix-8180')), chunks: Uint8Array[] = []
    expect(await device.readFilePrefix('LAB630.hda', 8180, 8180, bytes => chunks.push(bytes))).toMatchObject({ status: 'complete', received: 8180 })
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from(Array.from({ length: 8180 }, (_, i) => i % 251)))
    expect(device.getProtocolDiagnostics().readRequest).toEqual({ transport: mode, bufferBytes: 8192, transfers: mode === 'native-poll' ? 3 : 1 })
    if (mode === 'native-poll') expect(poll.starts).toEqual([[3, 8192]])
    else expect(reads.every(bytes => bytes === 8192)).toBe(true)
  })
  it('preserves multiple exact native frames across independent host read completions', async () => {
    const { device } = await owner('native-poll', frame('prefix-16360')), chunks: Uint8Array[] = []
    expect(await device.readFilePrefix('LAB630.hda', 16360, 16360, bytes => chunks.push(bytes))).toMatchObject({ status: 'complete', received: 16360 })
    expect(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))).toEqual(Buffer.from(Array.from({ length: 16360 }, (_, i) => i % 251)))
    expect(device.getProtocolDiagnostics().events.filter(event => event.kind === 'in').map(event => event.bytes)).toEqual([8192, 8192])
  })
})
