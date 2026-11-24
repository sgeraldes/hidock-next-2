import { describe, expect, it } from 'vitest'
import { encodeCustomRecordingFormat, parseCustomRecordingFormat, parseCustomRecordingFormatResponse } from '../src/custom-recording-format.js'

describe('optional REF1 native format contract', () => {
  it.each(['mp3', 'wav'] as const)('round trips %s with exact bytes', format => {
    const bytes = encodeCustomRecordingFormat(format)
    expect(Array.from(bytes)).toEqual([82, 69, 70, 49, format === 'wav' ? 1 : 0, 0, 0, 0])
    expect(parseCustomRecordingFormat(bytes)).toBe(format)
    expect(parseCustomRecordingFormatResponse(Uint8Array.of(0, ...bytes))).toEqual({ format, storage: 'stored' })
    expect(parseCustomRecordingFormatResponse(Uint8Array.of(1, ...bytes))).toEqual({ format, storage: 'fallback' })
  })
  it.each(Array.from({ length: 8 }, (_, i) => i))('rejects corrupt field %i', offset => {
    const bytes = encodeCustomRecordingFormat('mp3')
    bytes[offset] = offset === 4 ? 2 : bytes[offset] ^ 1
    expect(parseCustomRecordingFormat(bytes)).toBeNull()
  })
  it.each([0, 1, 7, 9, 16])('rejects dishonest record length %i', length => {
    expect(parseCustomRecordingFormat(new Uint8Array(length))).toBeNull()
  })
  it('rejects unqualified responses and invalid caller formats', () => {
    expect(parseCustomRecordingFormatResponse(Uint8Array.of(2, ...encodeCustomRecordingFormat('wav')))).toBeNull()
    expect(parseCustomRecordingFormatResponse(encodeCustomRecordingFormat('wav'))).toBeNull()
    expect(() => encodeCustomRecordingFormat('pcm' as 'mp3')).toThrow()
  })
})
