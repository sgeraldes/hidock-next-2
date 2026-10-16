import { describe, expect, it } from 'vitest'
import { encodeCustomRecordingProfile, parseCustomRecordingProfile, parseCustomRecordingProfileResponse } from '../src/custom-recording-profile.js'

describe('experimental REA profile serialization', () => {
  it.each([0, 1, 2, 3] as const)('encodes profile%i with exact magic, reserved bytes and big endian gains', profile => {
    const value = { profile, gainLeftQ15: 32768, gainRightQ15: 65536 }
    const body = encodeCustomRecordingProfile(value)
    expect(Array.from(body)).toEqual([82, 69, 65, 49, profile, 0, 0, 0, 0, 0, 128, 0, 0, 1, 0, 0])
    expect(parseCustomRecordingProfile(body)).toEqual(value)
    const reused = new Uint8Array(20)
    reused.set(body, 2)
    expect(parseCustomRecordingProfile(reused.subarray(2, 18))).toEqual(value)
  })

  it.each([0, 1, 2, 3, 4, 8, 15, 17, 32])('rejects wrong payload length%i', length => {
    expect(parseCustomRecordingProfile(new Uint8Array(length))).toBeNull()
  })

  it('rejects bad magic, reserved bits, unknown profile and out of range gain', () => {
    const complete = encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })
    for (const offset of [0, 1, 2, 3, 5, 6, 7, 8, 12]) {
      const bad = complete.slice()
      bad[offset] ^= 255
      expect(parseCustomRecordingProfile(bad)).toBeNull()
    }
    complete[4] = 4
    expect(parseCustomRecordingProfile(complete)).toBeNull()
  })

  it.each([-1, 65537, 1.5, NaN, Infinity])('rejects invalid gain %s without constructing a packet', gain => {
    expect(() => encodeCustomRecordingProfile({ profile: 0, gainLeftQ15: gain, gainRightQ15: 32768 })).toThrow()
    expect(() => encodeCustomRecordingProfile({ profile: 0, gainLeftQ15: 32768, gainRightQ15: gain })).toThrow()
  })

  it('distinguishes reported stored config from an explicit effective-default fallback', () => {
    const record = encodeCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })
    expect(parseCustomRecordingProfileResponse(Uint8Array.of(0, ...record))).toMatchObject({ profile: 2, storage: 'stored' })
    expect(parseCustomRecordingProfileResponse(Uint8Array.of(1, ...record))).toMatchObject({ profile: 2, storage: 'fallback' })
    expect(parseCustomRecordingProfileResponse(record)).toBeNull()
    expect(parseCustomRecordingProfileResponse(Uint8Array.of(2, ...record))).toBeNull()
    expect(parseCustomRecordingProfileResponse(Uint8Array.of(0, ...record, 0))).toBeNull()
  })
})
