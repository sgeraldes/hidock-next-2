import { execFile } from 'child_process'
import { constants, setPriority } from 'os'

/** Energy detection, not speech recognition or speaker identification. */
export function parseActivity(output) {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) throw new Error('Audio duration unavailable')
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  if (!(duration > 0)) throw new Error('Audio duration must be positive')
  const silence = []
  let start = null
  for (const line of output.split(/\r?\n/)) {
    const begin = line.match(/silence_start:\s*([\d.]+)/)
    if (begin) start = Math.min(duration, Math.max(0, Number(begin[1])))
    const end = line.match(/silence_end:\s*([\d.]+)/)
    if (end) {
      const until = Math.min(duration, Number(end[1]))
      if (until > (start ?? 0)) silence.push({ start: start ?? 0, end: until })
      start = null
    }
  }
  if (start !== null && duration > start) silence.push({ start, end: duration })
  const activityIntervals = []
  let cursor = 0
  for (const span of silence) {
    if (span.start > cursor) activityIntervals.push({ start: cursor, end: span.start, duration: span.start - cursor })
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < duration) activityIntervals.push({ start: cursor, end: duration, duration: duration - cursor })
  const nonSilentSeconds = activityIntervals.reduce((total, span) => total + span.duration, 0)
  const nonSilentRatio = nonSilentSeconds / duration
  const noSpeech = nonSilentSeconds <= 0.25 || duration >= 30 && nonSilentSeconds < 3 && nonSilentRatio < 0.03
  return { model: 'energy-vad-safety-v1', modelVersion: '1', device: 'cpu',
    status: noSpeech ? 'no_speech' : 'speech_present', durationSeconds: duration,
    nonSilentSeconds, nonSilentRatio, silenceSeconds: duration - nonSilentSeconds, activityIntervals,
    resourcePolicy: { threads: 1, runtimeThreads: 1, priority: 'below-normal' } }
}

/** One bounded decoder, without a model or full-file buffering. */
export async function runVad(audioPath, options) {
  if (!options.ffmpegPath) throw new Error('VAD runtime unavailable')
  if (options.signal?.aborted) throw new Error('VAD cancelled')
  return new Promise((resolve, reject) => {
    let stopReason = null
    const abort = () => { stopReason = new Error('VAD cancelled'); child.kill() }
    const child = execFile(options.ffmpegPath,
      ['-hide_banner', '-nostats', '-threads', '1', '-filter_threads', '1', '-i', audioPath,
        '-af', 'silencedetect=noise=-45dB:d=0.25,volumedetect', '-f', 'null', '-'],
      { windowsHide: true, timeout: Math.min(options.timeoutMs || 300000, 300000), maxBuffer: 10 * 1024 ** 2 },
      (error, _stdout, stderr) => {
        options.signal?.removeEventListener('abort', abort)
        if (stopReason || error) { reject(stopReason || error); return }
        try { resolve(parseActivity(stderr)) } catch (parseError) { reject(parseError) }
      })
    try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL) }
    catch (error) { stopReason = error; child.kill() }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}
