/**
 * Saves the HiDock realtime stream as a recording (owner, 28-sep-2026: "Do
 * the live streaming recording next").
 *
 * Live transcription sends the two device channels to Gemini and keeps
 * nothing. This writes the same stereo PCM to a WAV in the recordings folder,
 * so the stream becomes a Library recording like any device file: the folder
 * watcher imports it, links it to a meeting and queues it for transcription
 * with whatever provider is set, diarization included. Both channels stay in
 * the file (microphone and far side), which is what later attribution needs.
 *
 * The file is written as `<name>.wav.partial` and renamed when the stream
 * stops. The watcher only takes audio extensions, so it never imports a file
 * that is still growing.
 */
import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'fs'
import { join } from 'path'
import type { RealtimeData } from '@hidock/jensen-protocol'

/** The realtime stream: 16 kHz, two channels, 16-bit (the rate Gemini Live is sent). */
export const LIVE_SAMPLE_RATE = 16000
export const LIVE_CHANNELS = 2
const BYTES_PER_FRAME = LIVE_CHANNELS * 2

/** Odd-length packets in a row that mean the firmware sends one channel. */
const MONO_RUN = 5

/** A 44-byte PCM WAV header for `dataBytes` of stereo 16-bit audio. */
export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(LIVE_CHANNELS, 22)
  header.writeUInt32LE(LIVE_SAMPLE_RATE, 24)
  header.writeUInt32LE(LIVE_SAMPLE_RATE * BYTES_PER_FRAME, 28)
  header.writeUInt16LE(BYTES_PER_FRAME, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026Sep28-104512-Live.wav`: the device's naming, so the date parses the same way. */
export function liveRecordingName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}${MONTHS[at.getMonth()]}${two(at.getDate())}-` +
    `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-Live.wav`
  )
}

/** One channel's samples written to both sides of a stereo stream. */
function monoToStereo(mono: Uint8Array): Buffer {
  const samples = Math.floor(mono.length / 2)
  const out = Buffer.alloc(samples * BYTES_PER_FRAME)
  const view = Buffer.from(mono.buffer, mono.byteOffset, samples * 2)
  for (let i = 0; i < samples; i++) {
    const s = view.readInt16LE(i * 2)
    out.writeInt16LE(s, i * 4)
    out.writeInt16LE(s, i * 4 + 2)
  }
  return out
}

export interface RecorderDeps {
  recordingsPath: () => string
  /** Settings > Recording: "Save live streams as recordings". */
  enabled: () => boolean
  /** The recordings folder is being moved: a new file there would be left behind. */
  folderMoving: () => boolean
  now: () => Date
}

export type RecorderResult =
  | { status: 'saved'; filename: string; seconds: number }
  | { status: 'empty' }
  | { status: 'error'; message: string; filename?: string }

export class RealtimeRecorder {
  private fd: number | null = null
  private partialPath = ''
  private finalPath = ''
  private filename = ''
  private dataBytes = 0
  private error: string | null = null
  private pendingMono: Uint8Array[] = []
  private mono = false
  /** Stereo-length packets in a row while in mono mode. */
  private stereoRun = 0

  constructor(private readonly deps: RecorderDeps) {}

  get recording(): boolean {
    return this.fd !== null
  }

  /** Open the file for a new stream. Returns why not, or null when recording. */
  start(): string | null {
    if (this.fd !== null) return null // already recording this stream (resume after pause)
    if (!this.deps.enabled()) return 'off'
    if (this.deps.folderMoving()) return 'The recordings folder is being moved; this stream is not saved.'
    const folder = this.deps.recordingsPath()
    let name = liveRecordingName(this.deps.now())
    for (let n = 2; existsSync(join(folder, name)) || existsSync(join(folder, `${name}.partial`)); n++) {
      name = name.replace(/-Live(-\d+)?\.wav$/, `-Live-${n}.wav`)
    }
    this.filename = name
    this.finalPath = join(folder, name)
    this.partialPath = `${this.finalPath}.partial`
    this.dataBytes = 0
    this.error = null
    this.pendingMono = []
    this.mono = false
    this.stereoRun = 0
    try {
      this.fd = openSync(this.partialPath, 'wx')
      writeSync(this.fd, wavHeader(0), 0, 44, 0)
    } catch (err) {
      this.fd = null
      return `Could not create the recording: ${err instanceof Error ? err.message : String(err)}`
    }
    return null
  }

  /** Append one device packet. Never throws: the realtime poll must keep draining the device. */
  write(packet: RealtimeData): void {
    if (this.fd === null || this.error) return
    const payload = packet.data.length > 8 ? packet.data.subarray(8) : null
    if (!payload) return
    try {
      const odd = payload.length % 2 === 0 && payload.length % 4 !== 0
      if (odd && !this.mono) {
        // One odd packet is a truncated read; a run of them is mono firmware.
        this.pendingMono.push(packet.muted ? new Uint8Array(payload.length) : payload.slice())
        if (this.pendingMono.length < MONO_RUN) return
        this.mono = true
        for (const p of this.pendingMono.splice(0)) this.append(monoToStereo(p))
        return
      }
      // Length is the only signal, and a mono packet of an even number of
      // samples looks stereo (the live transcription has the same limit). So
      // one such packet does not end mono mode; a run of them does.
      let asMono = odd
      if (this.mono) {
        this.stereoRun = odd ? 0 : this.stereoRun + 1
        if (this.stereoRun >= MONO_RUN) this.mono = false
        else asMono = true
      }
      if (!odd && !this.mono) this.flushPendingAsStereo()
      const bytes = asMono
        ? monoToStereo(packet.muted ? new Uint8Array(payload.length) : payload)
        : packet.muted
          ? Buffer.alloc(payload.length - (payload.length % BYTES_PER_FRAME))
          : Buffer.from(payload.buffer, payload.byteOffset, payload.length - (payload.length % BYTES_PER_FRAME))
      this.append(bytes)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.error('[RealtimeRecorder] Writing the live recording failed:', err)
    }
  }

  /** Close the file and hand it to the Library (rename to .wav), or drop an empty one. */
  finish(): RecorderResult | null {
    if (this.fd === null) return null
    const fd = this.fd
    this.fd = null
    let headerWritten = false
    try {
      if (!this.error) this.flushPendingAsStereo(fd)
      writeSync(fd, wavHeader(this.dataBytes), 0, 44, 0)
      headerWritten = true
    } catch (err) {
      this.error ??= err instanceof Error ? err.message : String(err)
    } finally {
      try {
        closeSync(fd)
      } catch {
        // already closed by the OS on a failed disk; the rename below reports it
      }
    }
    if (this.dataBytes === 0) {
      try {
        rmSync(this.partialPath, { force: true })
      } catch (err) {
        console.warn('[RealtimeRecorder] Could not remove the empty live file:', err)
      }
      return this.error ? { status: 'error', message: this.error } : { status: 'empty' }
    }
    if (!headerWritten) {
      // A .wav that claims zero length would import as nothing. Kept as
      // .partial, the next start repairs it from the file size.
      return {
        status: 'error',
        message: `The recording could not be closed (${this.error}). It is kept and repaired the next time HiDock starts.`,
        filename: `${this.filename}.partial`
      }
    }
    try {
      renameSync(this.partialPath, this.finalPath)
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err), filename: `${this.filename}.partial` }
    }
    const seconds = this.dataBytes / (LIVE_SAMPLE_RATE * BYTES_PER_FRAME)
    // What was written before a disk error is still a usable recording.
    if (this.error) return { status: 'error', message: `Saved the first ${Math.round(seconds)} s only: ${this.error}`, filename: this.filename }
    return { status: 'saved', filename: this.filename, seconds }
  }

  private flushPendingAsStereo(fd = this.fd): void {
    if (fd === null || this.pendingMono.length === 0) return
    for (const p of this.pendingMono.splice(0)) {
      const whole = p.length - (p.length % BYTES_PER_FRAME)
      if (whole > 0) this.append(Buffer.from(p.buffer, p.byteOffset, whole), fd)
    }
  }

  private append(bytes: Buffer, fd = this.fd): void {
    if (fd === null || bytes.length === 0) return
    writeSync(fd, bytes, 0, bytes.length, 44 + this.dataBytes)
    this.dataBytes += bytes.length
  }
}

/**
 * A stream cut off by a crash or a closed app leaves `<name>.wav.partial` with
 * a zero-length header. Fix the header from the file size and hand it to the
 * Library, so the audio that was captured is not lost. Returns the files saved.
 */
export function recoverPartialLiveRecordings(folder: string): string[] {
  const saved: string[] = []
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return saved // no recordings folder yet
  }
  for (const name of names) {
    if (!/-Live(-\d+)?\.wav\.partial$/.test(name)) continue
    const partial = join(folder, name)
    const final = partial.slice(0, -'.partial'.length)
    try {
      const size = statSync(partial).size
      const dataBytes = Math.max(0, size - 44) - (Math.max(0, size - 44) % BYTES_PER_FRAME)
      if (dataBytes === 0) {
        rmSync(partial, { force: true })
        continue
      }
      let target = final
      for (let n = 2; existsSync(target); n++) target = final.replace(/-Live(-\d+)?\.wav$/, `-Live-${n}.wav`)
      const fd = openSync(partial, 'r+')
      try {
        writeSync(fd, wavHeader(dataBytes), 0, 44, 0)
      } finally {
        closeSync(fd)
      }
      renameSync(partial, target)
      saved.push(target)
    } catch (err) {
      console.error(`[RealtimeRecorder] Could not recover ${name}:`, err)
    }
  }
  return saved
}
