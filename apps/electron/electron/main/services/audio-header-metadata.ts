import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'

// Standalone main-process utility. Never infers the physical format from a file
// name: only bytes in a bounded prefix decide. Every field is either known with a
// provenance, or unknown with a reason.

export const MAX_PREFIX_BYTES = 64 * 1024
export const MAX_SYNC_SCAN_BYTES = 4096
const MAX_RIFF_CHUNKS = 64
const MIN_MPEG_FRAME_BYTES = 24

export type Provenance =
  | 'riff-fmt-chunk'
  | 'riff-data-chunk'
  | 'mpeg-frame-header'
  | 'xing-header'
  | 'vbri-header'
  | 'derived-header-bytes-and-frames'
  | 'derived-file-size-and-frames'

export interface KnownField<T> {
  known: true
  value: T
  provenance: Provenance
}
export interface UnknownField {
  known: false
  reason: string
}
export type Field<T> = KnownField<T> | UnknownField

export interface FormatFields {
  container: Field<'riff-wave' | 'mpeg-audio'>
  codec: Field<'pcm_s16le' | 'mp3'>
  channelCount: Field<1 | 2>
  sampleRateHz: Field<number>
  bitDepth: Field<16>
  /** WAV: exact byte rate * 8. MP3: bitrate of the first verified frame only. */
  nominalBitrateBps: Field<number>
  /** WAV: equals nominal (PCM). MP3: only when a verified frame count gives a duration. */
  averageBitrateBps: Field<number>
  bitrateMode: Field<'constant' | 'variable'>
  durationMs: Field<number>
}

export type ParseStatus = 'verified' | 'unverified' | 'truncated' | 'invalid' | 'unsupported'
export type ReadStatus = ParseStatus | 'source-changed' | 'error'

export interface ParsedHeader {
  status: ParseStatus
  statusReason: string | null
  fields: FormatFields
}

export interface AudioHeaderIo {
  maxPrefixBytes: number
  prefixBytesRequested: number
  prefixBytesRead: number
  readCalls: number
  handleOpened: boolean
  handleClosed: boolean
}

export interface AudioHeaderMetadata extends FormatFields {
  status: ReadStatus
  statusReason: string | null
  /** Size of the file from the open handle, null when the file could not be stat'ed. */
  byteLength: number | null
  source: { sizeBytes: number; mtimeNs: string } | null
  io: AudioHeaderIo
}

export interface AudioFileHandle {
  stat(): Promise<BigIntStats>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
export interface AudioFsApi {
  stat(path: string): Promise<BigIntStats>
  open(path: string): Promise<AudioFileHandle>
}

const defaultFs: AudioFsApi = {
  stat: (path) => fsStat(path, { bigint: true }),
  open: async (path) => {
    const handle = await fsOpen(path, 'r')
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close()
    }
  }
}

const known = <T>(value: T, provenance: Provenance): KnownField<T> => ({ known: true, value, provenance })
const unknown = (reason: string): UnknownField => ({ known: false, reason })

function unknownFields(reason: string): FormatFields {
  const u = unknown(reason)
  return {
    container: u,
    codec: u,
    channelCount: u,
    sampleRateHz: u,
    bitDepth: u,
    nominalBitrateBps: u,
    averageBitrateBps: u,
    bitrateMode: u,
    durationMs: u
  }
}

const result = (status: ParseStatus, statusReason: string | null, fields: FormatFields): ParsedHeader => ({
  status,
  statusReason,
  fields
})

const roundMs = (value: number): number => Math.round(value * 1000) / 1000

function ascii(p: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(p[offset + i])
  return out
}

const u16le = (p: Uint8Array, o: number): number => p[o] | (p[o + 1] << 8)
const u32le = (p: Uint8Array, o: number): number => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0
const u32be = (p: Uint8Array, o: number): number => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

interface WavFmt {
  channels: 1 | 2
  sampleRate: number
  byteRate: number
}

function parseWav(p: Uint8Array, fileSize: number, prefixComplete: boolean): ParsedHeader {
  if (p.length < 12) return result('truncated', 'RIFF header is cut by the end of the file', unknownFields('RIFF header truncated'))

  const riffEnd = 8 + u32le(p, 4)
  const riffClaimsPastEof = riffEnd > fileSize

  let off = 12
  let fmt: WavFmt | null = null
  let data: { body: number; size: number } | null = null
  let ranOutOfPrefix = false
  let chunkClaimPastEof = false
  let exhausted = true

  for (let i = 0; i < MAX_RIFF_CHUNKS; i++) {
    if (off + 8 > p.length) {
      ranOutOfPrefix = true
      exhausted = false
      break
    }
    const id = ascii(p, off, 4)
    const size = u32le(p, off + 4)
    const body = off + 8
    const chunkEnd = body + size

    if (id === 'fmt ') {
      if (size < 16) return result('invalid', 'fmt chunk smaller than 16 bytes', unknownFields('invalid fmt chunk'))
      if (chunkEnd > fileSize) {
        chunkClaimPastEof = true
        exhausted = false
        break
      }
      if (chunkEnd > p.length) {
        ranOutOfPrefix = true
        exhausted = false
        break
      }
      const tag = u16le(p, body)
      const channels = u16le(p, body + 2)
      const sampleRate = u32le(p, body + 4)
      const byteRate = u32le(p, body + 8)
      const blockAlign = u16le(p, body + 12)
      const bits = u16le(p, body + 14)
      const container = known('riff-wave' as const, 'riff-fmt-chunk' as const)
      const unsupported = (why: string): ParsedHeader =>
        result('unsupported', why, { ...unknownFields(why), container })
      if (tag !== 1) return unsupported(`WAVE format tag ${tag} is not integer PCM`)
      if (bits !== 16) return unsupported(`PCM bit depth ${bits} is not 16`)
      if (channels !== 1 && channels !== 2) return unsupported(`PCM channel count ${channels} is not mono/stereo`)
      if (sampleRate < 1 || sampleRate > 384000) return result('invalid', `sample rate ${sampleRate} out of range`, unknownFields('invalid fmt chunk'))
      if (blockAlign !== channels * 2) return result('invalid', 'fmt blockAlign does not match channels * 2', unknownFields('invalid fmt chunk'))
      if (byteRate !== sampleRate * blockAlign) return result('invalid', 'fmt byteRate does not match sampleRate * blockAlign', unknownFields('invalid fmt chunk'))
      fmt = { channels, sampleRate, byteRate }
    } else if (id === 'data') {
      if (!fmt) return result('invalid', 'data chunk appears before fmt chunk', unknownFields('data before fmt'))
      data = { body, size }
      exhausted = false
      break
    } else if (chunkEnd > fileSize) {
      chunkClaimPastEof = true
      exhausted = false
      break
    }
    off = chunkEnd + (size & 1)
  }

  if (!fmt) {
    if (exhausted) return result('invalid', `no fmt chunk within ${MAX_RIFF_CHUNKS} chunks`, unknownFields('no fmt chunk'))
    if (chunkClaimPastEof || (ranOutOfPrefix && prefixComplete)) {
      return result('truncated', 'file ends before a complete fmt chunk', unknownFields('fmt chunk truncated'))
    }
    return result('unverified', 'fmt chunk lies beyond the bounded prefix', unknownFields('fmt chunk beyond prefix'))
  }

  const bitrate = fmt.byteRate * 8
  const base: FormatFields = {
    container: known('riff-wave', 'riff-fmt-chunk'),
    codec: known('pcm_s16le', 'riff-fmt-chunk'),
    channelCount: known(fmt.channels, 'riff-fmt-chunk'),
    sampleRateHz: known(fmt.sampleRate, 'riff-fmt-chunk'),
    bitDepth: known(16, 'riff-fmt-chunk'),
    nominalBitrateBps: known(bitrate, 'riff-fmt-chunk'),
    averageBitrateBps: known(bitrate, 'riff-fmt-chunk'),
    bitrateMode: known('constant', 'riff-fmt-chunk'),
    durationMs: unknown('data chunk not verified')
  }
  const withDuration = (durationMs: Field<number>): FormatFields => ({ ...base, durationMs })

  if (!data) {
    if (chunkClaimPastEof || (ranOutOfPrefix && prefixComplete)) {
      return result('truncated', 'file ends before the data chunk header', withDuration(unknown('data chunk missing at end of file')))
    }
    if (exhausted) return result('invalid', `no data chunk within ${MAX_RIFF_CHUNKS} chunks`, withDuration(unknown('no data chunk')))
    return result('verified', null, withDuration(unknown('data chunk lies beyond the bounded prefix')))
  }

  const available = fileSize - data.body
  if (riffClaimsPastEof) {
    return result('truncated', `RIFF size claims ${riffEnd} bytes but the file has ${fileSize}`, withDuration(unknown('RIFF size claim exceeds the file')))
  }
  if (data.size > available) {
    return result('truncated', `data chunk claims ${data.size} bytes but only ${available} are in the file`, withDuration(unknown('data chunk claim exceeds the file')))
  }
  if (data.body + data.size > riffEnd) {
    return result('invalid', 'data chunk extends past the RIFF size', withDuration(unknown('data chunk exceeds RIFF size')))
  }
  // Older HiDock files can declare PCM while carrying MPEG frames in data.
  // Require two matching frames at the payload boundary before overriding fmt.
  const payload = p.subarray(data.body, Math.min(p.length, data.body + data.size))
  const firstMpeg = parseMpegFrame(payload, 0)
  const secondMpeg = firstMpeg && parseMpegFrame(payload, firstMpeg.frameLength)
  if (firstMpeg && secondMpeg && sameStream(firstMpeg, secondMpeg)) {
    const mpeg = verifiedMpeg(payload, 0, firstMpeg, data.size)
    return { ...mpeg, fields: { ...mpeg.fields, container: known('riff-wave', 'riff-fmt-chunk') } }
  }
  const blockAlign = fmt.channels * 2
  if (data.size % blockAlign !== 0) {
    return result('invalid', 'data chunk size is not a whole number of sample frames', withDuration(unknown('data size not frame aligned')))
  }
  const frames = data.size / blockAlign
  return result('verified', null, withDuration(known(roundMs((frames * 1000) / fmt.sampleRate), 'riff-data-chunk')))
}

// ---------------------------------------------------------------------------
// MPEG audio (Layer III)
// ---------------------------------------------------------------------------

const MPEG1_L3_BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_L3_BITRATES_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000]
}

interface MpegFrame {
  version: number
  mpeg1: boolean
  channels: 1 | 2
  sampleRate: number
  bitrateBps: number
  samplesPerFrame: number
  frameLength: number
  hasCrc: boolean
}

function parseMpegFrame(p: Uint8Array, i: number): MpegFrame | null {
  if (i + 4 > p.length || p[i] !== 0xff || (p[i + 1] & 0xe0) !== 0xe0) return null
  const version = (p[i + 1] >> 3) & 3
  const layer = (p[i + 1] >> 1) & 3
  if (version === 1 || layer !== 1) return null
  const bitrateIdx = (p[i + 2] >> 4) & 0xf
  const rateIdx = (p[i + 2] >> 2) & 3
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null
  const mpeg1 = version === 3
  const bitrateBps = (mpeg1 ? MPEG1_L3_BITRATES_KBPS : MPEG2_L3_BITRATES_KBPS)[bitrateIdx] * 1000
  const sampleRate = SAMPLE_RATES[version][rateIdx]
  const padding = (p[i + 2] >> 1) & 1
  const frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrateBps) / sampleRate) + padding
  return {
    version,
    mpeg1,
    channels: ((p[i + 3] >> 6) & 3) === 3 ? 1 : 2,
    sampleRate,
    bitrateBps,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    frameLength,
    hasCrc: (p[i + 1] & 1) === 0
  }
}

const sameStream = (a: MpegFrame, b: MpegFrame): boolean =>
  a.version === b.version && a.sampleRate === b.sampleRate && a.channels === b.channels

interface VbrInfo {
  kind: 'Xing' | 'Info' | 'VBRI'
  frames: number | null
  bytes: number | null
}

function readVbrInfo(p: Uint8Array, at: number, frame: MpegFrame): VbrInfo | null {
  const frameEnd = Math.min(at + frame.frameLength, p.length)
  const sideInfo = frame.mpeg1 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17
  const xingAt = at + 4 + (frame.hasCrc ? 2 : 0) + sideInfo
  if (xingAt + 8 <= frameEnd) {
    const tag = ascii(p, xingAt, 4)
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32be(p, xingAt + 4)
      let pos = xingAt + 8
      let frames: number | null = null
      let bytes: number | null = null
      if (flags & 1 && pos + 4 <= frameEnd) {
        frames = u32be(p, pos)
        pos += 4
      }
      if (flags & 2 && pos + 4 <= frameEnd) bytes = u32be(p, pos)
      return { kind: tag, frames, bytes }
    }
  }
  const vbriAt = at + 36
  if (vbriAt + 18 <= frameEnd && ascii(p, vbriAt, 4) === 'VBRI') {
    return { kind: 'VBRI', bytes: u32be(p, vbriAt + 10), frames: u32be(p, vbriAt + 14) }
  }
  return null
}

function verifiedMpeg(p: Uint8Array, at: number, frame: MpegFrame, fileSize: number): ParsedHeader {
  const fields: FormatFields = {
    container: known('mpeg-audio', 'mpeg-frame-header'),
    codec: known('mp3', 'mpeg-frame-header'),
    channelCount: known(frame.channels, 'mpeg-frame-header'),
    sampleRateHz: known(frame.sampleRate, 'mpeg-frame-header'),
    bitDepth: unknown('MP3 is lossy; PCM bit depth is not defined'),
    nominalBitrateBps: known(frame.bitrateBps, 'mpeg-frame-header'),
    averageBitrateBps: unknown('no verified frame count; the first-frame bitrate is not an average'),
    bitrateMode: unknown('a single frame header cannot prove constant or variable bitrate'),
    durationMs: unknown('no Xing/VBRI frame count; duration is not guessed from size and first-frame bitrate')
  }
  const vbr = readVbrInfo(p, at, frame)
  if (!vbr) return result('verified', null, fields)

  const provenance: Provenance = vbr.kind === 'VBRI' ? 'vbri-header' : 'xing-header'
  fields.bitrateMode = known(vbr.kind === 'Info' ? 'constant' : 'variable', provenance)
  if (vbr.frames === null) return result('verified', null, fields)

  const plausible =
    vbr.frames >= 1 &&
    vbr.frames * MIN_MPEG_FRAME_BYTES <= fileSize &&
    (vbr.bytes === null || vbr.bytes <= fileSize)
  if (!plausible) {
    fields.durationMs = unknown(`${vbr.kind} frame count ${vbr.frames} is inconsistent with the ${fileSize}-byte file`)
    return result('verified', null, fields)
  }
  const durationMs = roundMs((vbr.frames * frame.samplesPerFrame * 1000) / frame.sampleRate)
  fields.durationMs = known(durationMs, provenance)
  const audioBytes = vbr.bytes ?? fileSize - at
  fields.averageBitrateBps = known(
    Math.round((audioBytes * 8 * 1000) / durationMs),
    vbr.bytes === null ? 'derived-file-size-and-frames' : 'derived-header-bytes-and-frames'
  )
  return result('verified', null, fields)
}

function parseMpeg(p: Uint8Array, fileSize: number, prefixComplete: boolean): ParsedHeader {
  let start = 0
  if (p.length >= 3 && ascii(p, 0, 3) === 'ID3') {
    if (p.length < 10) {
      return prefixComplete
        ? result('truncated', 'ID3v2 header is cut by the end of the file', unknownFields('ID3v2 header truncated'))
        : result('unverified', 'ID3v2 header beyond prefix', unknownFields('ID3v2 header beyond prefix'))
    }
    const sizeBytes = [p[6], p[7], p[8], p[9]]
    if (p[3] < 2 || p[3] > 4 || p[4] === 0xff || sizeBytes.some((b) => b >= 0x80)) {
      return result('invalid', 'malformed ID3v2 header', unknownFields('malformed ID3v2 header'))
    }
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3]
    start = 10 + tagSize + (p[5] & 0x10 ? 10 : 0)
    if (start + 4 > fileSize) {
      return result('truncated', 'ID3v2 tag leaves no room for an audio frame', unknownFields('ID3v2 tag exceeds the file'))
    }
    if (start + 4 > p.length) {
      return result('unverified', 'ID3v2 tag extends beyond the bounded prefix', unknownFields('first frame beyond prefix'))
    }
  }

  const last = Math.min(start + MAX_SYNC_SCAN_BYTES, p.length - 4)
  let sawIncomplete = false
  for (let i = start; i <= last; i++) {
    const frame = parseMpegFrame(p, i)
    if (!frame) continue
    const next = i + frame.frameLength
    if (next + 4 > p.length) {
      sawIncomplete = true
      continue
    }
    const second = parseMpegFrame(p, next)
    if (second && sameStream(frame, second)) return verifiedMpeg(p, i, frame, fileSize)
  }
  if (sawIncomplete) {
    if (prefixComplete) {
      const why = 'file ends before a corroborating second MPEG frame'
      return result('truncated', why, unknownFields(why))
    }
    const why = 'corroborating second MPEG frame lies beyond the bounded prefix'
    return result('unverified', why, unknownFields(why))
  }
  return result('unsupported', 'no verified MPEG audio frame sequence', unknownFields('no verified MPEG frame sequence'))
}

// ---------------------------------------------------------------------------
// Public pure parser
// ---------------------------------------------------------------------------

/** Parse a prefix (<= MAX_PREFIX_BYTES) of a file whose real size is fileSize. Pure, no I/O. */
export function parseAudioHeaderPrefix(prefix: Uint8Array, fileSize: number): ParsedHeader {
  if (prefix.length > MAX_PREFIX_BYTES) throw new RangeError(`prefix of ${prefix.length} bytes exceeds ${MAX_PREFIX_BYTES}`)
  if (!Number.isSafeInteger(fileSize) || fileSize < prefix.length) throw new RangeError('fileSize must be a safe integer >= prefix length')
  const prefixComplete = prefix.length >= fileSize
  if (prefix.length === 0) return result('unsupported', 'empty file', unknownFields('empty file'))
  if (prefix.length >= 4 && ascii(prefix, 0, 4) === 'RIFF') {
    if (prefix.length >= 12 && ascii(prefix, 8, 4) !== 'WAVE') {
      return result('unsupported', 'RIFF container is not WAVE', unknownFields('RIFF container is not WAVE'))
    }
    return parseWav(prefix, fileSize, prefixComplete)
  }
  return parseMpeg(prefix, fileSize, prefixComplete)
}

// ---------------------------------------------------------------------------
// Async file boundary
// ---------------------------------------------------------------------------

interface Identity {
  size: bigint
  mtimeNs: bigint
  ino: bigint
  dev: bigint
}
const identityOf = (s: BigIntStats): Identity => ({ size: s.size, mtimeNs: s.mtimeNs, ino: s.ino, dev: s.dev })
const sameIdentity = (a: Identity, b: Identity): boolean =>
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.dev === b.dev

export interface ReadAudioHeaderOptions {
  fs?: AudioFsApi
}

/**
 * Opens the file once, reads at most MAX_PREFIX_BYTES, closes its own handle, and
 * fails closed (status 'source-changed') if the file's identity moves while reading.
 */
export async function readAudioHeaderMetadata(
  path: string,
  options: ReadAudioHeaderOptions = {}
): Promise<AudioHeaderMetadata> {
  const fs = options.fs ?? defaultFs
  const io: AudioHeaderIo = {
    maxPrefixBytes: MAX_PREFIX_BYTES,
    prefixBytesRequested: 0,
    prefixBytesRead: 0,
    readCalls: 0,
    handleOpened: false,
    handleClosed: false
  }
  const finish = (
    status: ReadStatus,
    statusReason: string | null,
    fields: FormatFields,
    opened: Identity | null
  ): AudioHeaderMetadata => ({
    ...fields,
    status,
    statusReason,
    byteLength: opened ? Number(opened.size) : null,
    source: opened ? { sizeBytes: Number(opened.size), mtimeNs: opened.mtimeNs.toString() } : null,
    io
  })
  const fail = (status: 'error' | 'source-changed', reason: string, opened: Identity | null): AudioHeaderMetadata =>
    finish(status, reason, unknownFields(reason), opened)

  let before: BigIntStats
  try {
    before = await fs.stat(path)
  } catch (error) {
    return fail('error', describeError(error), null)
  }
  if (!before.isFile()) return fail('error', 'not a regular file', null)

  let handle: AudioFileHandle
  try {
    handle = await fs.open(path)
  } catch (error) {
    return fail('error', describeError(error), null)
  }
  io.handleOpened = true

  let outcome: AudioHeaderMetadata
  try {
    outcome = await readWithHandle(fs, handle, path, identityOf(before), io, finish, fail)
  } catch (error) {
    outcome = fail('error', describeError(error), null)
  }
  try {
    await handle.close()
    io.handleClosed = true
  } catch (error) {
    return fail('error', `handle close failed: ${describeError(error)}`, null)
  }
  return outcome
}

async function readWithHandle(
  fs: AudioFsApi,
  handle: AudioFileHandle,
  path: string,
  before: Identity,
  io: AudioHeaderIo,
  finish: (s: ReadStatus, r: string | null, f: FormatFields, o: Identity | null) => AudioHeaderMetadata,
  fail: (s: 'error' | 'source-changed', r: string, o: Identity | null) => AudioHeaderMetadata
): Promise<AudioHeaderMetadata> {
  const opened = identityOf(await handle.stat())
  if (!sameIdentity(before, opened)) return fail('source-changed', 'file changed between stat and open', null)
  if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('error', 'file size exceeds safe integer range', null)

  const size = Number(opened.size)
  const toRead = Math.min(size, MAX_PREFIX_BYTES)
  io.prefixBytesRequested = toRead
  const buffer = new Uint8Array(toRead)
  while (io.prefixBytesRead < toRead) {
    const { bytesRead } = await handle.read(buffer, io.prefixBytesRead, toRead - io.prefixBytesRead, io.prefixBytesRead)
    io.readCalls++
    if (bytesRead === 0) break
    io.prefixBytesRead += bytesRead
  }

  const afterHandle = identityOf(await handle.stat())
  const afterPath = identityOf(await fs.stat(path))
  if (!sameIdentity(opened, afterHandle) || !sameIdentity(opened, afterPath)) {
    return fail('source-changed', 'file size, mtime or identity changed while reading', null)
  }
  if (io.prefixBytesRead < toRead) return fail('source-changed', 'file ended before the expected prefix length', null)

  const parsed = parseAudioHeaderPrefix(buffer, size)
  return finish(parsed.status, parsed.statusReason, parsed.fields, opened)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}
