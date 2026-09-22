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

  const bits = kbps * 1000
  const bytes =
    layer === 3
      ? (Math.floor((12 * bits) / hz) + padding) * 4 // Layer I counts 4-byte slots
      : Math.floor(((version === 3 ? 144 : 72) * bits) / hz) + padding
  return { kbps, hz, bytes }
}

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
 * MPEG duration assumes a constant bitrate, which is what this app's device
 * writes — every one of the 2,080 measured files is a flat 64 kbps at 16 kHz.
 * A variable-bitrate import would read long or short here; nothing in the
 * library is one today, and the alternative is walking every frame of a 28 MB
 * file on every scan.
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
