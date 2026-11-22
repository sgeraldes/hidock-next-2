import { spawn } from 'child_process'
import ffmpeg from 'ffmpeg-static'

/** Count decoded samples, including recoverable truncated WebM. MediaRecorder
 * containers have no duration header; never infer their length from bitrate.
 * Stream and discard PCM so long recordings use bounded memory.
 */
export function measurePcRecordingDuration(path: string): Promise<number | null> {
  if (!ffmpeg) return Promise.resolve(null)
  const executable = ffmpeg.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return new Promise((resolve) => {
    const child = spawn(executable, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path,
      '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let bytes = 0
    const timeout = setTimeout(() => { child.kill(); resolve(null) }, 120000)
    child.stdout.on('data', (data: Buffer) => { bytes += data.length })
    child.on('error', () => { clearTimeout(timeout); resolve(null) })
    child.on('close', () => {
      clearTimeout(timeout)
      // FFmpeg can return nonzero after decoding an interrupted container.
      resolve(bytes > 0 ? bytes / 16000 : null)
    })
  })
}
