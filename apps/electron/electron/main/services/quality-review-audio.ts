import { spawn } from 'child_process'
import { bundledFfmpegPath, readDeviceWindow } from './audio-profile'

/** Playback-only extraction. Never loads an ASR model or the whole recording. */
export async function readReviewAudio(path: string, start: number, seconds: number): Promise<Buffer> {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new Error('Review audio must be a bounded interval of at most 30 seconds')
  }
  const direct = readDeviceWindow(path, start, seconds)
  if (direct) return direct
  return new Promise((resolve, reject) => {
    const child = spawn(bundledFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-threads', '1',
      '-ss', String(start), '-t', String(seconds), '-i', path, '-ar', '16000',
      '-threads', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; let bytes = 0; let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(deadline)
      if (error) { child.kill(); reject(error) }
      else resolve(Buffer.concat(chunks))
    }
    const deadline = setTimeout(() => finish(new Error('Audio review extraction timed out')), 10000)
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 2 * 1024 * 1024) finish(new Error('Audio review exceeded its memory budget'))
      else chunks.push(data)
    })
    child.stderr.resume()
    child.once('error', error => finish(error))
    child.once('close', code => finish(code === 0 && bytes > 0 ? undefined : new Error('Could not extract review audio')))
  })
}
