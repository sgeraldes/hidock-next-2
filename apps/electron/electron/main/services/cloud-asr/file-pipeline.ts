import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import ffmpegPath from 'ffmpeg-static'
import { transcribeMaiTranscribe2, transcribeMuseVoice, type CloudTurn, type CloudFileResult } from './file-transcription'

export type CloudAsrProvider = 'muse-voice' | 'mai-transcribe-2'
const RATE = 16000
const CHUNK_BYTES = 600 * RATE * 2
const MAX_BYTES = 6 * 60 * 60 * RATE * 2

export function pcmWave(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Decode incrementally with pipe backpressure. At most one ten-minute chunk is uploaded at a time. */
export async function transcribeCloudFile(options: {
  path: string; provider: CloudAsrProvider; apiKey: string; endpoint?: string;
  shouldContinue: () => boolean; onChunk?: (completed: number) => void
  checkpoint?: (key: string, action: () => Promise<CloudFileResult>) => Promise<CloudFileResult>
}): Promise<{ text: string; segments: CloudTurn[]; model: string }> {
  if (!options.apiKey.trim()) throw new Error('Configure the selected cloud transcription API key in Settings')
  if (options.provider === 'mai-transcribe-2' && !options.endpoint) throw new Error('Configure the Azure Speech endpoint')
  if (!ffmpegPath) throw new Error('Bundled audio converter unavailable')
  if (!options.shouldContinue()) throw new Error('Cloud transcription cancelled')
  const controller = new AbortController()
  const child = spawn(ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-i', options.path,
    '-vn', '-filter_threads', '1', '-threads', '1', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', () => {}) // Never expose source paths or media metadata from ffmpeg errors.
  let exited = false
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error('Audio conversion could not start')))
    child.once('close', code => { exited = true; resolve(code) })
  })
  void closed.catch(() => {})
  const cancel = () => { controller.abort(); if (!exited) child.kill() }
  const timer = setTimeout(cancel, 2 * 60 * 60 * 1000)
  const poll = setInterval(() => {
    try { if (!options.shouldContinue()) cancel() } catch { cancel() }
  }, 1000)
  let total = 0
  let consumed = 0
  let pending = Buffer.alloc(CHUNK_BYTES)
  let size = 0
  let completed = 0
  const segments: CloudTurn[] = []
  const texts: string[] = []
  let model = ''
  const submit = async () => {
    if (controller.signal.aborted || !options.shouldContinue()) throw new Error('Cloud transcription cancelled')
    const input = { audio: pcmWave(pending.subarray(0, size)), apiKey: options.apiKey, signal: controller.signal }
    const action = () => options.provider === 'muse-voice' ? transcribeMuseVoice(input)
      : transcribeMaiTranscribe2({ ...input, endpoint: options.endpoint! })
    const selectedModel = options.provider === 'muse-voice' ? 'muse-voice-transcribe-1.0' : 'MAI-Transcribe-2'
    const key = JSON.stringify(['cloud-pcm-v1', options.provider, selectedModel, options.endpoint ?? '', consumed, size,
      createHash('sha256').update(input.audio).digest('hex')])
    const result = options.checkpoint ? await options.checkpoint(key, action) : await action()
    const offset = consumed / (RATE * 2)
    segments.push(...result.segments.map(row => ({ ...row, start: row.start + offset, end: row.end + offset,
      ...(row.words ? { words: row.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset })) } : {}) })))
    texts.push(result.text); model = result.model
    consumed += size; size = 0
    options.onChunk?.(++completed)
  }
  try {
    for await (const chunk of child.stdout) {
      const buffer = chunk as Buffer
      total += buffer.length
      if (total > MAX_BYTES) throw new Error('Cloud transcription supports at most six hours per recording')
      let offset = 0
      while (offset < buffer.length) {
        const take = Math.min(CHUNK_BYTES - size, buffer.length - offset)
        buffer.copy(pending, size, offset, offset + take); size += take; offset += take
        if (size === CHUNK_BYTES) await submit()
      }
    }
    if (await closed !== 0 || controller.signal.aborted) throw new Error('Audio conversion failed or was cancelled')
    if (!total || total % 2) throw new Error('Audio conversion returned incomplete PCM')
    if (size) await submit()
    return { text: texts.join(' ').trim(), segments, model }
  } finally {
    clearTimeout(timer); clearInterval(poll); cancel()
    await closed.catch(() => {})
    pending = Buffer.alloc(0)
  }
}
