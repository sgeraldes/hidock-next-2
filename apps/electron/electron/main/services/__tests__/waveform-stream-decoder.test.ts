import { execFile, spawn as spawnProcess } from 'child_process'
import { EventEmitter } from 'events'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { promisify } from 'util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWaveformDecodeQueue,
  decodeWaveformFile,
  getWaveformSourceIdentity,
  WAVEFORM_MAX_CHUNK_BYTES,
  type DecodedWaveform,
  type WaveformDecoder
} from '../waveform-stream-decoder'
import { bundledFfmpegPath } from '../audio-profile'

const execFileAsync = promisify(execFile)
const tempRoots: string[] = []
const FIXTURE_OUTPUT_LIMIT = 8 * 1024 * 1024

function runFfmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(bundledFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > FIXTURE_OUTPUT_LIMIT) {
        child.kill()
        reject(new Error('Synthetic FFmpeg fixture output exceeded its test limit'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
      else reject(new Error(`Synthetic FFmpeg exited ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8')}`))
    })
  })
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hidock-waveform-test-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function writePcmWav(filePath: string, seconds: number, amplitudes: number[], sampleRate = 16000): void {
  const channelCount = amplitudes.length
  const blockFrames = sampleRate
  const dataSize = seconds * blockFrames * channelCount * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channelCount, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channelCount * 2, 28)
  header.writeUInt16LE(channelCount * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  const block = Buffer.alloc(blockFrames * channelCount * 2)
  for (let frame = 0; frame < blockFrames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const frequency = 330 + channel * 220
      const value = amplitudes[channel] * Math.sin((2 * Math.PI * frequency * frame) / sampleRate)
      block.writeInt16LE(Math.round(value * 32767), (frame * channelCount + channel) * 2)
    }
  }

  const fd = openSync(filePath, 'w')
  try {
    writeFileSync(fd, header)
    // Reuse one second of tone so long-duration fixtures stay cheap to create.
    for (let second = 0; second < seconds; second++) writeFileSync(fd, block)
  } finally {
    closeSync(fd)
  }
}

function max(values: number[]): number {
  return values.reduce((peak, value) => Math.max(peak, value), 0)
}

describe('decodeWaveformFile with bundled FFmpeg', () => {
  it('decodes synthetic mono and asymmetric stereo WAVs into actual per-channel peaks', async () => {
    const root = tempRoot()
    const monoPath = join(root, 'mono.wav')
    const stereoPath = join(root, 'stereo.wav')
    writePcmWav(monoPath, 2, [0.31])
    writePcmWav(stereoPath, 2, [0.2, 0.72])

    const mono = await decodeWaveformFile(monoPath)
    expect(mono.codec).toBe('pcm_s16le')
    expect(mono.sourceSampleRate).toBe(16000)
    expect(mono.durationSeconds).toBeCloseTo(2, 2)
    expect(mono.channels).toHaveLength(1)
    expect(mono.channels[0]).toHaveLength(1000)
    expect(max(mono.channels[0])).toBeGreaterThan(0.29)
    expect(mono.channelLabels).toEqual(['Channel 0'])

    const stereo = await decodeWaveformFile(stereoPath)
    expect(stereo.codec).toBe('pcm_s16le')
    expect(stereo.durationSeconds).toBeCloseTo(2, 2)
    expect(stereo.channels).toHaveLength(2)
    expect(stereo.channels.map(channel => channel.length)).toEqual([1000, 1000])
    expect(max(stereo.channels[0])).toBeGreaterThan(0.18)
    expect(max(stereo.channels[0])).toBeLessThan(0.23)
    expect(max(stereo.channels[1])).toBeGreaterThan(0.68)
    expect(max(stereo.channels[1])).toBeLessThan(0.75)
    expect(stereo.channelLabels).toEqual(['Channel 0', 'Channel 1'])
    expect(stereo.peaks).toBe(stereo.channels[0])
    expect(stereo.maxPcmChunkBytes).toBeGreaterThan(0)
    expect(stereo.maxPcmChunkBytes).toBeLessThanOrEqual(WAVEFORM_MAX_CHUNK_BYTES)
    expect(Object.hasOwn(stereo, 'pcm')).toBe(false)
    expect(Object.hasOwn(stereo, 'samples')).toBe(false)
  })

  it('detects a synthetic stereo MP3 from its content when its filename says WAV', async () => {
    const root = tempRoot()
    const wavPath = join(root, 'source.wav')
    const mp3Path = join(root, 'source.mp3')
    const misleadingPath = join(root, 'recording.wav')
    writePcmWav(wavPath, 2, [0.2, 0.72])
    await execFileAsync(bundledFfmpegPath(), [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', wavPath,
      '-codec:a', 'libmp3lame', '-b:a', '128k', mp3Path
    ], { windowsHide: true, timeout: 30000 })
    writeFileSync(misleadingPath, readFileSync(mp3Path))

    const decoded = await decodeWaveformFile(misleadingPath)
    expect(decoded.codec).toBe('mp3')
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.durationSeconds).toBeGreaterThan(1.8)
    expect(decoded.durationSeconds).toBeLessThan(2.4)
    expect(max(decoded.channels[1])).toBeGreaterThan(max(decoded.channels[0]) * 2)
    expect(decoded.maxPcmChunkBytes).toBeLessThanOrEqual(WAVEFORM_MAX_CHUNK_BYTES)
  })

  it('counts frames for MediaRecorder-style WebM with no container duration', async () => {
    const root = tempRoot()
    const sourcePath = join(root, 'source.wav')
    const webmPath = join(root, 'media-recorder.webm')
    writePcmWav(sourcePath, 2, [0.18, 0.64])
    const encoded = await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-i', sourcePath,
      '-map', '0:a:0', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', 'pipe:1'
    ])
    writeFileSync(webmPath, encoded.stdout)
    const banner = await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-i', webmPath, '-f', 'null', '-'
    ])
    expect(banner.stderr).toMatch(/Duration:\s*N\/A/)

    const decoded = await decodeWaveformFile(webmPath)
    expect(decoded.codec).toBe('opus')
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.channels.every(channel => channel.length === 1000)).toBe(true)
    expect(decoded.durationSeconds).toBeGreaterThan(1.9)
    expect(decoded.durationSeconds).toBeLessThan(2.2)
    expect(max(decoded.channels[1])).toBeGreaterThan(max(decoded.channels[0]) * 2)
  }, 30000)

  it('uses decoded frames instead of an absent Xing duration for VBR MP3', async () => {
    const root = tempRoot()
    const sourcePath = join(root, 'thirty-seconds.wav')
    const mp3Path = join(root, 'vbr-without-xing.mp3')
    writePcmWav(sourcePath, 30, [0.14, 0.58])
    const encoded = await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-i', sourcePath,
      '-map', '0:a:0', '-codec:a', 'libmp3lame', '-q:a', '4', '-write_xing', '0', '-f', 'mp3', 'pipe:1'
    ])
    expect(encoded.stdout.includes(Buffer.from('Xing'))).toBe(false)
    expect(encoded.stdout.includes(Buffer.from('Info'))).toBe(false)
    writeFileSync(mp3Path, encoded.stdout)

    const decoded = await decodeWaveformFile(mp3Path)
    expect(decoded.codec).toBe('mp3')
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.durationSeconds).toBeGreaterThan(29.5)
    expect(decoded.durationSeconds).toBeLessThan(30.5)
    expect(max(decoded.channels[1])).toBeGreaterThan(max(decoded.channels[0]) * 2)
  }, 30000)

  it('streams a ten-minute source while retaining fixed-size channel peaks and bounded pipe chunks', async () => {
    const longPath = join(tempRoot(), 'ten-minutes.wav')
    writePcmWav(longPath, 600, [0.2, 0.7], 8000)

    const decoded = await decodeWaveformFile(longPath)
    expect(decoded.durationSeconds).toBeCloseTo(600, 2)
    expect(decoded.framesAtOutputRate).toBe(600 * 8000)
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.channels.every(channel => channel.length === 1000)).toBe(true)
    expect(decoded.channels.reduce((count, channel) => count + channel.length, 0)).toBe(2000)
    expect(decoded.maxPcmChunkBytes).toBeGreaterThan(0)
    expect(decoded.maxPcmChunkBytes).toBeLessThanOrEqual(64 * 1024)
    expect(Object.hasOwn(decoded, 'pcm')).toBe(false)
  }, 60000)
})

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4444
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killCount = 0

  kill(): boolean {
    this.killCount++
    this.signalCode = 'SIGTERM'
    this.stdout.destroy()
    this.stderr.destroy()
    setImmediate(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
}

const oneSecondStereoMetadata = Buffer.from(
  'Duration: 00:00:01.00, start: 0.000000, bitrate: 512 kb/s\n' +
  'Stream #0:0: Audio: pcm_s16le, 16000 Hz, stereo, s16, 512 kb/s\n'
)

function fakePcm(sample: number): Buffer {
  const pcm = Buffer.alloc(8000 * 2 * 4)
  for (let frame = 0; frame < 8000; frame++) {
    pcm.writeFloatLE(0.2, frame * 8)
    pcm.writeFloatLE(sample, frame * 8 + 4)
  }
  return pcm
}

describe('decodeWaveformFile child lifecycle', () => {
  it('kills and awaits the FFmpeg child after non-finite PCM or invalid metadata', async () => {
    const filePath = join(tempRoot(), 'fake-source.wav')
    writeFileSync(filePath, 'synthetic placeholder')
    const children: FakeChild[] = []
    const spawnedArguments: string[][] = []
    const spawnChild = ((...args: unknown[]) => {
      spawnedArguments.push(args[1] as string[])
      const child = new FakeChild()
      children.push(child)
      setImmediate(() => {
        if (children.length === 1) {
          child.stderr.write(oneSecondStereoMetadata)
          const invalid = fakePcm(0.7)
          invalid.writeFloatLE(Number.NaN, 0)
          child.stdout.end(invalid)
        } else {
          child.stderr.write(Buffer.from(
            'Duration: 00:00:01.00, start: 0.000000, bitrate: 512 kb/s\n' +
            'Stream #0:0: Audio: pcm_s16le, 16000 Hz, 16 channels, s16, 512 kb/s\n'
          ))
        }
      })
      return child as unknown as ReturnType<typeof import('child_process').spawn>
    }) as unknown as typeof import('child_process').spawn

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(decodeWaveformFile(filePath, {
        ffmpegPath: 'mock-ffmpeg',
        spawnChild,
        lowerPriority: () => undefined,
        timeoutMs: 2000
      })).rejects.toThrow()
      expect(children[attempt].killCount).toBe(1)
      expect(children[attempt].signalCode).toBe('SIGTERM')
    }
    expect(spawnedArguments[0]).toContain('-nostats')
  })

  it('kills the child on stderr overflow, oversized PCM chunks, timeout, and cancellation', async () => {
    const filePath = join(tempRoot(), 'fake-source.wav')
    writeFileSync(filePath, 'synthetic placeholder')
    const cases: Array<(child: FakeChild) => void> = [
      child => child.stderr.write(Buffer.alloc(64 * 1024 + 1, 65)),
      child => {
        child.stderr.write(oneSecondStereoMetadata)
        child.stdout.write(Buffer.alloc(64 * 1024 + 1))
      },
      () => undefined,
      () => undefined
    ]
    const children: FakeChild[] = []
    const spawnChild = ((..._args: unknown[]) => {
      const child = new FakeChild()
      children.push(child)
      setImmediate(() => cases[children.length - 1](child))
      return child as unknown as ReturnType<typeof import('child_process').spawn>
    }) as unknown as typeof import('child_process').spawn

    await expect(decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg', spawnChild, lowerPriority: () => undefined, timeoutMs: 2000
    })).rejects.toThrow(/diagnostics exceeded/)
    await expect(decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg', spawnChild, lowerPriority: () => undefined, timeoutMs: 2000
    })).rejects.toThrow(/stdout chunk exceeded/)
    await expect(decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg', spawnChild, lowerPriority: () => undefined, timeoutMs: 20
    })).rejects.toThrow(/timeout/)

    const controller = new AbortController()
    const cancelled = decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg', spawnChild, lowerPriority: () => undefined,
      timeoutMs: 2000, signal: controller.signal
    })
    setImmediate(() => controller.abort())
    await expect(cancelled).rejects.toThrow(/cancelled/)

    expect(children).toHaveLength(4)
    expect(children.map(child => child.killCount)).toEqual([1, 1, 1, 1])
  })

  it('checks cancellation after file identity lookup and immediately after listener registration', async () => {
    const filePath = join(tempRoot(), 'fake-source.wav')
    writeFileSync(filePath, 'synthetic placeholder')
    const controller = new AbortController()
    const spawnChild = vi.fn(() => { throw new Error('must not spawn after pre-abort') }) as unknown as typeof import('child_process').spawn
    controller.abort()
    await expect(decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg', spawnChild, signal: controller.signal
    })).rejects.toThrow(/cancelled/)
    expect(spawnChild).toHaveBeenCalledTimes(0)

    // Simulate cancellation arriving synchronously during child creation,
    // after the post-stat check but before the abort listener is attached.
    const racingController = new AbortController()
    const child = new FakeChild()
    const abortDuringSpawnSpy = vi.fn(() => {
      racingController.abort()
      return child as unknown as ReturnType<typeof import('child_process').spawn>
    })
    await expect(decodeWaveformFile(filePath, {
      ffmpegPath: 'mock-ffmpeg',
      spawnChild: abortDuringSpawnSpy as unknown as typeof import('child_process').spawn,
      lowerPriority: () => undefined,
      signal: racingController.signal,
      timeoutMs: 2000
    })).rejects.toThrow(/cancelled/)
    expect(abortDuringSpawnSpy).toHaveBeenCalledTimes(1)
    expect(child.killCount).toBe(1)
  })
})

function decodedFor(path: string): DecodedWaveform {
  const peaks = new Array<number>(1000).fill(0.25)
  return {
    sourceIdentity: getWaveformSourceIdentity(path),
    codec: 'test',
    sourceSampleRate: 8000,
    durationSeconds: 1,
    framesAtOutputRate: 8000,
    maxPcmChunkBytes: 0,
    peaks,
    channels: [peaks],
    channelLabels: ['Channel 0']
  }
}

describe('waveform decode queue', () => {
  it('deduplicates selected requests and only cancels shared work after the last requester leaves', async () => {
    const path = join(tempRoot(), 'same-source.wav')
    writeFileSync(path, 'source')
    let signal: AbortSignal | undefined
    let decodeCount = 0
    const decoder: WaveformDecoder = (_filePath, options) => {
      decodeCount++
      signal = options.signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Waveform decode cancelled')), { once: true })
      })
    }
    const queue = createWaveformDecodeQueue(decoder)
    const first = queue.request(path, 'first')
    const second = queue.request(path, 'second')
    expect(decodeCount).toBe(1)
    expect(queue.cancel('first')).toBe(true)
    expect(signal?.aborted).toBe(false)
    expect(queue.cancel('second')).toBe(true)
    expect(signal?.aborted).toBe(true)
    await expect(first).rejects.toThrow(/cancelled/)
    await expect(second).rejects.toThrow(/cancelled/)
  })

  it('queues a fresh same-file request behind an active child that is still closing', async () => {
    const path = join(tempRoot(), 'cancel-then-reselect.wav')
    writeFileSync(path, 'source')
    let firstSignal: AbortSignal | undefined
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (decoded: DecodedWaveform) => void
    let decodeCount = 0
    const decoder: WaveformDecoder = (_filePath, options) => {
      decodeCount++
      if (decodeCount === 1) {
        firstSignal = options.signal
        return new Promise((_resolve, reject) => { rejectFirst = reject })
      }
      return new Promise(resolve => { resolveSecond = resolve })
    }
    const queue = createWaveformDecodeQueue(decoder)
    const first = queue.request(path, 'first-selection')
    expect(decodeCount).toBe(1)

    expect(queue.cancel('first-selection')).toBe(true)
    expect(firstSignal?.aborted).toBe(true)
    const second = queue.request(path, 'reselected')
    expect(decodeCount).toBe(1)

    rejectFirst(new Error('Waveform decode cancelled'))
    await expect(first).rejects.toThrow(/cancelled/)
    await vi.waitFor(() => expect(decodeCount).toBe(2))
    resolveSecond(decodedFor(path))
    await expect(second).resolves.toMatchObject({ sourceIdentity: { canonicalPath: expect.any(String) } })
  })

  it('rejects request-id collisions before they consume a queue slot or start another source', async () => {
    const root = tempRoot()
    const paths = ['active.wav', 'collision.wav', 'queued.wav'].map(name => join(root, name))
    paths.forEach(path => writeFileSync(path, path))
    const started: string[] = []
    const finishers = new Map<string, (decoded: DecodedWaveform) => void>()
    const decoder: WaveformDecoder = path => {
      started.push(path)
      return new Promise(resolve => finishers.set(path, resolve))
    }
    const queue = createWaveformDecodeQueue(decoder, 1)
    const active = queue.request(paths[0], 'shared-owner')
    expect(started).toEqual([paths[0]])

    await expect(queue.request(paths[1], 'shared-owner')).rejects.toThrow(/already in use/)
    const queued = queue.request(paths[2], 'third-owner')

    finishers.get(paths[0])!(decodedFor(paths[0]))
    await active
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toEqual([paths[0], paths[2]])
    finishers.get(paths[2])!(decodedFor(paths[2]))
    await queued
  })

  it('runs one child at a time and bounds queued work', async () => {
    const root = tempRoot()
    const paths = ['one.wav', 'two.wav', 'three.wav'].map(name => join(root, name))
    paths.forEach(path => writeFileSync(path, path))
    let active = 0
    let maximumActive = 0
    const waiting: Array<{ path: string; finish: () => void }> = []
    const decoder: WaveformDecoder = path => new Promise<DecodedWaveform>(resolve => {
      active++
      maximumActive = Math.max(maximumActive, active)
      waiting.push({ path, finish: () => { active--; resolve(decodedFor(path)) } })
    })
    const queue = createWaveformDecodeQueue(decoder, 1)
    const first = queue.request(paths[0], 'one')
    const second = queue.request(paths[1], 'two')
    const overflow = queue.request(paths[2], 'three')
    await expect(overflow).rejects.toThrow(/queue is full/)
    expect(waiting.map(item => item.path)).toEqual([paths[0]])

    waiting[0].finish()
    await first
    await new Promise(resolve => setImmediate(resolve))
    expect(waiting.map(item => item.path)).toEqual([paths[0], paths[1]])
    waiting[1].finish()
    await second
    expect(maximumActive).toBe(1)
  })
})
