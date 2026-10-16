import { getAudioMimeType } from '../audioUtils'

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

function ascii(value: string): number[] {
  return Array.from(value, character => character.charCodeAt(0))
}

describe('getAudioMimeType content sniffing', () => {
  it('recognizes an MPEG frame even when the filename ends in .wav', () => {
    // Rec07's observed frame prefix: ff f3 c8 04 (MPEG audio, Layer III).
    expect(getAudioMimeType('Rec07.wav', toBase64([0xff, 0xf3, 0xc8, 0x04]))).toBe('audio/mpeg')
  })

  it('recognizes a real RIFF/WAVE header', () => {
    const header = [...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WAVEfmt ')]
    expect(getAudioMimeType('recording.mp3', toBase64(header))).toBe('audio/wav')
  })

  it('falls back to the extension for unsupported and truncated headers', () => {
    expect(getAudioMimeType('recording.mp3', toBase64(ascii('RIFF')))).toBe('audio/mpeg')
    expect(getAudioMimeType('recording.wav', toBase64(ascii('junk')))).toBe('audio/wav')
    expect(getAudioMimeType('recording.mp3', '!invalid!')).toBe('audio/mpeg')
  })

  it('rejects malformed MPEG sync candidates and keeps the extension fallback', () => {
    expect(getAudioMimeType('recording.wav', toBase64([0xff, 0xf3, 0xf8, 0x04]))).toBe('audio/wav')
  })

  it.each([
    ['audio/ogg', [...ascii('OggS'), 0x00]],
    ['audio/flac', ascii('fLaC')],
    ['audio/webm', [0x1a, 0x45, 0xdf, 0xa3]],
    ['audio/mp4', [...ascii('....ftyp'), 0x00, 0x00, 0x00, 0x00]],
  ])('recognizes bounded container signatures as %s', (mimeType, bytes) => {
    expect(getAudioMimeType('recording.unknown', toBase64(bytes))).toBe(mimeType)
  })
})
