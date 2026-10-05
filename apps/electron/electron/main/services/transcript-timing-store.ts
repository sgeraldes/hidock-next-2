import { spawn } from 'child_process'
import { existsSync } from 'fs'
import bundledFfmpeg from 'ffmpeg-static'
import { FRAME_SECONDS, readDeviceWindow, scanDeviceMp3 } from './audio-profile'
import { audioFrameTest } from './transcript-validity'
import { readEnvelope, transcriptFingerprint } from './transcript-validity-store'
import { queryOne } from './database'
import { assessTimingEvidence } from './transcript-timing-evidence'
import type { TimingAssessment, TimingSegment } from '../../../src/shared/transcript-timing'

interface TimingRow { speakers: string | null; file_path: string | null; method: string | null }

/** Decode only a bounded window, through pipes: no audio or cache files are written. */
async function decodeWindow(path: string, start: number, seconds: number): Promise<{ env: Uint8Array; unit: 'gain' | 'db' }> {
  const mp3 = readDeviceWindow(path, start, seconds)
  const gains = mp3 ? scanDeviceMp3(mp3) : null
  const args = mp3
    ? ['-f', 'mp3', '-i', 'pipe:0']
    : ['-ss', String(start), '-i', path]
  return new Promise((resolve, reject) => {
    if (!bundledFfmpeg) { reject(new Error('Bundled decoder unavailable')); return }
    const child = spawn(bundledFfmpeg.replace('app.asar', 'app.asar.unpacked'),
      ['-v', 'error', ...args, '-t', String(seconds), '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('Audio window timed out')) }, 10000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 16000 * 31) child.kill(); else chunks.push(chunk) })
    child.stderr.resume()
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error('Audio window could not be decoded')); return }
      const data = Buffer.concat(chunks)
      const levels: number[] = []
      for (let offset = 0; offset < data.length; offset += 576 * 4) {
        let peak = 0
        for (let i = offset; i + 4 <= Math.min(data.length, offset + 576 * 4); i += 4) peak = Math.max(peak, Math.abs(data.readFloatLE(i)))
        levels.push(Math.round(Math.max(0, Math.min(100, 20 * Math.log10(Math.max(peak, 1e-5)) + 100))))
      }
      // Device gains preserve the established speech floor. Decoded peak levels
      // can make its quiet encoder noise look like speech near zero seconds.
      resolve(gains ? { env: gains, unit: 'gain' } : { env: Uint8Array.from(levels), unit: 'db' })
    })
    child.stdin.on('error', () => { /* process exit is handled above */ })
    child.stdin.end(mp3 ?? undefined)
  })
}

function audioInWindow(env: Uint8Array, test: (frame: number) => boolean, start: number, end: number): boolean | null {
  if (end <= 0 || start >= env.length * FRAME_SECONDS) return false
  const from = Math.max(0, Math.floor(start / FRAME_SECONDS))
  const to = Math.min(env.length, Math.ceil(end / FRAME_SECONDS))
  if (to <= from) return null
  let sound = 0
  for (let f = from; f < to; f++) if (test(f)) sound++
  return sound * FRAME_SECONDS >= 0.15
}

export async function getTranscriptTiming(recordingId: string): Promise<TimingAssessment> {
  const row = queryOne<TimingRow>(`SELECT t.speakers, r.file_path, ap.method FROM transcripts t
    JOIN recordings r ON r.id = t.recording_id LEFT JOIN audio_profiles ap ON ap.recording_id = r.id
    WHERE t.recording_id = ? AND r.deleted_at IS NULL`, [recordingId])
  if (!row) throw new Error('Transcript not found')
  const segments: TimingSegment[] = JSON.parse(row.speakers ?? '[]')
  if (!Array.isArray(segments)) throw new Error('Transcript segments unavailable')
  const env = readEnvelope(recordingId, row.method)
  let hasAudio: (start: number, end: number) => boolean | null = () => null
  if (env?.length) {
    const test = audioFrameTest(env, row.method === 'decoded' ? 'db' : 'gain')
    hasAudio = (start, end) => audioInWindow(env, test, start, end)
  } else if (row.file_path && existsSync(row.file_path)) {
    const pending = assessTimingEvidence(segments, () => null)
    // At most 12 windows per request; remaining findings truthfully stay unsure.
    const starts = [...new Set(pending.flatMap(f => [f.claimedStart, f.impliedStart, f.index === 0 ? 0 : segments[f.index - 1]?.end ?? segments[f.index - 1]?.start ?? null].filter((s): s is number => s !== null)))]
      .slice(0, 12).map(start => Math.max(0, start - 3))
    const windows: Array<{ start: number; env: Uint8Array; unit: 'gain' | 'db' }> = []
    for (const start of starts) {
      try { windows.push({ start, ...await decodeWindow(row.file_path, start, 30) }) }
      catch { /* Missing audio evidence must never turn into invented silence. */ }
    }
    // Reuse the existing floor + margin over sampled windows of the same unit.
    const tests = new Map<number, (frame: number) => boolean>()
    for (const unit of ['gain', 'db'] as const) {
      const group = windows.flatMap((w, index) => w.unit === unit ? [{ ...w, index }] : [])
      const combined = Uint8Array.from(group.flatMap(w => Array.from(w.env)))
      if (!combined.length) continue
      const test = audioFrameTest(combined, unit)
      let offset = 0
      for (const window of group) {
        const base = offset
        tests.set(window.index, frame => test(base + frame))
        offset += window.env.length
      }
    }
    hasAudio = (start, end) => {
      const index = windows.findIndex(w => Math.max(0, start) >= w.start && end <= w.start + w.env.length * FRAME_SECONDS)
      const test = tests.get(index)
      if (index < 0 || !test) return null
      const window = windows[index]
      return audioInWindow(window.env, test, start - window.start, end - window.start)
    }
  }
  return { fingerprint: transcriptFingerprint(row.speakers), findings: assessTimingEvidence(segments, hasAudio),
    hiddenIndices: segments.flatMap((s, i) => s.timingHidden ? [i] : []), reviewed: segments.some(s => s.timingReviewed === true) }
}
