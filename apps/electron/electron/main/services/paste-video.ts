import { execFile } from 'child_process'
import bundledFfmpeg from 'ffmpeg-static'

/** No shell, no visible console, bounded runtime; leave the source video intact. */
export async function extractVideoAudio(video: string, wav: string): Promise<void> {
  if (!bundledFfmpeg) throw new Error('Bundled ffmpeg is unavailable.')
  const executable = bundledFfmpeg.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['-nostdin', '-v', 'error', '-i', video, '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', wav],
      { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Could not extract video audio: ${stderr.trim() || error.message}`))
        else resolve()
      })
  })
}
