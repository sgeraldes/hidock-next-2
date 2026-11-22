/** Default-off native mean-magnitude rules; neutral lane IDs, no calibration claim. */
export const CUSTOM_MARKER_RULES_SET = 0xf115
export const CUSTOM_MARKER_RULES_GET = 0xf116
export interface CustomMarkerRules { enabled: boolean; lane: 0 | 1 | 2; meanMagnitudeThreshold: number }
export interface CustomMarkerRulesResponse extends CustomMarkerRules { storage: 'stored' | 'fallback' }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (~crc) >>> 0
}

export function encodeCustomMarkerRules(rules: CustomMarkerRules): Uint8Array {
  if (!rules || typeof rules.enabled !== 'boolean' || !Number.isInteger(rules.lane) || rules.lane < 0 || rules.lane > 2 ||
      !Number.isInteger(rules.meanMagnitudeThreshold) || rules.meanMagnitudeThreshold < 1 || rules.meanMagnitudeThreshold > 32767) {
    throw new Error('Invalid experimental mean-magnitude marker rule')
  }
  const bytes = new Uint8Array(36), view = new DataView(bytes.buffer)
  const words = [0x3633434d, 1, 36, rules.enabled ? 1 : 0, rules.lane, rules.meanMagnitudeThreshold, 0, 0]
  words.forEach((word, i) => view.setUint32(i * 4, word, true))
  view.setUint32(32, crc32(bytes.subarray(0, 32)), true)
  return bytes
}

export function parseCustomMarkerRules(bytes: Uint8Array): CustomMarkerRules | null {
  if (bytes.length !== 36) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x3633434d || view.getUint32(4, true) !== 1 || view.getUint32(8, true) !== 36 ||
      view.getUint32(12, true) > 1 || view.getUint32(16, true) > 2 || view.getUint32(24, true) !== 0 || view.getUint32(28, true) !== 0 ||
      view.getUint32(32, true) !== crc32(bytes.subarray(0, 32))) return null
  const meanMagnitudeThreshold = view.getUint32(20, true)
  if (meanMagnitudeThreshold < 1 || meanMagnitudeThreshold > 32767) return null
  return { enabled: view.getUint32(12, true) === 1, lane: view.getUint32(16, true) as 0 | 1 | 2, meanMagnitudeThreshold }
}

export function parseCustomMarkerRulesResponse(bytes: Uint8Array): CustomMarkerRulesResponse | null {
  if (bytes.length !== 37 || bytes[0] > 1) return null
  const rules = parseCustomMarkerRules(bytes.subarray(1))
  return rules ? { ...rules, storage: bytes[0] === 0 ? 'stored' : 'fallback' } : null
}
