/** Read-only firmware-update readiness; card counters are BE32 MiB, not bytes. */
export interface FirmwareUpdateCard {
  capacityMiB: number
  freeMiB: number
  statusCode: number
}

export interface FirmwareUpdatePreflight {
  model: 'hidock-h1e'
  versionNumber: number
  serialNumber: string
  activeRecording: boolean
  card: FirmwareUpdateCard
}
/** No wire bytes, file names or device identity; safe owner-side diagnostics. */
export interface FirmwareUpdatePreflightFailure {
  stage: 'gate' | 'status' | 'idle' | 'card'
  reason: 'invalid-timeout' | 'version' | 'identity' | 'session-changed' | 'missing-reply' | 'response-error' | 'malformed-reply'
  responseBytes?: number
}

// Pinned offline-qualified experiment only. This descriptor is not permission
// to install; execution requires an explicit prepared attempt through the owner.
export const ACCEPTED_H1E_FIRMWARE = Object.freeze({
  model: 'hidock-h1e' as const,
  versionNumber: 393988 as const,
  bytes: 3429376,
  sha256: '4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8',
})
/** Stock6.3.0 code with forward6.3.5 identity; not ROM/ADFU recovery. */
export const ACCEPTED_H1E_FORWARD_STOCK_RESTORE = Object.freeze({
  model: 'hidock-h1e' as const,
  versionNumber: 393989 as const,
  bytes: 3379712,
  sha256: 'f3fd009ae8eaac58271c2b4479a4ab7441c867d0bdc56afc5d70a4f77e224578',
})
/** Exact retained official image. Older targets require explicit host opt-in. */
export const ACCEPTED_H1E_OFFICIAL_RESTORE = Object.freeze({
  model: 'hidock-h1e' as const,
  versionNumber: 393984 as const,
  bytes: 3379712,
  sha256: '5c5c10ca817caef30994d93f9c437bb86e2e5c20437d5fde5942e043fd90d3e5',
})
export const MAX_FIRMWARE_IMAGE_BYTES = 4 * 1024 * 1024
export interface FirmwareUploadArtifact {
  model: 'hidock-h1e'
  versionNumber: number
  /** SHA256 of the explicitly selected artifact, checked against actual bytes. */
  sha256: string
  image: Uint8Array
}
export interface FirmwareUploadSession {
  serialNumber: string
  versionNumber: number
  versionCode: string
  /** Default false. Does not bypass board, CRC, identity or native checks. */
  allowDowngrade?: boolean
  /** Vendor H1E6.3 uses300s; smaller bounded deadlines are useful offline. */
  uploadTimeoutSeconds?: number
}
export interface FirmwareUploadResult {
  status: 'rejected' | 'uncertain' | 'uploaded'
  phase: 'validation' | 'preflight' | 'request' | 'upload'
  reason: string
  requestAccepted: boolean
  acknowledgedImageBytes: number
  installation: 'unverified'
}
export type FirmwareUploadFence = 'none' | 'uncertain' | 'uploaded'

/** CMD8 vendor contract: versionBE32 then total image bytesBE32. */
export function encodeFirmwareUpgradeRequest(versionNumber: number, imageBytes: number): Uint8Array {
  if (!Number.isInteger(versionNumber) || versionNumber <= 0 || versionNumber > 0xffffffff || !Number.isInteger(imageBytes) || imageBytes <= 0 || imageBytes > MAX_FIRMWARE_IMAGE_BYTES) throw new RangeError('Invalid firmware request bounds')
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer)
  view.setUint32(0, versionNumber); view.setUint32(4, imageBytes)
  return bytes
}
export function parseFirmwareUpgradeAck(body: Uint8Array): 'accepted' | 'wrong-version' | 'busy' | 'card-full' | 'card-error' | null {
  return body.length === 1 ? (['accepted', 'wrong-version', 'busy', 'card-full', 'card-error'] as const)[body[0]] ?? null : null
}
export function parseFirmwareUploadAck(body: Uint8Array): 'success' | 'failed' | null {
  return body.length === 1 ? body[0] === 0 ? 'success' : 'failed' : null
}
/** Ordinary H1E family only; 6.16.x is ambiguous with C1 and excluded. */
export function isOrdinaryH1eVersion(version: number, display?: string): boolean {
  if (!Number.isInteger(version) || version < 0x60000 || version >= 0x61000) return false
  return display === undefined || display === `6.${(version >>> 8) & 255}.${version & 255}`
}
/** Equality is rejected by native CMD8 too. No automatic older-image selection. */
export function permitsFirmwareVersion(target: number, current: number, allowDowngrade = false): boolean {
  return isOrdinaryH1eVersion(target) && isOrdinaryH1eVersion(current) && target !== current && (target > current || allowDowngrade === true)
}

export interface FirmwareImageMetadata {
  model: 'hidock-h1e'
  board: 'ats2835p_evb'
  versionNumber: number
  versionName: string
  bytes: number
  fileCount: number
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}
interface XmlNode { name: string; text: string; children: XmlNode[] }
/** Bounded subset of the actual OTA XML grammar. No DTD, entities, attributes,
 * comments or duplicate scalar fields; works identically in Node and browser. */
function otaXml(bytes: Uint8Array): XmlNode | null {
  if (!bytes.length || bytes.length > 65536 || bytes.some(b => b > 127 || (b < 32 && b !== 9 && b !== 10 && b !== 13))) return null
  let source = new TextDecoder().decode(bytes)
  source = source.replace(/^\s*<\?xml version=['"]1\.0['"] encoding=['"]UTF-8['"]\?>/, '')
  const document: XmlNode = { name: '#document', text: '', children: [] }, stack = [document]
  let position = 0, nodes = 0
  const token = /<\/?[A-Za-z_][A-Za-z0-9_]*>|[^<]+/gy
  while (position < source.length) {
    token.lastIndex = position
    const match = token.exec(source)
    if (!match) return null
    const value = match[0]; position = token.lastIndex
    if (value.startsWith('</')) {
      if (stack.length === 1 || stack.pop()!.name !== value.slice(2, -1)) return null
    } else if (value.startsWith('<')) {
      if (++nodes > 128 || stack.length > 4) return null
      const child: XmlNode = { name: value.slice(1, -1), text: '', children: [] }
      stack[stack.length - 1].children.push(child); stack.push(child)
    } else {
      if (value.includes('&') || value.includes('>')) return null
      stack[stack.length - 1].text += value
    }
  }
  return stack.length === 1 && document.children.length === 1 && !document.text.trim() ? document.children[0] : null
}
function fields(node: XmlNode, allowed: string[]): boolean {
  return !node.text.trim() && node.children.length === allowed.length && allowed.every(name => node.children.filter(c => c.name === name).length === 1)
}
function child(node: XmlNode, name: string): XmlNode { return node.children.find(c => c.name === name)! }
function scalar(node: XmlNode, name: string): string | null {
  const value = child(node, name)
  return value && !value.children.length ? value.text.trim() : null
}
function xmlInteger(value: string | null): number | null {
  if (value === null || !/^(?:0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= 0xffffffff ? number : null
}
const randomizerMasks = [
  [5, 0, 10, 15, 20, 25, 31], [0, 1, 6, 12, 16, 22, 27],
  [2, 7, 13, 23, 28], [8, 3, 14, 24, 29], [25, 15, 31, 4, 9],
  [5, 10, 26], [5, 12, 28], [2, 6, 7, 13, 3, 8, 29],
].map(bits => bits.reduce((mask, bit) => mask | (1 << bit), 0))
const randomizerFeedback = [0, 31, 25, 22, 21, 15, 11, 10, 9, 7, 6, 4, 3, 1].reduce((mask, bit) => mask | (1 << bit), 0)
function parity(value: number): number {
  value ^= value >>> 16; value ^= value >>> 8; value ^= value >>> 4
  return (0x6996 >>> (value & 15)) & 1
}
/** Known H1E 4KiB boot contract, SDK randomizer seed08000050/block32.
 * A different boot layout/seed fails closed instead of guessing its metadata. */
function matchesBootIdentity(encoded: Uint8Array, versionNumber: number, versionName: string, board: string): boolean {
  if (encoded.length !== 4096) return false
  const boot = new Uint8Array(encoded.length)
  let state = 0x08000050
  for (let index = 0; index < encoded.length; index++) {
    if (index % 32 === 0) state = 0x08000050
    let mask = 0
    for (let bit = 0; bit < 8; bit++) mask |= parity(state & randomizerMasks[bit]) << bit
    const plain = encoded[index] ^ mask; boot[index] = plain
    state = (((state << 1) & 0xfffffffc) | parity(state & randomizerFeedback) | (((state & 1) ^ parity(plain & 0x3c)) << 1)) >>> 0
  }
  if (new TextDecoder().decode(boot.subarray(0, 8)) !== 'ACTHHTCA') return false
  const view = new DataView(boot.buffer), headerSize = view.getUint16(18, true), bodySize = view.getUint32(24, true), tailSize = view.getUint32(28, true)
  const sum16 = (start: number, bytes: number) => { let sum = 0; for (let offset = start; offset < start + bytes; offset += 2) sum = (sum + view.getUint16(offset, true)) & 65535; return sum }
  if (headerSize < 48 || headerSize % 2 || bodySize % 2 || headerSize + bodySize + tailSize > boot.length || sum16(0, headerSize) !== 65535 || ((sum16(headerSize, bodySize) + view.getUint16(22, true)) & 65535) !== 65535) return false
  const load = view.getUint32(8, true), entry = view.getUint32(32, true)
  if (entry < load + headerSize || entry >= load + boot.length) return false
  const record = boot.subarray(0xf80), fver = new DataView(record.buffer, record.byteOffset, record.byteLength)
  const fixedString = (start: number, length: number): string | null => {
    const bytes = record.subarray(start, start + length), nul = bytes.indexOf(0)
    if (nul < 0 || bytes.subarray(nul).some(b => b !== 0) || bytes.subarray(0, nul).some(b => b < 32 || b > 126)) return null
    return new TextDecoder().decode(bytes.subarray(0, nul))
  }
  return new TextDecoder().decode(record.subarray(0, 4)) === 'FVER' && crc32(record.subarray(0, 124)) === fver.getUint32(124, true) && fver.getUint32(4, true) === versionNumber && fixedString(12, 64) === versionName && fixedString(76, 32) === board
}
/** Checks the actual ACTTEST0 header/data/every-file CRC, bounded directory and
 * all XML partition sizes/checksums. SHA verification is a separate async step.
 * Caller SHA pins selection; these CRCs are integrity checks, not signatures. */
export function parseFirmwareImage(image: Uint8Array): FirmwareImageMetadata | null {
  if (!(image instanceof Uint8Array) || image.length < 512 || image.length > MAX_FIRMWARE_IMAGE_BYTES || new TextDecoder().decode(image.subarray(0, 8)) !== 'ACTTEST0') return null
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength), count = image[12]
  const u32 = (offset: number) => view.getUint32(offset, true)
  if (count < 2 || count > 15 || image[13] || image[14] || image[15] || u32(16) !== 0x01000000 || u32(20) !== image.length || crc32(image.subarray(12, 512)) !== u32(8) || crc32(image.subarray(512)) !== u32(24)) return null
  const entries: { name: string; offset: number; size: number; crc: number }[] = []
  for (let index = 0; index < count; index++) {
    const position = 32 + index * 32, nameBytes = image.subarray(position, position + 12), end = nameBytes.indexOf(0)
    const name = new TextDecoder().decode(end < 0 ? nameBytes : nameBytes.subarray(0, end))
    if (!/^[A-Za-z0-9_.-]{1,12}$/.test(name) || name === '.' || name === '..' || (end >= 0 && nameBytes.subarray(end).some(b => b !== 0))) return null
    const offset = u32(position + 16), size = u32(position + 20), crc = u32(position + 28)
    if (offset < 512 || size === 0 || offset + size > image.length || entries.some(e => e.name === name || Math.max(offset, e.offset) < Math.min(offset + size, e.offset + e.size)) || crc32(image.subarray(offset, offset + size)) !== crc) return null
    entries.push({ name, offset, size, crc })
  }
  const xmlEntry = entries.find(e => e.name === 'ota.xml')
  if (!xmlEntry) return null
  const root = otaXml(image.subarray(xmlEntry.offset, xmlEntry.offset + xmlEntry.size))
  if (!root || root.name !== 'ota_firmware' || !fields(root, ['firmware_version', 'partitions'])) return null
  const version = child(root, 'firmware_version'), partitions = child(root, 'partitions')
  if (!fields(version, ['version_code', 'version_name', 'ota_version_check', 'board_name'])) return null
  const versionNumber = xmlInteger(scalar(version, 'version_code')), versionName = scalar(version, 'version_name'), board = scalar(version, 'board_name'), check = scalar(version, 'ota_version_check')
  if (versionNumber === null || !isOrdinaryH1eVersion(versionNumber) || !versionName || versionName.length > 64 || !/^6\.[0-9]{1,3}\.[0-9]{1,3}_[A-Za-z0-9_.-]+$/.test(versionName) || !isOrdinaryH1eVersion(versionNumber, versionName.split('_')[0]) || board !== 'ats2835p_evb' || (check !== 'true' && check !== 'false') || partitions.text.trim()) return null
  if (partitions.children.filter(c => c.name === 'partitionsNum').length !== 1 || partitions.children.some(c => c.name !== 'partitionsNum' && c.name !== 'partition')) return null
  const partitionCount = xmlInteger(scalar(partitions, 'partitionsNum')), rows = partitions.children.filter(c => c.name === 'partition')
  if (partitionCount !== rows.length || rows.length !== count - 1) return null
  const names = new Set<string>(), ids = new Set<number>(), types: string[] = []
  let bootEntry: typeof entries[number] | undefined
  for (const row of rows) {
    if (!fields(row, ['type', 'name', 'file_id', 'file_name', 'file_size', 'checksum'])) return null
    const name = scalar(row, 'file_name'), id = xmlInteger(scalar(row, 'file_id')), type = scalar(row, 'type'), partitionName = scalar(row, 'name')
    const entry = entries.find(e => e.name === name && e.name !== 'ota.xml')
    if (!entry || id === null || id > 255 || ids.has(id) || names.has(entry.name) || !type || !/^[A-Z_]{1,16}$/.test(type) || !partitionName || !/^[A-Za-z0-9_]{1,32}$/.test(partitionName) || xmlInteger(scalar(row, 'file_size')) !== entry.size || xmlInteger(scalar(row, 'checksum')) !== entry.crc) return null
    names.add(entry.name); ids.add(id); types.push(type)
    if (type === 'BOOT') bootEntry = entry
  }
  if (types.filter(type => type === 'BOOT').length !== 1 || types.filter(type => type === 'SYSTEM').length !== 1) return null
  if (!bootEntry || !matchesBootIdentity(image.subarray(bootEntry.offset, bootEntry.offset + bootEntry.size), versionNumber, versionName, board)) return null
  return { model: 'hidock-h1e', board: 'ats2835p_evb', versionNumber, versionName, bytes: image.length, fileCount: count }
}
/** Synchronous copy before any await/queued owner operation. */
export function copyFirmwareUploadArtifact(artifact: FirmwareUploadArtifact): Uint8Array | null {
  if (!artifact) return null
  const { model, versionNumber, sha256, image } = artifact
  if (model !== 'hidock-h1e' || !isOrdinaryH1eVersion(versionNumber) || !/^[a-f0-9]{64}$/.test(sha256) || !(image instanceof Uint8Array) || image.length < 512 || image.length > MAX_FIRMWARE_IMAGE_BYTES) return null
  const copy = new Uint8Array(image)
  if (parseFirmwareImage(copy)?.versionNumber !== versionNumber) return null
  return copy
}
export async function matchesAcceptedFirmwareImage(image: Uint8Array, sha256: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return false
  if (!/^[a-f0-9]{64}$/.test(sha256)) return false
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(image).buffer))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === sha256
}

/** Exact6.3 CMD16 is28B: three BE32 prefix words then an extra word and12B
 * opaque tail.01038e10 sets body length0x1c; vendor UI reads only12B prefix.
 * Tail semantics are not inferred or exposed as physical device identity. */
export function parseFirmwareUpdateCard(body: Uint8Array): FirmwareUpdateCard | null {
  if (body.length !== 28) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const freeMiB = view.getUint32(0), capacityMiB = view.getUint32(4), statusCode = view.getUint32(8)
  if (freeMiB > capacityMiB || (capacityMiB === 0 && statusCode === 0)) return null
  return { capacityMiB, freeMiB, statusCode }
}
/** Exact native CMD8 readiness test: mask optional0x40, require0x900. */
export function isFirmwareUpdateCardReady(card: FirmwareUpdateCard): boolean {
  return (card.statusCode & ~0x40) === 0x900
}
