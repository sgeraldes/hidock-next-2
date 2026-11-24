import { spawn } from 'child_process'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { open, mkdtemp, rm } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { createHash } from 'crypto'
import { availableParallelism, freemem, tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import type {
  RecordedAudioLayout,
  RecordedAudioChannel,
  RecordedAudioRoleMapping
} from '../../../src/shared/recorded-audio-layout'

export const STORED_AUDIO_TRANSFORM_VERSION = 'channel-pcm16-16k-v1'
const MAX_SECONDS = 6 * 3600
const MAX_BYTES = 8 * 1024 ** 3
const SUPERVISOR = `import sys,os,subprocess,json
sys.path.insert(0,sys.argv[1])
from resource_policy import apply_resource_policy
policy=apply_resource_policy()
print('RESOURCE_POLICY:'+json.dumps(policy),file=sys.stderr,flush=True)
p=subprocess.Popen(sys.argv[2:],stdin=subprocess.DEVNULL)
sys.exit(p.wait())`

/** Policy is applied to the supervisor before FFmpeg exists; children inherit the Job. */
async function runAudioTool(args: string[], signal?: AbortSignal): Promise<{ stderr: string; code: number | null }> {
  if (!ffmpegPath) throw new Error('Bundled audio decoder unavailable')
  if (signal?.aborted) throw new Error('Audio preparation cancelled')
  if (freemem() < 2 * 1024 ** 3) throw new Error('Audio preparation requires 2 GiB free memory; no fallback started')
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const folder =
    resources && existsSync(join(resources, 'speaker-linking', 'resource_policy.py'))
      ? join(resources, 'speaker-linking')
      : join(process.cwd(), 'resources', 'speaker-linking')
  if (!existsSync(join(folder, 'resource_policy.py'))) throw new Error('Audio resource guard unavailable')
  return new Promise((resolve, reject) => {
    const child = spawn(
      'python',
      [
        '-c',
        SUPERVISOR,
        folder,
        ffmpegPath!.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-threads',
        '2',
        '-filter_threads',
        '1',
        ...args
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          HIDOCK_DIARIZATION_THREADS: String(Math.max(1, Math.min(2, Math.floor(availableParallelism() / 2)))),
          HIDOCK_WORKER_MEMORY_MB: '1024',
          HIDOCK_WORKER_PRIORITY: 'below-normal'
        }
      }
    )
    let stderr = '',
      stopped: string | null = null
    const stop = (reason: string) => {
      stopped ??= reason
      child.kill()
    }
    const cancel = () => stop('Audio preparation cancelled')
    const timer = setTimeout(() => stop('Audio preparation exceeded 180 seconds'), 180000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stderr!.on('data', (data) => {
      if (stderr.length + data.length > 65536) {
        stop('Audio decoder diagnostics exceeded limit')
        return
      }
      stderr += data.toString('utf8')
    })
    child.once('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(new Error('Audio resource supervisor could not start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (stopped) {
        reject(new Error(stopped))
        return
      }
      const proof = /RESOURCE_POLICY:(.*)/.exec(stderr)
      try {
        const policy = proof && JSON.parse(proof[1])
        if (
          !policy ||
          policy.memoryMb !== 1024 ||
          !Number.isInteger(policy.threads) ||
          policy.threads < 1 ||
          policy.threads > 2 ||
          !Number.isFinite(policy.cpuPercent) ||
          policy.cpuPercent <= 0 ||
          policy.cpuPercent > 50 ||
          policy.priority !== 'below-normal'
        )
          throw new Error()
      } catch {
        reject(new Error('Audio resource boundary was not confirmed; no fallback started'))
        return
      }
      resolve({ stderr, code })
    })
  })
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { highWaterMark: 65536, signal })) hash.update(bytes)
  return hash.digest('hex')
}
function mpegFrame(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    (bytes[1] & 224) === 224 &&
    (bytes[1] & 24) !== 8 &&
    (bytes[1] & 6) !== 0 &&
    bytes[2] >> 4 > 0 &&
    bytes[2] >> 4 < 15 &&
    (bytes[2] & 12) !== 12
  )
}
/** Two consecutive Layer III headers avoid treating arbitrary PCM sample bytes as MPEG. */
function wrappedMpeg(bytes: Buffer): boolean {
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
    return [2, 3, 4].includes(bytes[3]) && bytes[4] !== 255 && [...bytes.subarray(6, 10)].every((x) => x < 128)
  }
  if (!mpegFrame(bytes) || (bytes[1] & 6) !== 2) return false
  const version = (bytes[1] >> 3) & 3
  const rates = [44100, 48000, 32000]
  const rate = rates[(bytes[2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const table =
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const size = Math.floor(((version === 3 ? 144000 : 72000) * table[bytes[2] >> 4]) / rate) + ((bytes[2] >> 1) & 1)
  return size >= 4 && mpegFrame(bytes.subarray(size, size + 4))
}
async function sourcePayload(
  path: string
): Promise<{ container: RecordedAudioLayout['container']; offset: number; length: number }> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 12 || info.size > MAX_BYTES) throw new Error('Invalid or oversized audio source')
    const head = Buffer.alloc(12)
    await file.read(head, 0, 12, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      const legacyContainer = head.toString('ascii', 0, 4) === 'OggS' ? 'ogg' :
        head.toString('ascii', 0, 4) === 'fLaC' ? 'flac' :
        head.toString('ascii', 4, 8) === 'ftyp' ? 'mp4' :
        head.readUInt32BE(0) === 0x1a45dfa3 ? 'webm' : null
      if (legacyContainer) return { container: legacyContainer, offset: 0, length: info.size }
      if (head.toString('ascii', 0, 3) !== 'ID3' && !mpegFrame(head))
        throw new Error('Audio container could not be recognized')
      return { container: 'mp3', offset: 0, length: info.size }
    }
    const declaredEnd = head.readUInt32LE(4) + 8
    const end = declaredEnd >= 12 && declaredEnd <= info.size ? declaredEnd : info.size
    for (let offset = 12, chunks = 0; offset + 8 <= end && chunks++ < 4096;) {
      const chunk = Buffer.alloc(8)
      await file.read(chunk, 0, 8, offset)
      const size = chunk.readUInt32LE(4),
        start = offset + 8
      if (chunk.toString('ascii', 0, 4) === 'data') {
        const length = size === 0 || size === 0xffffffff ? end - start : size
        if (length < 4 || start + length > end) throw new Error('Invalid audio payload bounds')
        const sample = Buffer.alloc(Math.min(65536, length))
        await file.read(sample, 0, sample.length, start)
        return {
          container: wrappedMpeg(sample) ? 'riff-mpeg' : 'wav',
          offset: start,
          length
        }
      }
      if (start + size > end) throw new Error('Invalid RIFF chunk bounds')
      offset = start + size + (size % 2)
    }
    throw new Error('WAV data chunk unavailable')
  } finally {
    await file.close()
  }
}
async function inputForDecode(path: string, directory: string, signal?: AbortSignal) {
  const payload = await sourcePayload(path)
  if (payload.container !== 'riff-mpeg') return { path, ...payload }
  const derived = join(directory, 'mpeg-payload.mp3')
  await pipeline(
    createReadStream(path, { start: payload.offset, end: payload.offset + payload.length - 1 }),
    createWriteStream(derived, { flags: 'wx' }),
    { signal }
  )
  return { path: derived, ...payload }
}
async function inspect(path: string, directory: string, signal?: AbortSignal) {
  const originalSha256 = await hashFile(path, signal)
  const input = await inputForDecode(path, directory, signal)
  const result = await runAudioTool(['-i', input.path], signal)
  const audio = /Audio:\s*([^,\s]+)[^\n]*?,\s*(\d+) Hz,\s*(mono|stereo|\d+ channels|[^,\n]+)/.exec(result.stderr)
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr)
  if (!audio || !duration) throw new Error('Audio format or duration could not be established')
  const channels =
    audio[3] === 'mono'
      ? 1
      : audio[3] === 'stereo'
        ? 2
        : /^\d+ channels$/.test(audio[3])
          ? Number(audio[3].split(' ')[0])
          : 0
  if (!Number.isInteger(channels) || channels < 1 || channels > 32)
    throw new Error('Audio channel count could not be established; no downmix was performed')
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  if (!(seconds > 0 && seconds <= MAX_SECONDS)) throw new Error('Audio duration outside supported bounds')
  const bitrate = /Audio:[^\n]*?,\s*(\d+) kb\/s/.exec(result.stderr)
  const layout: RecordedAudioLayout = {
    container: input.container,
    codec: audio[1],
    channels,
    sampleRate: Number(audio[2]),
    durationSeconds: seconds,
    durationSource: 'decoder-probe',
    originalSha256,
    ...(bitrate ? { bitrateKbps: Number(bitrate[1]) } : {})
  }
  return { layout, input: input.path }
}
export async function inspectStoredAudio(
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<RecordedAudioLayout> {
  const directory = await mkdtemp(join(tmpdir(), 'hidock-audio-inspect-'))
  try {
    const { layout } = await inspect(path, directory, options.signal)
    if ((await hashFile(path, options.signal)) !== layout.originalSha256) throw new Error('Audio source changed')
    return layout
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
/** Trusted parent-resolved paths only. Returned cleanup removes only this call's exclusive directory. */
export async function prepareStoredAudioChannels(
  path: string,
  parent: string,
  options: { signal?: AbortSignal; mapping?: RecordedAudioRoleMapping } = {}
): Promise<{
  layout: RecordedAudioLayout
  transformVersion: string
  tracks: RecordedAudioChannel[]
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(parent, 'audio-channels-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    const { layout, input } = await inspect(path, directory, options.signal)
    if (layout.channels > 2) throw new Error('Dual-source mode requires mono or stereo audio; no downmix was performed')
    const mapping = options.mapping ? { ...options.mapping, roles: [...options.mapping.roles] } : undefined
    if (
      mapping &&
      (!['user-confirmed', 'verified-recorded-metadata'].includes(mapping.evidence) ||
        !mapping.evidenceId?.trim() ||
        mapping.roles.length !== layout.channels ||
        mapping.roles.some((role) => !['unknown', 'microphone', 'system'].includes(role)))
    )
      throw new Error('Invalid channel mapping evidence')
    const tracks: RecordedAudioChannel[] = []
    for (let channelIndex = 0; channelIndex < layout.channels; channelIndex++) {
      const output = join(directory, `channel-${channelIndex}.wav`)
      const result = await runAudioTool(
        [
          '-i',
          input,
          '-map',
          '0:a:0',
          '-af',
          `pan=mono|c0=c${channelIndex}`,
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-threads',
          '2',
          '-t',
          String(MAX_SECONDS + 1),
          '-n',
          output
        ],
        options.signal
      )
      if (result.code !== 0) throw new Error('Channel decoding failed')
      const payload = await sourcePayload(output)
      const frames = payload.length / 2
      if (!Number.isInteger(frames) || frames < 1 || frames > MAX_SECONDS * 16000) throw new Error('Invalid derived PCM frame count')
      if (tracks.length && tracks[0].frames !== frames) throw new Error('Derived channels have different sample clocks')
      tracks.push({
        id: createHash('sha256')
          .update(`${layout.originalSha256}:${channelIndex}:${STORED_AUDIO_TRANSFORM_VERSION}`)
          .digest('hex'),
        channelIndex,
        path: output,
        sampleRate: 16000,
        frames,
        durationSeconds: frames / 16000,
        timelineOffsetSeconds: 0,
        sourceRole: mapping?.roles[channelIndex] ?? 'unknown',
        mappingEvidence: mapping ?? null
      })
    }
    if ((await hashFile(path, options.signal)) !== layout.originalSha256)
      throw new Error('Audio source changed during preparation')
    layout.durationSeconds = tracks[0].durationSeconds
    layout.durationSource = 'decoded-frames'
    return { layout, tracks, transformVersion: STORED_AUDIO_TRANSFORM_VERSION, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
