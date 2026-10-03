/**
 * Names the owner in a saved live stream (owner, 28-sep-2026: "each channel
 * should be a speaker").
 *
 * A live recording (<date>-Live.wav, realtime-recorder.ts) keeps the HiDock's
 * two channels: the microphone and the far side. After diarization, the one
 * speaker label whose speech sits mostly on the microphone channel is the
 * person at the HiDock, the owner chosen in Settings > Speakers & voices
 * ("This is you"). Nothing is named when that is not clear: two labels on the
 * microphone, too little speech, no owner chosen, no known microphone channel,
 * or a label someone already named.
 */
import { open } from 'fs/promises'

/** A speaker's speech is "on the microphone" when at least this share of its energy is there. */
export const MIC_SHARE_MIN = 0.65
/** Less speech than this says nothing about who the speaker is. */
export const MIN_SPEECH_SECONDS = 5
/** A quarter second out of every second of a turn is enough to compare two channels, and reads a quarter of the file. */
const WINDOW_SECONDS = 0.25
const STEP_SECONDS = 1
/** Where the fmt and data headers are looked for (a WAV may carry metadata before them). */
const HEAD_BYTES = 64 * 1024

export const LIVE_FILENAME = /-Live(-\d+)?\.wav$/i

export interface TimedSegment {
  speaker?: string
  start: number
  end?: number
}

export interface ChannelEnergy {
  mic: number
  other: number
  seconds: number
}

interface WavLayout {
  dataOffset: number
  dataBytes: number
  sampleRate: number
}

/** Where the samples start, for 16-bit stereo PCM only; null for anything else. */
export function parseWavLayout(head: Buffer): WavLayout | null {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4)
    const size = head.readUInt32LE(pos + 4)
    if (id === 'fmt ' && pos + 24 <= head.length) {
      fmt = { format: head.readUInt16LE(pos + 8), channels: head.readUInt16LE(pos + 10), sampleRate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) }
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 2 || fmt.bits !== 16) return null
      return { dataOffset: pos + 8, dataBytes: size, sampleRate: fmt.sampleRate }
    }
    pos += 8 + size + (size % 2)
  }
  return null
}

/** Energy per speaker label on each channel, over that speaker's turns. */
export async function channelEnergyBySpeaker(
  wavPath: string,
  segments: TimedSegment[],
  micChannel: 0 | 1
): Promise<Map<string, ChannelEnergy>> {
  const out = new Map<string, ChannelEnergy>()
  const file = await open(wavPath, 'r')
  try {
    const head = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(head, 0, head.length, 0)
    const layout = parseWavLayout(head.subarray(0, bytesRead))
    if (!layout) return out
    const frameBytes = 4
    const totalFrames = Math.floor(layout.dataBytes / frameBytes)
    const windowFrames = Math.max(1, Math.round(layout.sampleRate * WINDOW_SECONDS))
    const stepFrames = Math.max(windowFrames, Math.round(layout.sampleRate * STEP_SECONDS))
    const buf = Buffer.alloc(windowFrames * frameBytes)
    for (const seg of segments) {
      if (!seg.speaker || typeof seg.start !== 'number' || typeof seg.end !== 'number' || seg.end - seg.start < 0.5) continue
      const first = Math.max(0, Math.floor(seg.start * layout.sampleRate))
      const last = Math.min(totalFrames, Math.floor(seg.end * layout.sampleRate))
      if (last <= first) continue
      const acc = out.get(seg.speaker) ?? { mic: 0, other: 0, seconds: 0 }
      for (let frame = first; frame < last; frame += stepFrames) {
        const frames = Math.min(windowFrames, last - frame)
        const { bytesRead: got } = await file.read(buf, 0, frames * frameBytes, layout.dataOffset + frame * frameBytes)
        for (let i = 0; i + frameBytes <= got; i += frameBytes) {
          const left = buf.readInt16LE(i)
          const right = buf.readInt16LE(i + 2)
          const mic = micChannel === 0 ? left : right
          const other = micChannel === 0 ? right : left
          acc.mic += mic * mic
          acc.other += other * other
        }
      }
      acc.seconds += (last - first) / layout.sampleRate
      out.set(seg.speaker, acc)
    }
  } finally {
    await file.close()
  }
  return out
}

/** The one label that is clearly the microphone speaker, or null. */
export function microphoneSpeaker(energy: Map<string, ChannelEnergy>): string | null {
  const onMic = [...energy.entries()].filter(([, e]) => {
    const total = e.mic + e.other
    return total > 0 && e.mic / total >= MIC_SHARE_MIN && e.seconds >= MIN_SPEECH_SECONDS
  })
  return onMic.length === 1 ? onMic[0][0] : null
}

export interface LiveOwnerDeps {
  recording: (id: string) => { filename?: string | null; file_path?: string | null } | undefined
  segments: (id: string) => TimedSegment[]
  speakerMap: (id: string) => Array<{ speaker_label: string; contact_id: string }>
  ownerContactId: () => string | null
  /** The microphone channel noted with this file when it was recorded (not today's setting). */
  micChannel: (wavPath: string) => 0 | 1 | null
  /**
   * `from` is what transcript_speakers keeps as source and confidence; voiceAnchor ties the
   * speaker's voice cluster to the owner (spec 2026-10-03, 2a), so the owner's voice is known.
   */
  assign: (
    recordingId: string,
    label: string,
    contactId: string,
    from: {
      source: 'live-channel'
      confidence: number
      voiceAnchor: { method: 'live-channel'; confidence: number }
    }
  ) => void
}

export type LiveOwnerResult =
  | { named: true; label: string }
  | { named: false; reason: string }

/** Name the owner on a live recording's microphone speaker, when that is clear. */
export async function nameOwnerOnLiveRecording(recordingId: string, deps: LiveOwnerDeps): Promise<LiveOwnerResult> {
  const rec = deps.recording(recordingId)
  if (!rec?.file_path || !LIVE_FILENAME.test(rec.filename ?? rec.file_path)) return { named: false, reason: 'not a live recording' }
  const owner = deps.ownerContactId()
  if (!owner) return { named: false, reason: 'no owner chosen in Settings' }
  const mic = deps.micChannel(rec.file_path)
  if (mic === null) return { named: false, reason: 'the microphone channel was not noted for this recording' }
  const map = deps.speakerMap(recordingId)
  if (map.some((m) => m.contact_id === owner)) return { named: false, reason: 'the owner is already named here' }
  const energy = await channelEnergyBySpeaker(rec.file_path, deps.segments(recordingId), mic)
  const label = microphoneSpeaker(energy)
  if (!label) return { named: false, reason: 'no single speaker is clearly on the microphone' }
  if (map.some((m) => m.speaker_label === label)) return { named: false, reason: 'that speaker is already named' }
  // The confidence is that speaker's share of the microphone energy (at least MIC_SHARE_MIN).
  const e = energy.get(label)!
  const micShare = Math.round((e.mic / (e.mic + e.other)) * 100) / 100
  deps.assign(recordingId, label, owner, {
    source: 'live-channel',
    confidence: micShare,
    voiceAnchor: { method: 'live-channel', confidence: micShare }
  })
  return { named: true, label }
}
