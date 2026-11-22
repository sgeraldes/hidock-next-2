// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { CMD, JensenDevice, USB_PRODUCT_IDS, parseFirmwareUpdateCard, isFirmwareUpdateCardReady, ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE, ACCEPTED_H1E_OFFICIAL_RESTORE, isOrdinaryH1eVersion, permitsFirmwareVersion, parseFirmwareImage, encodeFirmwareUpgradeRequest, parseFirmwareUpgradeAck, parseFirmwareUploadAck, encodeCustomRecordingProfile } from '../src/index.js'

function packet(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12)
  return bytes
}
function card(free = 6, capacity = 64, status = 0x900): Uint8Array {
  const bytes = new Uint8Array(28), view = new DataView(bytes.buffer)
  view.setUint32(0, free); view.setUint32(4, capacity); view.setUint32(8, status); return bytes
}
function active(): Uint8Array { return Uint8Array.of(0, 4, 116, 101, 115, 116, 0, 12, 0) }
type Reply = (command: number, sequence: number, bytes: Uint8Array, emit: (command: number, sequence: number, body: Uint8Array) => void) => void
const devices: JensenDevice[] = []
async function fixture(reply?: Reply) {
  const endpoint = Object.assign(new EventEmitter(), { startPoll: vi.fn(), stopPoll: vi.fn((cb?: () => void) => cb?.()) })
  const emit = (command: number, sequence: number, body: Uint8Array) => endpoint.emit('data', packet(command, sequence, body))
  const out: Uint8Array[] = []
  const usbDevice = {
    vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, productName: 'HiDock H1E', opened: true,
    open: vi.fn(async () => {}), selectConfiguration: vi.fn(async () => {}), claimInterface: vi.fn(async () => {}), selectAlternateInterface: vi.fn(async () => {}),
    reset: vi.fn(async () => {}), close: vi.fn(async () => {}), transferIn: vi.fn(() => new Promise(() => {})),
    device: { interface: () => ({ endpoint: () => endpoint }) },
    transferOut: vi.fn(async (_endpoint: number, data: Uint8Array) => {
      const bytes = new Uint8Array(data); out.push(bytes); const view = new DataView(bytes.buffer)
      setTimeout(() => { if (reply) reply(view.getUint16(2), view.getUint32(4), bytes, emit); else emit(view.getUint16(2), view.getUint32(4), view.getUint16(2) === CMD.GET_CARD_INFO ? card() : new Uint8Array()) }, 0)
      return { status: 'ok', bytesWritten: bytes.length }
    }),
  } as unknown as USBDevice
  const usb = { getDevices: async () => [], requestDevice: async () => usbDevice, addEventListener: () => {}, removeEventListener: () => {} } as unknown as USB
  const device = new JensenDevice(usb); await device.tryConnect(usbDevice)
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'; device.serialNumber = 'H1E-OWNER-1'
  devices.push(device)
  return { device, usbDevice, endpoint, out, emit }
}
afterEach(async () => { for (const device of devices.splice(0)) await device.disconnect(); vi.useRealTimers() })

describe('firmware read-only preflight at the actual Jensen queue/framing boundary', () => {
  it('reads exact unsigned MiB fields from subarray and rejects malformed layouts', () => {
    const raw = new Uint8Array(32); raw.set(card(6, 64, 0x900), 2)
    expect(parseFirmwareUpdateCard(raw.subarray(2, 30))).toEqual({ freeMiB: 6, capacityMiB: 64, statusCode: 0x900 })
    expect(parseFirmwareUpdateCard(card(7, 6))).toBeNull(); expect(parseFirmwareUpdateCard(card(0, 0, 0))).toBeNull()
    expect(parseFirmwareUpdateCard(card(0, 0, 4))).toEqual({ freeMiB: 0, capacityMiB: 0, statusCode: 4 })
    expect(parseFirmwareUpdateCard(card(0x80000000, 0xffffffff, 0xffffffff))?.freeMiB).toBe(0x80000000)
    for (const length of [0, 1, 12, 27, 29]) expect(parseFirmwareUpdateCard(new Uint8Array(length))).toBeNull()
    expect(isFirmwareUpdateCardReady({ freeMiB: 6, capacityMiB: 64, statusCode: 0x900 })).toBe(true)
    expect(isFirmwareUpdateCardReady({ freeMiB: 6, capacityMiB: 64, statusCode: 0x940 })).toBe(true)
    for (const statusCode of [0, 0x800, 0x901, 0x980, 0xffffffff]) expect(isFirmwareUpdateCardReady({ freeMiB: 6, capacityMiB: 64, statusCode })).toBe(false)
  })
  it('corroborates idle CMD29 using CMD18 and returns no filename or mutation', async () => {
    const f = await fixture(); expect(await f.device.getFirmwareUpdatePreflight()).toEqual({ model: 'hidock-h1e', versionNumber: 393984, serialNumber: 'H1E-OWNER-1', activeRecording: false, card: { freeMiB: 6, capacityMiB: 64, statusCode: 0x900 } })
    expect(f.out.map(b => new DataView(b.buffer).getUint16(2))).toEqual([29, 18, 16]); expect(f.usbDevice.reset).not.toHaveBeenCalled()
  })
  it('reports native active without returning filename and keeps the entire pair exclusive', async () => {
    const f = await fixture((cmd, seq, _bytes, emit) => emit(cmd, seq, cmd === 29 ? active() : cmd === 16 ? card() : Uint8Array.of(0)))
    const preflight = f.device.getFirmwareUpdatePreflight(), concurrent = f.device.setTime(new Date())
    expect(await preflight).toMatchObject({ activeRecording: true }); await concurrent
    expect(f.out.map(b => new DataView(b.buffer).getUint16(2))).toEqual([29, 16, 3])
  })
  it('treats empty CMD29 plus nonempty CMD18 as active', async () => {
    const f = await fixture((cmd, seq, _bytes, emit) => emit(cmd, seq, cmd === 18 ? Uint8Array.of(65) : cmd === 16 ? card() : new Uint8Array()))
    expect(await f.device.getFirmwareUpdatePreflight()).toMatchObject({ activeRecording: true })
  })
  it.each([0, -1, NaN, Infinity, 10.001])('refuses invalid timeout%s before any send', async timeout => { const f = await fixture(); expect(await f.device.getFirmwareUpdatePreflight(timeout)).toBeNull(); expect(f.out).toEqual([]) })
  it.each(['version', 'version-code', 'model', 'serial', 'disconnected'])('refuses unknown%s before any send', async which => {
    const f = await fixture(); if (which === 'version') f.device.versionNumber = 393983; if (which === 'version-code') f.device.versionCode = '6.3.1'; if (which === 'model') f.device.model = 'hidock-h1'; if (which === 'serial') f.device.serialNumber = null; if (which === 'disconnected') await f.device.disconnect()
    expect(await f.device.getFirmwareUpdatePreflight()).toBeNull(); expect(f.out).toEqual([])
  })
  it('fails closed when identity changes before card, sending nothing else', async () => {
    let owner: JensenDevice
    const f = await fixture((cmd, seq, _bytes, emit) => { owner.serialNumber = 'another-device'; emit(cmd, seq, new Uint8Array()) }); owner = f.device
    expect(await f.device.getFirmwareUpdatePreflight()).toBeNull(); expect(f.out).toHaveLength(1)
  })
  it('ignores wrong sequence and accepts exact correlated response', async () => {
    const f = await fixture((cmd, seq, _bytes, emit) => { emit(cmd, seq + 1, Uint8Array.of(255)); emit(cmd, seq, cmd === 16 ? card() : new Uint8Array()) })
    expect(await f.device.getFirmwareUpdatePreflight()).toMatchObject({ activeRecording: false })
  })
  it('rejects malformed recording/card data and whole-deadline silence', async () => {
    const malformed = await fixture((cmd, seq, _bytes, emit) => emit(cmd, seq, Uint8Array.of(0)))
    expect(await malformed.device.getFirmwareUpdatePreflight()).toBeNull(); expect(malformed.out).toHaveLength(1)
    const badCard = await fixture((cmd, seq, _bytes, emit) => emit(cmd, seq, cmd === 16 ? Uint8Array.of(0) : new Uint8Array()))
    expect(await badCard.device.getFirmwareUpdatePreflight()).toBeNull()
    const silent = await fixture(() => {}); expect(await silent.device.getFirmwareUpdatePreflight(.02)).toBeNull(); expect(silent.out).toHaveLength(1)
  })
})

const imageSource = readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/restore-build393988/candidate-393988-restore3/H1E-6.3.4_restore001-EXPERIMENTAL-NOT-INSTALL-VALIDATED.bin', import.meta.url)))
const artifact = () => ({ ...ACCEPTED_H1E_FIRMWARE, image: new Uint8Array(imageSource) })
const expected = { serialNumber: 'H1E-OWNER-1', versionNumber: 393984 as const, versionCode: '6.3.0' as const, uploadTimeoutSeconds: 1 }
function updateReply(cmd: number, seq: number, _bytes: Uint8Array, emit: Parameters<Reply>[3]) { emit(cmd, seq, cmd === 16 ? card() : cmd === 8 || cmd === 9 ? Uint8Array.of(0) : new Uint8Array()) }
const ids = (out: Uint8Array[]) => out.map(b => new DataView(b.buffer).getUint16(2))

const olderSource = new Uint8Array(readFileSync('G:/Code/hidock-next/firmware/hidock-h1e/6.2.5/20ec7c710a9945428a5d3f0d904876c2.bin'))
const officialSource = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../research/rea/target-acquisition/download-2026-10-11/original.bin', import.meta.url))))
const olderArtifact = () => ({ model: 'hidock-h1e' as const, versionNumber: 393733, sha256: '25f696029f647b58f224476a316236c79bad0b3f9c555ce954bec96e2369b936', image: olderSource.slice() })
function testCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function repairContainer(image: Uint8Array, files = true): Uint8Array {
  const view = new DataView(image.buffer)
  if (files) for (let i = 0; i < image[12]; i++) {
    const base = 32 + 32 * i, offset = view.getUint32(base + 16, true), size = view.getUint32(base + 20, true)
    view.setUint32(base + 28, testCrc(image.subarray(offset, offset + size)), true)
  }
  view.setUint32(24, testCrc(image.subarray(512)), true); view.setUint32(8, testCrc(image.subarray(12, 512)), true)
  return image
}
function rewriteXml(source: Uint8Array, edit: (xml: string) => string): Uint8Array {
  const image = source.slice(), view = new DataView(image.buffer)
  const index = Array.from({ length: image[12] }, (_, i) => i).find(i => new TextDecoder().decode(image.subarray(32 + 32 * i, 39 + 32 * i)) === 'ota.xml')!
  const base = 32 + 32 * index, offset = view.getUint32(base + 16, true), size = view.getUint32(base + 20, true)
  const xml = edit(new TextDecoder().decode(image.subarray(offset, offset + size)).replace(/[\t\r\n]/g, ''))
  const bytes = new TextEncoder().encode(xml); expect(bytes.length).toBeLessThanOrEqual(size)
  image.fill(32, offset, offset + size); image.set(bytes, offset)
  // Update XML/table checksums for all ordinary payloads (including corruption).
  for (let i = 0; i < image[12]; i++) if (i !== index) {
    const entry = 32 + i * 32, start = view.getUint32(entry + 16, true), length = view.getUint32(entry + 20, true)
    view.setUint32(entry + 28, testCrc(image.subarray(start, start + length)), true)
  }
  return repairContainer(image)
}

describe('explicit general H1E downgrade policy and actual ACTTEST0 identity validation', () => {
  it('accepts real official6.2.5, official6.3.0 and custom6.3.4 with actual boot/XML identities', () => {
    expect(parseFirmwareImage(olderSource)).toMatchObject({ versionNumber: 393733, versionName: '6.2.5_2503241721', bytes: 3451904, board: 'ats2835p_evb', fileCount: 7 })
    expect(parseFirmwareImage(officialSource)?.versionNumber).toBe(393984)
    expect(parseFirmwareImage(imageSource)?.versionNumber).toBe(393988)
    expect(createHash('sha256').update(olderSource).digest('hex')).toBe(olderArtifact().sha256)
  })
  it('defaults to newer-only, explicitly permits older, always rejects equality and family ambiguity', () => {
    expect(permitsFirmwareVersion(393733, 393984)).toBe(false)
    expect(permitsFirmwareVersion(393733, 393984, true)).toBe(true)
    expect(permitsFirmwareVersion(393984, 393733)).toBe(true)
    expect(permitsFirmwareVersion(393984, 393984, true)).toBe(false)
    for (const version of [NaN, 393984.5, 0x50000, 0x61000, 0x61006, 0x10060300]) expect(isOrdinaryH1eVersion(version)).toBe(false)
    expect(isOrdinaryH1eVersion(393733, '6.2.5')).toBe(true); expect(isOrdinaryH1eVersion(393733, '6.3.0')).toBe(false)
  })
  it('rejects actual older bytes by default without any device command', async () => {
    const f = await fixture(updateReply)
    expect(await f.device.uploadFirmware(olderArtifact(), expected)).toMatchObject({ status: 'rejected', phase: 'validation' })
    expect(f.out).toEqual([])
  })
  it('uploads explicitly selected real6.2.5 through unchanged CMD8/9 framing without a capability opcode', async () => {
    const f = await fixture(updateReply)
    expect(await f.device.uploadFirmware(olderArtifact(), { ...expected, allowDowngrade: true })).toMatchObject({ status: 'uploaded', installation: 'unverified', acknowledgedImageBytes: 3451904 })
    expect(ids(f.out)).toEqual([29, 18, 16, 8, 9])
    expect(f.out[3].subarray(12)).toEqual(encodeFirmwareUpgradeRequest(393733, 3451904))
    expect(Buffer.from(f.out[4].subarray(12)).equals(Buffer.from(olderSource))).toBe(true)
  })
  it('permits official6.3.0 selected by SHA from custom6.3.1 with explicit opt-in', async () => {
    const f = await fixture(updateReply); f.device.versionNumber = 393985; f.device.versionCode = '6.3.1'
    expect(await f.device.uploadFirmware({ ...ACCEPTED_H1E_OFFICIAL_RESTORE, image: officialSource }, { ...expected, versionNumber: 393985, versionCode: '6.3.1', allowDowngrade: true })).toMatchObject({ status: 'uploaded' })
    expect(ids(f.out)).toEqual([29, 18, 16, 8, 9])
  })
  it('supports a6.2.5 source roundtrip via strict legacyCMD18+card28, never sending unsupportedCMD29', async () => {
    const f = await fixture(updateReply); f.device.versionNumber = 393733; f.device.versionCode = '6.2.5'
    expect(await f.device.uploadFirmware(artifact(), { ...expected, versionNumber: 393733, versionCode: '6.2.5' })).toMatchObject({ status: 'uploaded' })
    expect(ids(f.out)).toEqual([18, 16, 8, 9])
  })
  it.each(['active', 'overlong', 'binary', 'card-shape'])('fails closed on unsafe legacy%s replies before CMD8', async kind => {
    const f = await fixture((cmd, seq, bytes, emit) => {
      if (cmd === 18) return emit(cmd, seq, kind === 'active' ? new TextEncoder().encode('20261011_120000.hda') : kind === 'overlong' ? new Uint8Array(28).fill(65) : kind === 'binary' ? Uint8Array.of(0) : new Uint8Array())
      if (cmd === 16 && kind === 'card-shape') return emit(cmd, seq, new Uint8Array(12))
      updateReply(cmd, seq, bytes, emit)
    }); f.device.versionNumber = 393733; f.device.versionCode = '6.2.5'
    expect(await f.device.uploadFirmware(artifact(), { ...expected, versionNumber: 393733, versionCode: '6.2.5' })).toMatchObject({ status: 'rejected', phase: 'preflight' })
    expect(ids(f.out)).not.toContain(8); expect(ids(f.out)).not.toContain(29)
  })
  it.each(['equality', 'mismatched-display', 'cross-family', 'nonboolean-option'])('rejects%s before any command', async kind => {
    const f = await fixture(updateReply), session = { ...expected, allowDowngrade: true }
    if (kind === 'equality') { session.versionNumber = 393988 as 393984; session.versionCode = '6.3.4' as '6.3.0' }
    if (kind === 'mismatched-display') session.versionCode = '6.2.5' as '6.3.0'
    if (kind === 'cross-family') { session.versionNumber = 0x61000 as 393984; session.versionCode = '6.16.0' as '6.3.0' }
    if (kind === 'nonboolean-option') session.allowDowngrade = 1 as unknown as boolean
    expect(await f.device.uploadFirmware(artifact(), session)).toMatchObject({ status: 'rejected', phase: 'validation' }); expect(f.out).toEqual([])
  })
  it.each(['header-crc', 'data-crc', 'file-crc', 'count', 'reserved', 'size', 'format', 'duplicate', 'overlap', 'overflow'])('rejects ACTTEST0%s corruption including recomputed outer checksums', kind => {
    const image = olderSource.slice(), view = new DataView(image.buffer)
    if (kind === 'header-crc') image[8] ^= 1
    if (kind === 'data-crc') image[24] ^= 1
    if (kind === 'file-crc') { image[60] ^= 1; repairContainer(image, false) }
    if (kind === 'count') { image[12] = 16; repairContainer(image, false) }
    if (kind === 'reserved') { image[13] = 1; repairContainer(image, false) }
    if (kind === 'size') { view.setUint32(20, image.length - 1, true); repairContainer(image, false) }
    if (kind === 'format') { image[19] ^= 1; repairContainer(image, false) }
    if (kind === 'duplicate') { image.set(image.subarray(32, 44), 64); repairContainer(image, false) }
    if (kind === 'overlap') { view.setUint32(80, view.getUint32(48, true), true); repairContainer(image, false) }
    if (kind === 'overflow') { view.setUint32(52, 0xffffffff, true); repairContainer(image, false) }
    expect(parseFirmwareImage(image)).toBeNull()
  })
  it.each(['board', 'version', 'name', 'duplicate-version', 'entities', 'attribute', 'partition-size', 'partition-checksum', 'partition-count', 'duplicate-partition'])('rejects XML%s lies even after valid container/file CRC and caller SHA rebinding', async kind => {
    const image = rewriteXml(olderSource, xml => {
      if (kind === 'board') return xml.replace('ats2835p_evb', 'ats2835p_evX')
      if (kind === 'version') return xml.replace('0x60205', '0x60300').replace('6.2.5_2503241721', '6.3.0_2503241721')
      if (kind === 'name') return xml.replace('6.2.5_2503241721', '6.2.5_2503241722')
      if (kind === 'duplicate-version') return xml.replace('</firmware_version>', '<version_code>0x60205</version_code></firmware_version>')
      if (kind === 'entities') return xml.replace('ats2835p_evb', 'ats2835p&evb')
      if (kind === 'attribute') return xml.replace('<ota_firmware>', '<ota_firmware x="1">')
      if (kind === 'partition-size') return xml.replace('<file_size>0x1000', '<file_size>0x1001')
      if (kind === 'partition-checksum') return xml.replace(/<checksum>0x[0-9a-f]+/, '<checksum>0x00000000')
      if (kind === 'partition-count') return xml.replace('<partitionsNum>6', '<partitionsNum>5')
      return xml.replace('zephyr.bin', 'mbrec.bin')
    })
    expect(parseFirmwareImage(image)).toBeNull()
    const f = await fixture(updateReply)
    expect(await f.device.uploadFirmware({ ...olderArtifact(), versionNumber: kind === 'version' ? 393984 : 393733, image, sha256: createHash('sha256').update(image).digest('hex') }, { ...expected, allowDowngrade: true })).toMatchObject({ status: 'rejected', phase: 'validation' })
    expect(f.out).toEqual([])
  })
  it('rejects boot randomizer/body corruption despite repaired container and XML checksums', () => {
    const image = olderSource.slice(), view = new DataView(image.buffer)
    const bootIndex = Array.from({ length: image[12] }, (_, i) => i).find(i => new TextDecoder().decode(image.subarray(32 + i * 32, 41 + i * 32)) === 'mbrec.bin')!
    const base = 32 + bootIndex * 32, offset = view.getUint32(base + 16, true), size = view.getUint32(base + 20, true)
    image[offset + 0xf88] ^= 1
    const newCrc = testCrc(image.subarray(offset, offset + size)).toString(16).padStart(8, '0')
    const corrected = rewriteXml(image, xml => xml.replace(/<checksum>0x[0-9a-f]+/, `<checksum>0x${newCrc}`))
    expect(parseFirmwareImage(corrected)).toBeNull()
  })
  it.each(['header-sum', 'body-sum', 'fver-crc'])('checks inner boot%s independently of valid outer CRCs using the Python SDK-derived randomizer', kind => {
    const script = `import sys,struct,zlib
sys.path.insert(0,sys.argv[1])
from decode_randomizer import transform,sum16
image=bytearray(sys.stdin.buffer.read())
for i in range(image[12]):
 p=32+32*i
 if image[p:p+12].split(bytes(1),1)[0]==b'mbrec.bin':
  offset,size=struct.unpack_from('<II',image,p+16)
  boot=bytearray(transform(image[offset:offset+size],0x08000050))
  header_size=struct.unpack_from('<H',boot,18)[0]
  body_size=struct.unpack_from('<I',boot,24)[0]
  if sys.argv[2]=='fver-crc':
   boot[0xffc]^=1
   struct.pack_into('<H',boot,22,(0xffff-sum16(boot[header_size:header_size+body_size]))&0xffff)
   struct.pack_into('<H',boot,20,0)
   struct.pack_into('<H',boot,20,(0xffff-sum16(boot[:header_size]))&0xffff)
  elif sys.argv[2]=='body-sum':
   boot[22]^=1
   struct.pack_into('<H',boot,20,0)
   struct.pack_into('<H',boot,20,(0xffff-sum16(boot[:header_size]))&0xffff)
  else: boot[20]^=1
  image[offset:offset+size]=transform(boot,0x08000050,decrypt=False)
  break
sys.stdout.buffer.write(image)`
    const image = new Uint8Array(execFileSync('python', ['-c', script, fileURLToPath(new URL('../../../research/rea/', import.meta.url)), kind], { input: olderSource, maxBuffer: 5 * 1024 * 1024 }))
    const view = new DataView(image.buffer), bootIndex = Array.from({ length: image[12] }, (_, i) => i).find(i => new TextDecoder().decode(image.subarray(32 + i * 32, 41 + i * 32)) === 'mbrec.bin')!
    const base = 32 + bootIndex * 32, offset = view.getUint32(base + 16, true), size = view.getUint32(base + 20, true), checksum = testCrc(image.subarray(offset, offset + size)).toString(16).padStart(8, '0')
    expect(parseFirmwareImage(rewriteXml(image, xml => xml.replace(/<checksum>0x[0-9a-f]+/, `<checksum>0x${checksum}`)))).toBeNull()
  })
})
describe('pinned firmware uploader through the real command queue with simulated USB', () => {
  it('matches the pinned vendor CMD8 BE fields and strict one-byte acknowledgements', () => {
    expect(Array.from(encodeFirmwareUpgradeRequest(393988, 3429376))).toEqual([0, 6, 3, 4, 0, 52, 84, 0])
    expect(parseFirmwareUpgradeAck(Uint8Array.of(0))).toBe('accepted'); expect(parseFirmwareUpgradeAck(Uint8Array.of(4))).toBe('card-error')
    expect(parseFirmwareUploadAck(Uint8Array.of(0))).toBe('success'); expect(parseFirmwareUploadAck(Uint8Array.of(255))).toBe('failed')
    for (const body of [new Uint8Array(), Uint8Array.of(0, 0)]) { expect(parseFirmwareUpgradeAck(body)).toBeNull(); expect(parseFirmwareUploadAck(body)).toBeNull() }
    expect(parseFirmwareUpgradeAck(Uint8Array.of(5))).toBeNull()
    expect(() => encodeFirmwareUpgradeRequest(1, 4194305)).toThrow(); expect(() => encodeFirmwareUpgradeRequest(0, 1)).toThrow()
  })
  it('sends one entire CMD9 frame, copied before caller mutation, and says uploaded!=installed', async () => {
    const f = await fixture(updateReply), input = artifact(), uploading = f.device.uploadFirmware(input, expected)
    input.image.fill(0)
    const concurrent = f.device.getFileCount()
    expect(await uploading).toEqual({ status: 'uploaded', phase: 'upload', reason: 'upload-acknowledged-boot-unverified', requestAccepted: true, acknowledgedImageBytes: 3429376, installation: 'unverified' })
    expect(await concurrent).toBeNull()
    expect(ids(f.out)).toEqual([29, 18, 16, 8, 9]); expect(f.out[3].subarray(12)).toEqual(encodeFirmwareUpgradeRequest(393988, 3429376))
    expect(f.out[4].length).toBe(3429388); expect(new DataView(f.out[4].buffer).getUint32(8)).toBe(3429376); expect(Buffer.from(f.out[4].subarray(12)).equals(imageSource)).toBe(true)
    expect(f.device.getFirmwareUploadFence()).toBe('uploaded'); expect(f.usbDevice.reset).not.toHaveBeenCalled(); expect(f.usbDevice.close).not.toHaveBeenCalled()
  })
  it('uses zero only for exclusive CMD9 so native multipart sequence transformation still correlates exactly', async () => {
    const f = await fixture((cmd, seq, bytes, emit) => {
      if (cmd === 9) {
        // Retained original parser's continuation serializer: low16 moved to high16.
        // The USB model splits the single large OUT into endpoint-sized input pieces.
        const pieces = Array.from({ length: Math.ceil(bytes.length / 512) }, (_, i) => bytes.subarray(i * 512, (i + 1) * 512))
        expect(pieces.length).toBeGreaterThan(2)
        expect(Buffer.concat(pieces.map(piece => Buffer.from(piece))).equals(Buffer.from(bytes))).toBe(true)
        return emit(cmd, ((seq & 0xffff) << 16) >>> 0, Uint8Array.of(0))
      }
      updateReply(cmd, seq, bytes, emit)
    })
    ;(f.device as unknown as { sequenceId: number }).sequenceId = 0x12345670
    expect(await f.device.uploadFirmware(artifact(), expected)).toMatchObject({ status: 'uploaded', installation: 'unverified' })
    expect(f.out.map(bytes => new DataView(bytes.buffer).getUint32(4))).toEqual([0x12345670, 0x12345671, 0x12345672, 0x12345673, 0])
    expect(f.out.filter(bytes => new DataView(bytes.buffer).getUint16(2) === 9)).toHaveLength(1)
    expect((f.device as unknown as { sequenceId: number }).sequenceId).toBe(0x12345674)
    expect(f.device.getFirmwareUploadFence()).toBe('uploaded')
  })
  it.each(['hash', 'bytes', 'model', 'version', 'header', 'hash-content', 'serial', 'timeout'])('rejects invalid%s without any device command', async kind => {
    const f = await fixture(updateReply), a = artifact(), session = { ...expected }
    if (kind === 'hash') a.sha256 = 'a'.repeat(64); if (kind === 'bytes') a.image = a.image.subarray(0, 8); if (kind === 'model') (a as {model: string}).model = 'hidock-h1'; if (kind === 'version') (a as {versionNumber: number}).versionNumber = 393984; if (kind === 'header') a.image[0] ^= 1; if (kind === 'hash-content') a.image[1000] ^= 1; if (kind === 'serial') session.serialNumber = ''; if (kind === 'timeout') session.uploadTimeoutSeconds = 301
    expect(await f.device.uploadFirmware(a, session)).toMatchObject({ status: 'rejected', phase: 'validation' }); expect(f.out).toEqual([])
  })
  it.each([1, 2, 3, 4])('stops at known request rejection%i, no upload or retry', async code => {
    const f = await fixture((cmd, seq, bytes, emit) => cmd === 8 ? emit(cmd, seq, Uint8Array.of(code)) : updateReply(cmd, seq, bytes, emit))
    expect(await f.device.uploadFirmware(artifact(), expected)).toMatchObject({ status: 'rejected', phase: 'request', requestAccepted: false }); expect(ids(f.out)).toEqual([29, 18, 16, 8]); expect(f.device.getFirmwareUploadFence()).toBe('none')
  })
  it.each(['active', 'free', 'card', 'identity'])('rejects unsafe%s before CMD8', async kind => {
    const f = await fixture((cmd, seq, bytes, emit) => cmd === 29 && kind === 'active' ? emit(cmd, seq, active()) : cmd === 16 && kind === 'free' ? emit(cmd, seq, card(3)) : cmd === 16 && kind === 'card' ? emit(cmd, seq, card(6, 64, 1)) : updateReply(cmd, seq, bytes, emit))
    if (kind === 'identity') f.device.serialNumber = 'another'
    expect(await f.device.uploadFirmware(artifact(), expected)).toMatchObject({ status: 'rejected', phase: 'preflight' }); expect(ids(f.out)).not.toContain(8)
  })
  it.each(['request-shape', 'request-code', 'upload-shape', 'upload-negative', 'upload-silent', 'upload-stale'])('fences uncertain%s with no retry/reset/abort/reconnect', async kind => {
    const f = await fixture((cmd, seq, bytes, emit) => {
      if (cmd === 8 && kind === 'request-shape') return emit(cmd, seq, Uint8Array.of(0, 0))
      if (cmd === 8 && kind === 'request-code') return emit(cmd, seq, Uint8Array.of(99))
      if (cmd === 9 && kind === 'upload-shape') return emit(cmd, seq, new Uint8Array())
      if (cmd === 9 && kind === 'upload-negative') return emit(cmd, seq, Uint8Array.of(1))
      if (cmd === 9 && kind === 'upload-silent') return
      if (cmd === 9 && kind === 'upload-stale') return emit(cmd, seq - 1, Uint8Array.of(0))
      updateReply(cmd, seq, bytes, emit)
    })
    const r = await f.device.uploadFirmware(artifact(), { ...expected, uploadTimeoutSeconds: .05 }); expect(r.status).toBe('uncertain'); expect(r.installation).toBe('unverified')
    const before = f.out.length; f.device.abortInFlight(); expect(await f.device.reset()).toBe(false); await f.device.disconnect(); expect(await f.device.tryConnect(f.usbDevice)).toBe(false); expect(await f.device.connect()).toBe(false); expect(await f.device.getFileCount()).toBeNull(); expect(await f.device.getDeviceInfo()).toBeNull()
    expect(f.out).toHaveLength(before); expect(f.usbDevice.reset).not.toHaveBeenCalled(); expect(f.usbDevice.close).not.toHaveBeenCalled(); expect(f.device.getFirmwareUploadFence()).toBe('uncertain')
  })
  it('permits only bounded CMD1 after upload, preserving unverified installation', async () => {
    const f = await fixture((cmd, seq, bytes, emit) => {
      if (cmd === 1) { const b = new Uint8Array(17); b.set([0, 6, 3, 4]); b.set(new TextEncoder().encode('H1E-OWNER-1'), 4); return emit(cmd, seq, b) }
      updateReply(cmd, seq, bytes, emit)
    })
    expect(await f.device.uploadFirmware(artifact(), expected)).toMatchObject({ status: 'uploaded', installation: 'unverified' }); expect(await f.device.getDeviceInfo(1)).toMatchObject({ serialNumber: 'H1E-OWNER-1', versionNumber: 393988 })
    expect(await f.device.getTime()).toBeNull(); expect(await f.device.getFirmwareUpdatePreflight()).toBeNull(); expect(ids(f.out)).toEqual([29, 18, 16, 8, 9, 1])
  })
  it('holds an early accepted ACK until the USB write actually completes', async () => {
    const f = await fixture(), release: { current?: () => void } = {}
    vi.mocked(f.usbDevice.transferOut).mockImplementation(async (_ep, data) => {
      const b = new Uint8Array(data as Uint8Array); f.out.push(b); const v = new DataView(b.buffer), cmd = v.getUint16(2), seq = v.getUint32(4)
      if (cmd === 8) { f.emit(cmd, seq, Uint8Array.of(0)); await new Promise<void>(resolve => { release.current = resolve }) }
      else setTimeout(() => updateReply(cmd, seq, b, f.emit), 0)
      return { status: 'ok', bytesWritten: b.length }
    })
    const p = f.device.uploadFirmware(artifact(), expected); await vi.waitFor(() => expect(ids(f.out)).toContain(8))
    await new Promise(resolve => setTimeout(resolve, 30)); expect(ids(f.out)).not.toContain(9); release.current!(); expect(await p).toMatchObject({ status: 'uploaded' })
  })
  it.each(['stall', 'short', 'reject', 'throw'])('fences USB%s even if upload ACK arrives early', async which => {
    const f = await fixture()
    vi.mocked(f.usbDevice.transferOut).mockImplementation((_ep, data) => {
      const b = new Uint8Array(data as Uint8Array); f.out.push(b); const v = new DataView(b.buffer), cmd = v.getUint16(2), seq = v.getUint32(4)
      if (cmd === 9) {
        f.emit(cmd, seq, Uint8Array.of(0))
        if (which === 'throw') throw new Error('synchronous transfer failure')
        return new Promise((resolve, reject) => setTimeout(() => which === 'reject' ? reject(new Error('transfer failure')) : resolve({ status: which === 'stall' ? 'stall' : 'ok', bytesWritten: which === 'short' ? b.length - 1 : b.length }), 25))
      }
      setTimeout(() => updateReply(cmd, seq, b, f.emit), 0); return Promise.resolve({ status: 'ok', bytesWritten: b.length })
    })
    expect(await f.device.uploadFirmware(artifact(), expected)).toMatchObject({ status: 'uncertain', phase: 'upload', requestAccepted: true, acknowledgedImageBytes: 0 }); expect(ids(f.out)).toEqual([29, 18, 16, 8, 9]); expect(f.device.getFirmwareUploadFence()).toBe('uncertain')
  })
  it('captures descriptor and expected identity before asynchronous validation', async () => {
    const f = await fixture(updateReply), a = artifact(), e = { ...expected }, p = f.device.uploadFirmware(a, e)
    a.versionNumber = 393989; a.sha256 = ACCEPTED_H1E_FORWARD_STOCK_RESTORE.sha256; e.serialNumber = 'another'; e.versionCode = '6.3.1'
    expect(await p).toMatchObject({ status: 'uploaded' }); expect(new DataView(f.out[3].buffer).getUint32(12)).toBe(393988)
  })
  it('times out CMD8 once and fences all later commands without a reset', async () => {
    const f = await fixture((cmd, seq, b, emit) => { if (cmd !== 8) updateReply(cmd, seq, b, emit) })
    const r = await f.device.uploadFirmware(artifact(), expected); expect(r).toMatchObject({ status: 'uncertain', phase: 'request', requestAccepted: false }); expect(ids(f.out)).toEqual([29, 18, 16, 8]); expect(await f.device.getFileCount()).toBeNull(); expect(f.usbDevice.reset).not.toHaveBeenCalled()
  }, 10000)
  it('uploads pinned forward stock-code restore only from exact custom session plus strict REA1', async () => {
    const restore = readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/restore-build393988/stock-forward-393989/H1E-6.3.5_reaRestore2-EXPERIMENTAL-NOT-INSTALL-VALIDATED.bin', import.meta.url)))
    const record = Uint8Array.of(0, ...encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }))
    const f = await fixture((cmd, seq, b, emit) => cmd === 0xf111 ? emit(cmd, seq, record) : updateReply(cmd, seq, b, emit))
    f.device.versionNumber = 393988; f.device.versionCode = '6.3.4'
    expect(await f.device.uploadFirmware({ ...ACCEPTED_H1E_FORWARD_STOCK_RESTORE, image: new Uint8Array(restore) }, { serialNumber: 'H1E-OWNER-1', versionNumber: 393988, versionCode: '6.3.4', uploadTimeoutSeconds: 1 })).toMatchObject({ status: 'uploaded', acknowledgedImageBytes: 3379712, installation: 'unverified' })
    expect(ids(f.out)).toEqual([0xf111, 29, 18, 16, 8, 9]); expect(new DataView(f.out[4].buffer).getUint32(12)).toBe(393989); expect(Buffer.from(f.out[5].subarray(12)).equals(restore)).toBe(true)
    const bad = await fixture((cmd, seq, b, emit) => cmd === 0xf111 ? emit(cmd, seq, Uint8Array.of(0)) : updateReply(cmd, seq, b, emit)); bad.device.versionNumber = 393988; bad.device.versionCode = '6.3.4'
    expect(await bad.device.uploadFirmware({ ...ACCEPTED_H1E_FORWARD_STOCK_RESTORE, image: new Uint8Array(restore) }, { serialNumber: 'H1E-OWNER-1', versionNumber: 393988, versionCode: '6.3.4' })).toMatchObject({ status: 'rejected', reason: 'restore-source-REA1-unqualified' }); expect(ids(bad.out)).toEqual([0xf111])
  })
  it.each([[393985, '6.3.1'], [393986, '6.3.2'], [393987, '6.3.3'], [393988, '6.3.2']])('rejects unqualified forward source%s/%s before capability or any OUT', async (version, code) => {
    const restore = readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/restore-build393988/stock-forward-393989/H1E-6.3.5_reaRestore2-EXPERIMENTAL-NOT-INSTALL-VALIDATED.bin', import.meta.url)))
    const f = await fixture(updateReply); f.device.versionNumber = version as number; f.device.versionCode = code as string
    expect(await f.device.uploadFirmware({ ...ACCEPTED_H1E_FORWARD_STOCK_RESTORE, image: new Uint8Array(restore) },
      { serialNumber: 'H1E-OWNER-1', versionNumber: version as number, versionCode: code as string })).toMatchObject({ status: 'rejected' })
    expect(f.out).toEqual([])
  })
  it('rejects retained historical393986 bytes before any command despite a future descriptor', async () => {
    const old = readFileSync(fileURLToPath(new URL('../../../research/rea/completion630-lab/firmware/candidate-393986-upload2/H1E-6.3.2_audit001-EXPERIMENTAL-NOT-INSTALL-VALIDATED.bin', import.meta.url)))
    const f = await fixture(updateReply)
    expect(await f.device.uploadFirmware({ ...ACCEPTED_H1E_FIRMWARE, image: new Uint8Array(old) }, expected)).toMatchObject({ status: 'rejected', phase: 'validation' })
    expect(f.out).toEqual([])
  })
})
