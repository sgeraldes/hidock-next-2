/**
 * True recording length, read from the audio file itself (2026-09-22).
 *
 * Why this exists. `recordings.duration_seconds` was never a measurement.
 * backfillRecordingDurations filled it from the device cache, and when that
 * had nothing (it holds zero durations in the owner's database) it fell back
 * to the last transcript segment end, which its own comment calls a lower
 * bound. Measured over the owner's 2,080 on-disk recordings on 2026-09-22:
 * 1,058 carried a wrong duration, 888 understated by 317 hours in total, and
 * 133 had no duration at all. The duration gate in value-thresholds.ts rates
 * recordings by length, so it was rating half the library on numbers that came
 * out of a transcript rather than an audio file.
 *
 * What the files actually are. Every audio file this app stores is an MPEG
 * Layer III stream, whatever the name says: `.wav`, `.hda` and `.mp3` all
 * carry one. Older captures wrap it in a RIFF container whose `fmt ` chunk
 * declares 16-bit PCM at 16 kHz, which is a lie — the bytes right after the
 * `data` header are MPEG frame syncs. Anything that believes the container,
 * ffprobe included, reports exactly a quarter of the real length, because
 * 32,000 declared PCM bytes per second stand in for 8,000 real MPEG ones.
 * Verified by extracting one file's payload and probing it alone: the whole
 * file reads as 116.2 s, the payload as 464.7 s, and that recording's own
 * transcript runs past the shorter figure.
 *
 * So the bytes decide, not the declaration: find the payload, and if it opens
 * on an MPEG frame, measure it as MPEG. PCM arithmetic is the fallback for a
 * container that turns out to be telling the truth.
 *
 * Variable bitrate. The app's own "split recording" feature writes its parts
 * as VBR MP3 with a Xing header, averaging 47-49 kbps. Measuring those from the
 * first frame's bitrate read them a third short, and the duration backfill then
 * flagged all seven parts in the owner's library as truncated downloads — the
 * transcript, correctly, ran past a length the file never had. A Xing, Info or
 * VBRI header states the exact frame count, so when one is present it decides.
 */

import { openSync, readSync, closeSync, statSync } from 'fs'

/** How much of the front of a file to read while looking for the payload. */
const HEADER_BYTES = 64 * 1024

/** How far into the payload to look for the first frame sync. */
const SYNC_SEARCH_BYTES = 4096

/** Bitrate tables in kbps, indexed by the frame header's bitrate field. */
const MPEG1_LAYER1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
const MPEG1_LAYER2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_LAYER1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
const MPEG2_LAYER23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/** Sample rates in Hz, indexed by [version field][rate field]. */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
}

interface MpegFrame {
  /** Bitrate in kbps. */
  kbps: number
  /** Sample rate in Hz. */
  hz: number
  /** Frame length in bytes, used to confirm the next frame lands on a sync. */
  bytes: number
  /** Audio samples each frame carries: 384, 1152, or 576 for MPEG 2/2.5 Layer III. */
  samples: number
  /**
   * Where a Xing/Info header would start, counted from the frame's first byte:
   * after the 4-byte header and the Layer III side information, whose size
   * depends on the MPEG version and on mono versus stereo. Null for Layers I
   * and II, which do not carry one.
   */
  xingOffset: number | null
}

/** Parse an MPEG audio frame header at `offset`, or null when there is none. */
function parseFrame(buffer: Buffer, offset: number): MpegFrame | null {
  if (offset + 4 > buffer.length) return null
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null

  const versionAndLayer = buffer[offset + 1]
  const rates = buffer[offset + 2]
  const version = (versionAndLayer >> 3) & 3
  const layer = (versionAndLayer >> 1) & 3
  if (version === 1 || layer === 0) return null // both values are reserved

  const bitrateIndex = (rates >> 4) & 0xf
  const rateIndex = (rates >> 2) & 3
  const padding = (rates >> 1) & 1
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null

  const table =
    version === 3
      ? [MPEG1_LAYER3, MPEG1_LAYER2, MPEG1_LAYER1][layer - 1]
      : [MPEG2_LAYER23, MPEG2_LAYER23, MPEG2_LAYER1][layer - 1]
  const kbps = table[bitrateIndex]
  const hz = SAMPLE_RATES[version]?.[rateIndex]
  if (!kbps || !hz) return null

  const mono = ((buffer[offset + 3] >> 6) & 3) === 3
  const bits = kbps * 1000
  // Samples per frame decide the coefficient. Layer I is 384 (and counts in
  // 4-byte slots), Layer II is 1152 in every version, and Layer III is 1152
  // under MPEG 1 but 576 under MPEG 2 and 2.5. Keying the halving on version
  // alone would halve Layer II too, and a frame length that is half the real
  // one makes findFrame's confirming sync land mid-frame and reject a stream
  // it should have read.
  const layerThree = layer === 1
  const coefficient = layerThree && version !== 3 ? 72 : 144
  const bytes =
    layer === 3
      ? (Math.floor((12 * bits) / hz) + padding) * 4
      : Math.floor((coefficient * bits) / hz) + padding
  const samples = layer === 3 ? 384 : layerThree && version !== 3 ? 576 : 1152
  const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
  return { kbps, hz, bytes, samples, xingOffset: layerThree ? 4 + sideInfo : null }
}

/** Offset of a Fraunhofer VBRI header from the frame's first byte; fixed by its spec. */
const VBRI_OFFSET = 4 + 32

/**
 * What the first frame's Xing, Info or VBRI header states about the stream: the
 * number of audio frames, and, when present, the number of bytes they occupy.
 * Null when there is no such header or it gives no frame count, which is what a
 * plain CBR stream looks like.
 */
function statedStream(
  buffer: Buffer,
  frameStart: number,
  frame: MpegFrame
): { frames: number; bytes: number | null } | null {
  if (frame.xingOffset !== null) {
    const at = frameStart + frame.xingOffset
    if (at + 8 <= buffer.length) {
      const tag = buffer.subarray(at, at + 4).toString('latin1')
      // Xing marks VBR, Info the same structure on a CBR file. The flags say
      // which optional fields follow, in order: frames (bit 0), bytes (bit 1).
      if (tag === 'Xing' || tag === 'Info') {
        const flags = buffer.readUInt32BE(at + 4)
        if ((flags & 1) === 1 && at + 12 <= buffer.length) {
          const frames = buffer.readUInt32BE(at + 8)
          const bytes = (flags & 2) === 2 && at + 16 <= buffer.length ? buffer.readUInt32BE(at + 12) : null
          if (frames > 0) return { frames, bytes: bytes && bytes > 0 ? bytes : null }
        }
      }
    }
  }
  const vbri = frameStart + VBRI_OFFSET
  if (vbri + 18 <= buffer.length && buffer.subarray(vbri, vbri + 4).toString('latin1') === 'VBRI') {
    const bytes = buffer.readUInt32BE(vbri + 10)
    const frames = buffer.readUInt32BE(vbri + 14)
    if (frames > 0) return { frames, bytes: bytes > 0 ? bytes : null }
  }
  return null
}

/**
 * The header describes the stream as it was written, and a file cut short keeps
 * its header. Believing the frame count then reports the full length of a file
 * that holds half of it — the one case the duration backfill exists to catch.
 * When the header also states its byte count and the file holds materially
 * fewer bytes, the frame count is scaled down to what is actually there.
 */
const TRUNCATION_TOLERANCE = 0.98

/**
 * First MPEG frame in `buffer`, confirmed by a second sync exactly one frame
 * later. The confirmation matters: 0xFF is a common byte, and one false
 * positive would set the bitrate for the whole file.
 */
function findFrame(buffer: Buffer): { offset: number; frame: MpegFrame } | null {
  for (let offset = 0; offset + 4 <= buffer.length; offset++) {
    const frame = parseFrame(buffer, offset)
    if (!frame) continue
    const next = offset + frame.bytes
    if (next + 4 <= buffer.length && parseFrame(buffer, next)) return { offset, frame }
  }
  return null
}

interface Payload {
  /** Byte offset where the audio data starts. */
  offset: number
  /** Byte length of the audio data. */
  size: number
  /** Declared PCM shape, when a RIFF `fmt ` chunk was present. */
  pcm?: { rate: number; channels: number; bits: number }
}

/** Locate the audio payload inside a RIFF or ID3 wrapper, or take the whole file. */
function findPayload(header: Buffer, fileSize: number): Payload {
  const riff = header.length >= 12 && header.subarray(0, 4).toString('latin1') === 'RIFF'
  if (riff && header.subarray(8, 12).toString('latin1') === 'WAVE') {
    let pcm: Payload['pcm']
    let cursor = 12
    while (cursor + 8 <= header.length) {
      const id = header.subarray(cursor, cursor + 4).toString('latin1')
      const size = header.readUInt32LE(cursor + 4)
      if (id === 'fmt ' && cursor + 24 <= header.length) {
        pcm = {
          channels: header.readUInt16LE(cursor + 10),
          rate: header.readUInt32LE(cursor + 12),
          bits: header.readUInt16LE(cursor + 22),
        }
      } else if (id === 'data') {
        const offset = cursor + 8
        // A streaming writer can leave the size field at 0 or -1; everything
        // after the header is the payload in that case.
        const declared = size === 0 || size === 0xffffffff ? fileSize - offset : size
        return { offset, size: Math.max(0, Math.min(declared, fileSize - offset)), pcm }
      }
      cursor += 8 + size + (size % 2)
    }
    return { offset: 0, size: fileSize, pcm }
  }

  if (header.length >= 10 && header.subarray(0, 3).toString('latin1') === 'ID3') {
    const tagSize =
      ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f)
    const offset = Math.min(10 + tagSize, fileSize)
    return { offset, size: fileSize - offset }
  }

  return { offset: 0, size: fileSize }
}

/** Read the first `HEADER_BYTES` of a file without loading the whole thing. */
function readHeader(path: string, fileSize: number): Buffer {
  const buffer = Buffer.alloc(Math.min(HEADER_BYTES, fileSize))
  const fd = openSync(path, 'r')
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export interface AudioDuration {
  /** Length in seconds. */
  seconds: number
  /** How it was measured, so a correction can explain itself in the log. */
  how: string
}

/**
 * Length of the audio in `path`, measured from its own bytes, or null when the
 * file is missing, empty, or in a format this cannot read (the four imported
 * FLACs in the owner's library are the known case).
 *
 * The device writes constant-bitrate MPEG, 64 kbps at 16 kHz, and for that the
 * payload size over the bitrate is exact. When the first frame carries a Xing,
 * Info or VBRI header, its frame count is used instead, which is exact for
 * variable bitrate too — the app's split parts are the case that needs it. A
 * VBR file with no such header would still read long or short; producing one
 * takes an encoder that omits the header, and none in this app does.
 */
export function readAudioDuration(path: string): AudioDuration | null {
  let fileSize: number
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0) return null
    fileSize = stat.size
  } catch {
    return null
  }

  let header: Buffer
  try {
    header = readHeader(path, fileSize)
  } catch {
    return null
  }

  const payload = findPayload(header, fileSize)
  const found = findFrame(header.subarray(payload.offset, payload.offset + SYNC_SEARCH_BYTES))
  if (found) {
    const stated = statedStream(header, payload.offset + found.offset, found.frame)
    if (stated !== null) {
      const present = payload.size - found.offset
      const truncated = stated.bytes !== null && present < stated.bytes * TRUNCATION_TOLERANCE
      const frames = truncated ? Math.floor((stated.frames * present) / stated.bytes!) : stated.frames
      return {
        seconds: (frames * found.frame.samples) / found.frame.hz,
        how: truncated
          ? `mpeg ${found.frame.hz}Hz, ${frames} of ${stated.frames} frames; the file holds ${present} of the ${stated.bytes} bytes its header states`
          : `mpeg ${found.frame.hz}Hz, ${frames} frames from the stream header`,
      }
    }
    const bytes = payload.size - found.offset
    if (bytes <= 0) return null
    return {
      seconds: (bytes * 8) / (found.frame.kbps * 1000),
      how: `mpeg ${found.frame.kbps}kbps/${found.frame.hz}Hz`,
    }
  }

  const pcm = payload.pcm
  if (pcm && pcm.rate > 0 && pcm.channels > 0 && pcm.bits >= 8) {
    const bytesPerSecond = pcm.rate * pcm.channels * Math.floor(pcm.bits / 8)
    if (bytesPerSecond > 0) {
      return { seconds: payload.size / bytesPerSecond, how: `pcm ${pcm.rate}Hz/${pcm.channels}ch` }
    }
  }

  return null
}
