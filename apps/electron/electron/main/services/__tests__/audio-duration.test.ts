/**
 * readAudioDuration — the length of a recording, read from its own bytes.
 *
 * The fixtures here are built rather than checked in: an MPEG frame header is
 * four bytes of bitfields, and writing them out in the test is what makes the
 * expected duration checkable by hand. Every case matches a real shape in the
 * owner's library, including the one that motivated the module — a RIFF
 * container whose `fmt ` chunk declares PCM over an MPEG payload.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readAudioDuration } from '../audio-duration'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hidock-audio-duration-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * One MPEG-2 Layer III frame header at 64 kbps / 16 kHz — the device's format.
 * 0xFF 0xF3: sync, version 2, layer III, no CRC. 0x88: bitrate index 8 (64
 * kbps), rate index 2 (16 kHz), no padding. 0xC4: channel mode and flags,
 * which the duration does not read.
 */
const FRAME_64K_16K = Buffer.from([0xff, 0xf3, 0x88, 0xc4])

/** Frame length for that shape: 72 * 64000 / 16000 = 288 bytes. */
const FRAME_64K_16K_BYTES = 288

/** `frames` back-to-back frames, each with its header and silent payload. */
function mpegStream(frames: number): Buffer {
  const out = Buffer.alloc(frames * FRAME_64K_16K_BYTES)
  for (let i = 0; i < frames; i++) FRAME_64K_16K.copy(out, i * FRAME_64K_16K_BYTES)
  return out
}

/** A RIFF/WAVE wrapper whose `fmt ` chunk describes 16-bit mono PCM at 16 kHz. */
function riffWrap(payload: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + payload.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16) // chunk size
  header.writeUInt16LE(1, 20) // format tag: PCM
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(16000, 24) // sample rate
  header.writeUInt32LE(32000, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(payload.length, 40)
  return Buffer.concat([header, payload])
}

function write(name: string, data: Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

describe('readAudioDuration', () => {
  it('measures a bare MPEG stream from its bitrate', () => {
    // 1000 frames * 288 bytes = 288,000 bytes at 8,000 bytes per second.
    const path = write('bare.mp3', mpegStream(1000))
    const result = readAudioDuration(path)
    expect(result?.seconds).toBeCloseTo(36, 3)
    expect(result?.how).toBe('mpeg 64kbps/16000Hz')
  })

  it('measures the MPEG payload inside a container that claims PCM', () => {
    // This is the shape that made the whole library read a quarter short: the
    // same 288,000 bytes are 36 s of MPEG and would be 9 s of the declared PCM.
    const path = write('lying.wav', riffWrap(mpegStream(1000)))
    const result = readAudioDuration(path)
    expect(result?.seconds).toBeCloseTo(36, 3)
    expect(result?.how).toBe('mpeg 64kbps/16000Hz')
  })

  it('believes a container that is telling the truth', () => {
    // 32,000 bytes of real PCM at 32,000 bytes per second is one second.
    const path = write('honest.wav', riffWrap(Buffer.alloc(32000)))
    const result = readAudioDuration(path)
    expect(result?.seconds).toBeCloseTo(1, 6)
    expect(result?.how).toBe('pcm 16000Hz/1ch')
  })

  it('skips an ID3 tag before looking for the first frame', () => {
    const tag = Buffer.alloc(2058) // 10-byte header + 2048 bytes of tag
    tag.write('ID3', 0, 'latin1')
    tag[3] = 3
    tag[9] = 2048 & 0x7f
    tag[8] = (2048 >> 7) & 0x7f
    const path = write('tagged.mp3', Buffer.concat([tag, mpegStream(500)]))
    const result = readAudioDuration(path)
    expect(result?.seconds).toBeCloseTo(18, 3)
  })

  it('takes the payload size from the file when the container leaves it blank', () => {
    const wrapped = riffWrap(mpegStream(1000))
    wrapped.writeUInt32LE(0, 40) // a streaming writer that never went back
    const path = write('unfinished.wav', wrapped)
    expect(readAudioDuration(path)?.seconds).toBeCloseTo(36, 3)
  })

  it('does not lock onto a lone 0xFF byte that looks like a sync', () => {
    // One plausible header with nothing behind it must not set the bitrate for
    // a whole file of silence.
    const noise = Buffer.alloc(32000)
    FRAME_64K_16K.copy(noise, 100)
    const path = write('false-sync.wav', riffWrap(noise))
    const result = readAudioDuration(path)
    expect(result?.how).toBe('pcm 16000Hz/1ch')
  })

  it('reads an MPEG-2 Layer II stream, whose frames do not halve', () => {
    // Layer II carries 1152 samples per frame in every MPEG version; only
    // Layer III halves to 576 under MPEG 2 and 2.5. Keying the coefficient on
    // version alone computed 104-byte frames for this stream instead of 208,
    // so the confirming sync landed mid-frame and the file read as unreadable.
    //
    // 0xFF 0xF5: sync, MPEG 2, Layer II, no CRC. 0x40: bitrate index 4
    // (32 kbps for MPEG-2 Layer II), rate index 0 (22050 Hz), no padding.
    // Frame length is floor(144 * 32000 / 22050) = 208 bytes.
    const FRAME = Buffer.from([0xff, 0xf5, 0x40, 0xc4])
    const BYTES = 208
    const frames = 5
    const data = Buffer.alloc(frames * BYTES)
    for (let i = 0; i < frames; i++) FRAME.copy(data, i * BYTES)

    const result = readAudioDuration(write('layer2.mp3', data))

    expect(result?.how).toBe('mpeg 32kbps/22050Hz')
    // 1040 bytes at 4000 bytes per second.
    expect(result?.seconds).toBeCloseTo(0.26, 3)
  })

  it('reads the exact frame count from a Xing header, whatever the bytes suggest', () => {
    // The app's split parts are VBR MP3 averaging ~48 kbps while their first
    // frame says 64. Measured from that first frame they read a third short,
    // and all seven in the owner's library were flagged as truncated. The Xing
    // header states the frame count, so it decides.
    //
    // MPEG-2 Layer III mono: 576 samples per frame at 16 kHz, and the Xing
    // header sits after the 4-byte frame header and 9 bytes of side info.
    const stream = mpegStream(100)
    stream.write('Xing', 13, 'latin1')
    stream.writeUInt32BE(1, 17) // flags: frame count present
    stream.writeUInt32BE(2500, 21) // 2500 frames * 576 / 16000 = 90 s
    const result = readAudioDuration(write('split-part.mp3', stream))
    expect(result?.seconds).toBeCloseTo(90, 6)
    expect(result?.how).toContain('2500 frames')
  })

  it('reads an Info header the same way, which is Xing on a constant-bitrate file', () => {
    const stream = mpegStream(100)
    stream.write('Info', 13, 'latin1')
    stream.writeUInt32BE(1, 17)
    stream.writeUInt32BE(1000, 21) // 36 s
    expect(readAudioDuration(write('info.mp3', stream))?.seconds).toBeCloseTo(36, 6)
  })

  it('reads a VBRI header, the other encoder convention', () => {
    const stream = mpegStream(100)
    stream.write('VBRI', 36, 'latin1')
    stream.writeUInt32BE(5000, 36 + 14) // 5000 * 576 / 16000 = 180 s
    expect(readAudioDuration(write('vbri.mp3', stream))?.seconds).toBeCloseTo(180, 6)
  })

  it('scales the stated frame count down when the file holds fewer bytes than the header says', () => {
    // A file cut short keeps its header. Believing the frame count reported
    // the full length of a file that held half of it — the reviewer produced
    // exactly that with a copy of a real split part truncated to half.
    const stream = mpegStream(100) // 28,800 bytes present
    stream.write('Xing', 13, 'latin1')
    stream.writeUInt32BE(1 | 2, 17) // frames and bytes present
    stream.writeUInt32BE(2500, 21) // 2500 frames = 90 s
    stream.writeUInt32BE(57600, 25) // the header says 57,600 bytes: this file is half of it
    const result = readAudioDuration(write('truncated-vbr.mp3', stream))
    expect(result?.seconds).toBeCloseTo(45, 0)
    expect(result?.how).toContain('1250 of 2500 frames')
  })

  it('trusts the frame count when the stated byte count matches the file', () => {
    const stream = mpegStream(100)
    stream.write('Xing', 13, 'latin1')
    stream.writeUInt32BE(1 | 2, 17)
    stream.writeUInt32BE(2500, 21)
    stream.writeUInt32BE(28800, 25) // exactly what is on disk
    expect(readAudioDuration(write('intact-vbr.mp3', stream))?.seconds).toBeCloseTo(90, 6)
  })

  it('ignores a Xing header that does not state a frame count', () => {
    // Flags without bit 0: nothing to read, so fall back to the bitrate.
    const stream = mpegStream(1000)
    stream.write('Xing', 13, 'latin1')
    stream.writeUInt32BE(0, 17)
    const result = readAudioDuration(write('xing-no-count.mp3', stream))
    expect(result?.seconds).toBeCloseTo(36, 3)
    expect(result?.how).toBe('mpeg 64kbps/16000Hz')
  })

  it('finds the Xing header inside a RIFF container too', () => {
    const stream = mpegStream(100)
    stream.write('Xing', 13, 'latin1')
    stream.writeUInt32BE(1, 17)
    stream.writeUInt32BE(2500, 21)
    expect(readAudioDuration(write('xing-in-riff.wav', riffWrap(stream)))?.seconds).toBeCloseTo(90, 6)
  })

  it('returns null for a file it cannot read', () => {
    expect(readAudioDuration(join(dir, 'does-not-exist.wav'))).toBeNull()
    expect(readAudioDuration(write('empty.wav', Buffer.alloc(0)))).toBeNull()
    expect(readAudioDuration(write('garbage.flac', Buffer.from('fLaC-but-not-really')))).toBeNull()
  })

  it('returns null for a directory', () => {
    const sub = join(dir, 'a-directory.wav')
    mkdirSync(sub, { recursive: true })
    expect(readAudioDuration(sub)).toBeNull()
  })
})
