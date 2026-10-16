import { TranscriptionCancelledError } from '@hidock/transcription'
/** @vitest-environment node */
import { it, expect, vi, beforeEach } from 'vitest'
const deps = vi.hoisted(() => ({ prepare: vi.fn(), cleanup: vi.fn() }))
vi.mock('../stored-audio-channels', () => ({
  prepareStoredAudioChannels: (...args: unknown[]) => deps.prepare(...args)
}))
import { transcribePreparedChannels } from '../recorded-audio-transcription'
const layout = { originalSha256: 'a'.repeat(64), channels: 2 }
const tracks = [0, 1].map((channelIndex) => ({
  id: `track-${channelIndex}`,
  channelIndex,
  path: `track-${channelIndex}`,
  sourceRole: 'unknown',
  mappingEvidence: null
}))
beforeEach(() => {
  deps.cleanup.mockReset().mockResolvedValue(undefined)
  deps.prepare.mockReset().mockResolvedValue({ layout, tracks, transformVersion: 'fixture-v1', cleanup: deps.cleanup })
})
it('sequentially merges overlapping channel-qualified segments without replacing timestamps or identity provenance', async () => {
  let active = 0,
    max = 0
  const result = await transcribePreparedChannels({
    filePath: 'source',
    parentDir: 'tmp',
    shouldContinue: () => true,
    transcribe: async (track) => {
      max = Math.max(max, ++active)
      await Promise.resolve()
      active--
      return {
        provider: 'fixture',
        fullText: 'words',
        usage: { tokens: 3 },
        remoteQuality: { firstOnly: true },
        speakers: JSON.stringify([
          {
            speaker: 'A',
            start: track.channelIndex ? 1 : 2,
            end: 4,
            text: `channel ${track.channelIndex}`,
            timestampSource: 'model'
          }
        ])
      }
    }
  })
  expect(max).toBe(1)
  const rows = JSON.parse(result.speakers!)
  expect(rows.map((r: any) => r.speaker)).toEqual(['channel-1:A', 'channel-0:A'])
  expect(rows.map((r: any) => [r.start, r.end])).toEqual([
    [1, 4],
    [2, 4]
  ])
  expect(rows.every((r: any) => r.channelRole === 'unknown' && r.timestampSource === 'model')).toBe(true)
  expect(result).not.toHaveProperty('usage')
  expect(result).not.toHaveProperty('remoteQuality')
  expect(result.audioChannels.channelResults[0].result!.usage).toEqual({ tokens: 3 })
  expect(deps.cleanup).toHaveBeenCalledOnce()
})
it('keeps the successful first checkpoint when the second fails and resumes without paying the first again', async () => {
  const saved = new Map<string, any>(),
    calls: number[] = []
  const checkpoint = async (_index: number, key: string, action: () => Promise<any>) => {
    if (saved.has(key)) return saved.get(key)
    const value = await action()
    saved.set(key, value)
    return value
  }
  let fail = true
  const options = {
    filePath: 'source',
    parentDir: 'tmp',
    shouldContinue: () => true,
    checkpoint,
    transcribe: async (track: any) => {
      calls.push(track.channelIndex)
      if (track.channelIndex === 1 && fail) throw new Error('provider failed')
      return { fullText: `text${track.channelIndex}` }
    }
  }
  await expect(transcribePreparedChannels(options)).rejects.toThrow('provider failed')
  expect(deps.cleanup).toHaveBeenCalledOnce()
  fail = false
  const result = await transcribePreparedChannels(options)
  expect(calls).toEqual([0, 1, 1])
  expect(result.fullText).toContain('text0')
  expect(result.fullText).toContain('text1')
  expect(
    JSON.parse(result.speakers!).every((row: any) => row.timestampPlacement === 'unplaced' && !('start' in row))
  ).toBe(true)
})
it('skips a proven silent track, preserves empty outcomes and cancels before the next provider', async () => {
  const transcribe = vi.fn(async () => ({ fullText: '' }))
  const result = await transcribePreparedChannels({
    filePath: 'source',
    parentDir: 'tmp',
    shouldContinue: () => true,
    transcribe,
    isNoSpeech: async (t) => t.channelIndex === 0
  })
  expect(transcribe).toHaveBeenCalledOnce()
  expect(result.audioChannels.channelResults.map((r) => r.status)).toEqual(['no-speech', 'empty'])
  let eligible = true
  const provider = vi.fn(async () => {
    eligible = false
    return { fullText: 'completed' }
  })
  await expect(
    transcribePreparedChannels({
      filePath: 'source',
      parentDir: 'tmp',
      shouldContinue: () => eligible,
      transcribe: provider
    })
  ).rejects.toThrow('cancelled')
  expect(provider).toHaveBeenCalledOnce()
  expect(deps.cleanup).toHaveBeenCalledTimes(2)
})
it('rejects changed source identity and malformed segment payload while cleaning derived files', async () => {
  const transcribe = vi.fn(async () => ({ fullText: 'text', speakers: 'broken' }))
  await expect(
    transcribePreparedChannels({ filePath: 'source', parentDir: 'tmp', shouldContinue: () => true, transcribe })
  ).rejects.toThrow('Malformed')
  expect(deps.cleanup).toHaveBeenCalledOnce()
})

it('runs the actual bounded FFmpeg preparation boundary and cleans derived tracks after aggregation', async () => {
  const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')
  const real = await vi.importActual<typeof import('../stored-audio-channels')>('../stored-audio-channels')
  deps.prepare.mockImplementation(real.prepareStoredAudioChannels)
  const directory = mkdtempSync(join(tmpdir(), 'channel-transcription-boundary-'))
  try {
    const bytes = Buffer.alloc(44 + 16000 * 4)
    bytes.write('RIFF')
    bytes.writeUInt32LE(bytes.length - 8, 4)
    bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(1, 20)
    bytes.writeUInt16LE(2, 22)
    bytes.writeUInt32LE(16000, 24)
    bytes.writeUInt32LE(64000, 28)
    bytes.writeUInt16LE(4, 32)
    bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36)
    bytes.writeUInt32LE(bytes.length - 44, 40)
    for (let i = 0; i < 16000; i++) {
      bytes.writeInt16LE(Math.round(3000 * Math.sin(i / 7)), 44 + i * 4)
      bytes.writeInt16LE(Math.round(2000 * Math.cos(i / 11)), 46 + i * 4)
    }
    const filePath = join(directory, 'synthetic.wav')
    writeFileSync(filePath, bytes)
    const observed: number[] = []
    const result = await transcribePreparedChannels({
      filePath,
      parentDir: directory,
      shouldContinue: () => true,
      transcribe: async (track) => {
        observed.push(track.frames)
        return {
          fullText: 'synthetic provider fixture',
          speakers: JSON.stringify([{ text: 'synthetic provider fixture', speaker: 'A', start: 0, end: 1 }])
        }
      }
    })
    expect(observed).toEqual([16000, 16000])
    expect(result.audioChannels.layout.channels).toBe(2)
    expect(result.audioChannels.channelResults).toHaveLength(2)
    expect(readdirSync(directory)).toEqual(['synthetic.wav'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60000)

it('awaits the complete prepared track set once before any provider, and cleans up if persistence fails', async () => {
  const order: string[]=[]
  const onPrepared=vi.fn(async (prepared:any)=>{expect(prepared.tracks).toHaveLength(2);await Promise.resolve();order.push('persisted')})
  const transcribe=vi.fn(async()=>{order.push('provider');return {fullText:'fixture'}})
  await transcribePreparedChannels({filePath:'source',parentDir:'tmp',shouldContinue:()=>true,onPrepared,transcribe})
  expect(onPrepared).toHaveBeenCalledOnce();expect(order).toEqual(['persisted','provider','provider'])
  transcribe.mockClear();onPrepared.mockRejectedValueOnce(new Error('persistence failed'))
  await expect(transcribePreparedChannels({filePath:'source',parentDir:'tmp',shouldContinue:()=>true,onPrepared,transcribe})).rejects.toThrow('persistence failed')
  expect(transcribe).not.toHaveBeenCalled();expect(deps.cleanup).toHaveBeenCalledTimes(2)
})
it('uses the coordinator cancellation error before starting or after prepared metadata persistence', async()=>{
 const transcribe=vi.fn(async()=>({fullText:'fixture'}))
 await expect(transcribePreparedChannels({filePath:'source',parentDir:'tmp',shouldContinue:()=>false,transcribe})).rejects.toBeInstanceOf(TranscriptionCancelledError)
 let eligible=true
 await expect(transcribePreparedChannels({filePath:'source',parentDir:'tmp',shouldContinue:()=>eligible,onPrepared:async()=>{eligible=false},transcribe})).rejects.toBeInstanceOf(TranscriptionCancelledError)
 expect(transcribe).not.toHaveBeenCalled();expect(deps.cleanup).toHaveBeenCalledOnce()
})
