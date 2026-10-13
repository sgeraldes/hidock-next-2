import { describe, expect, it } from 'vitest'
import { encodeCustomMarkerRules, parseCustomMarkerRules, parseCustomMarkerRulesResponse } from '../src/custom-marker-rules.js'

describe('native rule wire contract', () => {
  it('round trips offset views and independent standard CRC32 fixture', () => {
    const rules = { enabled: false, lane: 2 as const, meanMagnitudeThreshold: 1000 }
    const bytes = encodeCustomMarkerRules(rules)
    const padded = Uint8Array.of(0, ...bytes, 0)
    expect(parseCustomMarkerRules(padded.subarray(1, 37))).toEqual(rules)
    expect(parseCustomMarkerRulesResponse(Uint8Array.of(1, ...bytes))).toEqual({ ...rules, storage: 'fallback' })
    // Python zlib.crc32(struct.pack('<8I', magic,1,36,0,2,1000,0,0)).
    expect(Array.from(bytes.subarray(32))).toEqual([233, 79, 121, 193])
    expect(Array.from(bytes.subarray(0, 12))).toEqual([77, 67, 51, 54, 1, 0, 0, 0, 36, 0, 0, 0])
  })
  it.each(Array.from({ length: 36 }, (_, i) => i))('rejects corruption at byte %i', i => {
    const bytes = encodeCustomMarkerRules({ enabled: true, lane: 0, meanMagnitudeThreshold: 1 })
    bytes[i] ^= 1
    expect(parseCustomMarkerRules(bytes)).toBeNull()
  })
  it.each([0, 32768, -1, 1.5, NaN])('rejects unsafe threshold %s', meanMagnitudeThreshold => {
    expect(() => encodeCustomMarkerRules({ enabled: true, lane: 0, meanMagnitudeThreshold })).toThrow()
  })
  it('rejects missing/invalid capability frames and invalid lane/enable fields', () => {
    expect(parseCustomMarkerRules(new Uint8Array(35))).toBeNull()
    expect(parseCustomMarkerRulesResponse(Uint8Array.of(2, ...encodeCustomMarkerRules({ enabled: false, lane: 0, meanMagnitudeThreshold: 1 })))).toBeNull()
    expect(() => encodeCustomMarkerRules({ enabled: true, lane: 3 as 0, meanMagnitudeThreshold: 1 })).toThrow()
    expect(() => encodeCustomMarkerRules({ enabled: 1 as unknown as boolean, lane: 0, meanMagnitudeThreshold: 1 })).toThrow()
  })
})
