/**
 * Audio profile: how much of a recording holds sound, and where.
 *
 * Spec: docs/superpowers/specs/2026-09-24-recording-checks-design.md
 *
 * Every HiDock capture is the same MPEG-2 Layer III stream (16 kHz, mono,
 * 64 kbps CBR, 288-byte frames), sometimes behind a 44-byte RIFF header that
 * declares PCM. Constant bitrate means every frame is full even in silence, so
 * bytes say nothing; the per-frame `global_gain` in the side information does.
 * Reading it needs 13 bytes of every 288, no decoding: a 4-hour file scans in
 * about 35 ms in Node (measured 24-sep). Anything that is not this stream
 * (split parts are VBR, imports can be anything) is decoded with ffmpeg
 * instead, into the same per-frame loud/quiet signal.
 *
 * Measured against decoded audio (20 min of Rec93, frame by frame): gain above
 * 142 agrees with "louder than -45 dBFS" on 99.8% of frames and finds all of
 * the loud ones. -45 dBFS is the threshold the transcription pre-flight uses.
 */

import { spawn } from 'child_process'
import bundledFfmpeg from 'ffmpeg-static'

/** Rule version: bump when a threshold or category rule changes, so profiles are recomputed. */
export const AUDIO_PROFILE_VERSION = 1

/** Seconds of audio per MPEG-2 Layer III frame at 16 kHz (576 samples). */
export const FRAME_SECONDS = 576 / 16000

/** Frame gain above which a frame holds sound (≈ -45 dBFS). */
export const LOUD_GAIN = 142
/** Decoded frames louder than this count as sound, the same line as the pre-flight. */
export const LOUD_DB = -45

/**
 * The device's encoder fills every frame: part2_3_length is 2,200 bits in 100%
 * of the owner's recordings (24-sep). Its gain means loudness only for that
 * encoder; LAME, for one, writes a higher gain for silence than for a tone
 * (review of 24-sep). A stream in the same format from another encoder fails
 * this check and is decoded instead.
 */
export const DEVICE_PART2_3_LENGTH = 2200
/** Share of frames that must carry the device's part2_3_length. */
export const DEVICE_FINGERPRINT_SHARE = 0.95

/** Under this many seconds a recording is not processed automatically. */
export const TOO_SHORT_SECONDS = 10
/** At most this much sound in total: silent. */
export const SILENT_MAX_SOUND_SECONDS = 0.25
/** Noise only: no stretch of sound this long... */
export const NOISE_MAX_RUN_SECONDS = 1.5
/** ...and in total under this many seconds or under this share of the recording. */
export const NOISE_MAX_SOUND_SECONDS = 3
export const NOISE_MAX_SOUND_SHARE = 0.03

/**
 * Gaps up to this long inside a stretch of sound do not end it (the pauses
 * between syllables). The same minimum silence the pre-flight's silencedetect uses.
 */
export const SILENCE_MIN_SECONDS = 0.25

/** Ranges: pauses shorter than this join two stretches of sound. */
export const RANGE_BRIDGE_SECONDS = 2
/** Ranges shorter than this are blips (a knock, a cough) and are dropped. */
export const RANGE_MIN_SECONDS = 1
/** Padding added on each side of a range. */
export const RANGE_PAD_SECONDS = 0.5

export type AudioCategory = 'too_short' | 'silent' | 'noise' | 'speech'

export interface SoundRange {
  start: number
  end: number
}

export interface AudioProfile {
  version: number
  method: 'mp3-frame-gain' | 'decoded'
  durationSeconds: number
  soundSeconds: number
  soundShare: number
  longestSoundSeconds: number
  /** Typical level: median frame gain, or median dBFS + 100 when decoded. Spikes do not move it. */
  medianLevel: number
  /** Short bursts of sound (under RANGE_MIN_SECONDS): knocks, coughs, a laugh. */
  spikeCount: number
  category: AudioCategory
  ranges: SoundRange[]
  /** One level byte per frame, for the waveform and later stages. */
  envelope: Uint8Array
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/**
 * Frame gains of the device's MP3 stream, or null when the file is not that
 * stream (then it has to be decoded). Accepts a RIFF header in front.
 */
export function scanDeviceMp3(buf: Buffer): Uint8Array | null {
  let i = buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' ? 44 : 0
  const payload = buf.length - i
  if (payload < 288) return null
  const gains = new Uint8Array(Math.ceil(payload / 288) + 1)
  let frames = 0
  let skipped = 0
  let deviceShaped = 0
  while (i + 9 <= buf.length) {
    const b1 = buf[i + 1]
    const b2 = buf[i + 2]
    const b3 = buf[i + 3]
    const isDeviceFrame =
      buf[i] === 0xff &&
      (b1 & 0xfe) === 0xf2 && // sync, MPEG-2, Layer III (protection bit either way)
      b2 >> 4 === 8 && // 64 kbps
      ((b2 >> 2) & 0x3) === 2 && // 16 kHz
      b3 >> 6 === 3 // mono
    if (!isDeviceFrame) {
      i++
      skipped++
      // Far more junk than frames: not this stream.
      if (skipped > 4096 && skipped > frames * 64) return null
      continue
    }
    const sideInfo = i + 4 + ((b1 & 1) === 0 ? 2 : 0) // CRC when the protection bit is 0
    if (sideInfo + 5 > buf.length) break // a frame cut off before its side information
    // MPEG-2 mono side info: main_data_begin 8, private 1, part2_3_length 12,
    // big_values 9, then global_gain 8 = bits 30..37.
    // bits 9..20: after the 8 bits of main_data_begin and the private bit.
    const part23 = (((buf[sideInfo + 1] << 16) | (buf[sideInfo + 2] << 8) | buf[sideInfo + 3]) >> 11) & 0xfff
    if (part23 === DEVICE_PART2_3_LENGTH) deviceShaped++
    gains[frames++] = (((buf[sideInfo + 3] << 8) | buf[sideInfo + 4]) >> 2) & 0xff
    i += 288 + ((b2 >> 1) & 1)
  }
  // A stream of the device covers its file; a few stray bytes at the end are fine.
  if (frames === 0 || frames * 288 < payload * 0.9) return null
  // Same format, another encoder: its gains do not mean what the device's mean.
  if (deviceShaped < frames * DEVICE_FINGERPRINT_SHARE) return null
  return gains.subarray(0, frames)
}

/** The ffmpeg the app ships (ffmpeg-static), outside the asar archive when packaged. */
export function bundledFfmpegPath(): string {
  if (!bundledFfmpeg) throw new Error('The bundled ffmpeg is not available')
  return bundledFfmpeg.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/** Per-frame peak dBFS of any audio file, decoded by ffmpeg at 16 kHz mono in frame-sized blocks. */
export function decodeFrameLevels(filePath: string, ffmpegPath = bundledFfmpegPath()): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const levels: number[] = []
    let carry: Buffer = Buffer.alloc(0)
    const frameBytes = 576 * 2
    child.stdout.on('data', (chunk: Buffer) => {
      const data: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
      let offset = 0
      while (offset + frameBytes <= data.length) {
        // Peak, like ffmpeg's silencedetect (the pre-flight): one sample above
        // the threshold makes the frame sound.
        let peak = 0
        for (let s = 0; s < 576; s++) {
          const v = Math.abs(data.readInt16LE(offset + s * 2)) / 32768
          if (v > peak) peak = v
        }
        levels.push(20 * Math.log10(peak + 1e-9))
        offset += frameBytes
      }
      carry = data.subarray(offset)
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      // A decode that stopped partway would describe only the start of the
      // file; better no profile than a wrong one (the pass tries again later).
      if (code !== 0) reject(new Error(`ffmpeg could not decode the audio (exit ${code}): ${stderr.trim().slice(0, 200)}`))
      else resolve(Float32Array.from(levels))
    })
  })
}

/** Stretches of sound: loud frames joined over short pauses, blips dropped, padded. */
export function soundRanges(loud: ArrayLike<boolean | number>, frameSeconds = FRAME_SECONDS): SoundRange[] {
  const bridgeFrames = RANGE_BRIDGE_SECONDS / frameSeconds
  const ranges: SoundRange[] = []
  let start = -1
  let last = -1
  const close = () => {
    if (start < 0) return
    const seconds = (last - start + 1) * frameSeconds
    if (seconds >= RANGE_MIN_SECONDS) {
      ranges.push({ start: Math.max(0, start * frameSeconds - RANGE_PAD_SECONDS), end: (last + 1) * frameSeconds + RANGE_PAD_SECONDS })
    }
  }
  for (let f = 0; f < loud.length; f++) {
    if (!loud[f]) continue
    if (start < 0) start = f
    else if (f - last > bridgeFrames) {
      close()
      start = f
    }
    last = f
  }
  close()
  const total = loud.length * frameSeconds
  // Padding can make neighbours overlap; merge them, and keep the end inside the file.
  const merged: SoundRange[] = []
  for (const r of ranges) {
    const end = Math.min(total, r.end)
    const previous = merged[merged.length - 1]
    if (previous && r.start <= previous.end) previous.end = Math.max(previous.end, end)
    else merged.push({ start: r.start, end })
  }
  return merged.map((r) => ({ start: round(r.start), end: round(r.end) }))
}

/** The numbers and the category, from per-frame levels and a loud/quiet decision. */
export function summarize(
  levels: ArrayLike<number>,
  isLoud: (level: number) => boolean,
  method: AudioProfile['method'],
  toEnvelopeByte: (level: number) => number
): AudioProfile {
  const n = levels.length
  const durationSeconds = n * FRAME_SECONDS
  const loud = new Uint8Array(n)
  const envelope = new Uint8Array(n)
  for (let f = 0; f < n; f++) {
    envelope[f] = toEnvelopeByte(levels[f])
    if (isLoud(levels[f])) loud[f] = 1
  }
  // Silence, as the pre-flight's silencedetect defines it: a quiet stretch of
  // at least SILENCE_MIN_SECONDS. Shorter dips (between syllables) are sound.
  const minSilenceFrames = Math.ceil(SILENCE_MIN_SECONDS / FRAME_SECONDS)
  for (let f = 0; f < n; ) {
    if (loud[f]) {
      f++
      continue
    }
    let end = f
    while (end < n && !loud[end]) end++
    const touchesSound = f > 0 && end < n
    if (touchesSound && end - f < minSilenceFrames) loud.fill(1, f, end)
    f = end
  }
  let soundFrames = 0
  let longestRun = 0
  let spikeCount = 0
  let run = 0
  for (let f = 0; f <= n; f++) {
    if (f < n && loud[f]) {
      soundFrames++
      run++
      continue
    }
    if (run > 0) {
      if (run > longestRun) longestRun = run
      if (run * FRAME_SECONDS < RANGE_MIN_SECONDS) spikeCount++
    }
    run = 0
  }

  const sorted = Float64Array.from({ length: n }, (_, f) => levels[f]).sort()
  const medianLevel = n ? sorted[Math.floor(n / 2)] : 0
  const soundSeconds = soundFrames * FRAME_SECONDS
  const soundShare = n ? soundFrames / n : 0
  const longestSoundSeconds = longestRun * FRAME_SECONDS

  let category: AudioCategory = 'speech'
  if (durationSeconds < TOO_SHORT_SECONDS) category = 'too_short'
  else if (soundSeconds <= SILENT_MAX_SOUND_SECONDS) category = 'silent'
  else if (
    longestSoundSeconds < NOISE_MAX_RUN_SECONDS &&
    (soundSeconds < NOISE_MAX_SOUND_SECONDS || soundShare < NOISE_MAX_SOUND_SHARE)
  ) {
    category = 'noise'
  }

  return {
    version: AUDIO_PROFILE_VERSION,
    method,
    durationSeconds: round(durationSeconds),
    soundSeconds: round(soundSeconds),
    soundShare: round(soundShare, 4),
    longestSoundSeconds: round(longestSoundSeconds),
    medianLevel: round(medianLevel, 1),
    spikeCount,
    category,
    ranges: soundRanges(loud),
    envelope,
  }
}

export function profileFromGains(gains: Uint8Array): AudioProfile {
  return summarize(gains, (g) => g > LOUD_GAIN, 'mp3-frame-gain', (g) => g)
}

export function profileFromDecodedLevels(levels: Float32Array): AudioProfile {
  return summarize(
    levels,
    (db) => db > LOUD_DB,
    'decoded',
    // dBFS -100..0 mapped into a byte, so the envelope has one format.
    (db) => Math.max(0, Math.min(255, Math.round(db + 100)))
  )
}

/** Decoding to confirm a verdict costs seconds per hour; past this length it is not worth it. */
export const CONFIRM_BY_DECODING_MAX_SECONDS = 30 * 60

/**
 * The profile of one audio file. Fast path: the device's MP3 frame gains.
 * A verdict that would hide a recording (silent, noise) is confirmed by
 * decoding, because the gain undercounts some quiet speech (measured 24-sep:
 * 2 of 154 short recordings called noise by gain were speech when decoded).
 * Errs toward keeping: a missed recording loses content, a kept one costs time.
 */
export async function profileAudioFile(
  buf: Buffer,
  filePath: string,
  decode: (path: string) => Promise<Float32Array> = decodeFrameLevels
): Promise<AudioProfile> {
  const gains = scanDeviceMp3(buf)
  if (!gains) return profileFromDecodedLevels(await decode(filePath))
  const fast = profileFromGains(gains)
  const hides = fast.category === 'silent' || fast.category === 'noise'
  if (!hides || fast.durationSeconds > CONFIRM_BY_DECODING_MAX_SECONDS) return fast
  const decoded = profileFromDecodedLevels(await decode(filePath))
  // Keep the fast envelope (gain units) for the waveform; take the decoded verdict.
  return { ...decoded, envelope: fast.envelope, method: 'mp3-frame-gain' }
}
