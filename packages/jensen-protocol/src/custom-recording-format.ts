/** Optional native WAV extension. Capability must be queried before mutation. */
export const CUSTOM_RECORDING_FORMAT_SET = 0xf113
export const CUSTOM_RECORDING_FORMAT_GET = 0xf114
export type CustomRecordingFormat = 'mp3' | 'wav'
export interface CustomRecordingFormatResponse {
  format: CustomRecordingFormat
  storage: 'stored' | 'fallback'
}

export function encodeCustomRecordingFormat(format: CustomRecordingFormat): Uint8Array {
  if (format !== 'mp3' && format !== 'wav') throw new Error('Invalid experimental recording format')
  return Uint8Array.of(82, 69, 70, 49, format === 'wav' ? 1 : 0, 0, 0, 0)
}

export function parseCustomRecordingFormat(body: Uint8Array): CustomRecordingFormat | null {
  if (body.length !== 8 || body[0] !== 82 || body[1] !== 69 || body[2] !== 70 || body[3] !== 49 ||
      body[4] > 1 || body[5] !== 0 || body[6] !== 0 || body[7] !== 0) return null
  return body[4] === 1 ? 'wav' : 'mp3'
}

export function parseCustomRecordingFormatResponse(body: Uint8Array): CustomRecordingFormatResponse | null {
  if (body.length !== 9 || body[0] > 1) return null
  const format = parseCustomRecordingFormat(body.subarray(1))
  return format ? { format, storage: body[0] === 0 ? 'stored' : 'fallback' } : null
}
