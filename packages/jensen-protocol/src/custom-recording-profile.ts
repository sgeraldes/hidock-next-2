/** Experimental REA build contract; unavailable on official H1E firmware. */
export const CUSTOM_RECORDING_PROFILE_GET = 0xf111
export const CUSTOM_RECORDING_PROFILE_SET = 0xf110
export interface CustomRecordingProfile {
  profile: 0 | 1 | 2 | 3
  gainLeftQ15: number
  gainRightQ15: number
}
export interface CustomRecordingProfileResponse extends CustomRecordingProfile {
  /** Fallback does not distinguish a missing key from corrupt/unreadable storage. */
  storage: 'stored' | 'fallback'
}
export const CUSTOM_RECORDING_BITRATES = [64, 96, 128, 160] as const

export function encodeCustomRecordingProfile(profile: CustomRecordingProfile): Uint8Array {
  if (!profile || !Number.isInteger(profile.profile) || profile.profile < 0 || profile.profile > 3 ||
      ![profile.gainLeftQ15, profile.gainRightQ15].every(value => Number.isInteger(value) && value >= 0 && value <= 65536)) {
    throw new Error('Invalid experimental recording profile or Q15 gain')
  }
  const body = new Uint8Array(16)
  body.set([0x52, 0x45, 0x41, 0x31, profile.profile])
  const view = new DataView(body.buffer)
  view.setUint32(8, profile.gainLeftQ15, false)
  view.setUint32(12, profile.gainRightQ15, false)
  return body
}

export function parseCustomRecordingProfile(body: Uint8Array): CustomRecordingProfile | null {
  if (body.length !== 16 || body[0] !== 0x52 || body[1] !== 0x45 || body[2] !== 0x41 || body[3] !== 0x31 ||
      body[4] > 3 || body[5] !== 0 || body[6] !== 0 || body[7] !== 0) return null
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const gainLeftQ15 = view.getUint32(8, false), gainRightQ15 = view.getUint32(12, false)
  if (gainLeftQ15 > 65536 || gainRightQ15 > 65536) return null
  return { profile: body[4] as 0 | 1 | 2 | 3, gainLeftQ15, gainRightQ15 }
}

export function parseCustomRecordingProfileResponse(body: Uint8Array): CustomRecordingProfileResponse | null {
  if (body.length !== 17 || body[0] > 1) return null
  const profile = parseCustomRecordingProfile(body.subarray(1))
  return profile ? { ...profile, storage: body[0] === 0 ? 'stored' : 'fallback' } : null
}
