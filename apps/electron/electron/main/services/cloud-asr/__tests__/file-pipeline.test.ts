// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pcmWavDuration } from '../file-transcription'
import { pcmWave, transcribeCloudFile } from '../file-pipeline'
import type { CloudFileResult } from '../file-transcription'

const mocked = vi.hoisted(() => ({ submit: vi.fn() }))
vi.mock('../file-transcription', async importOriginal => ({
  ...await importOriginal<typeof import('../file-transcription')>(),
  transcribeMuseVoice: mocked.submit
}))
let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); mocked.submit.mockReset() })

describe('real bundled ffmpeg conversion with mocked paid ASR boundary', () => {
  it('decodes a WAV into bounded provider PCM with seconds preserved', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hidock-cloud-asr-test-'))
    const path = join(directory, 'audio.wav')
    await writeFile(path, pcmWave(Buffer.alloc(32000)))
    mocked.submit.mockImplementation(async input => {
      expect(pcmWavDuration(input.audio)).toBe(1)
      return { text: 'hello', model: 'fixture', segments: [{ text: 'hello', start: 0, end: 1, speaker: 'request-a:A' }] }
    })
    const result = await transcribeCloudFile({ path, provider: 'muse-voice', apiKey: 'fixture', shouldContinue: () => true })
    expect(result.text).toBe('hello')
    expect(result.segments[0].end).toBe(1)
    expect(mocked.submit).toHaveBeenCalledTimes(1)
  })
  it('does not launch conversion or upload when cancelled or missing credentials', async () => {
    const options = { path: 'nonexistent', provider: 'muse-voice' as const, apiKey: 'fixture', shouldContinue: () => false }
    await expect(transcribeCloudFile(options)).rejects.toThrow('cancelled')
    await expect(transcribeCloudFile({ ...options, apiKey: '' })).rejects.toThrow('API key')
    expect(mocked.submit).not.toHaveBeenCalled()
  })
  it('splits at ten minutes and offsets timestamps without merging request speakers', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hidock-cloud-asr-test-'))
    const path = join(directory, 'long.wav')
    await writeFile(path, pcmWave(Buffer.alloc(601 * 32000)))
    let call = 0
    mocked.submit.mockImplementation(async input => {
      const duration = pcmWavDuration(input.audio)
      expect(duration).toBe(call === 0 ? 600 : 1)
      return { text: 'word', model: 'fixture', segments: [{ text: 'word', start: 0, end: duration,
        speaker: `request-${++call}:A`, words: [{ word: 'word', start: 0, end: duration }] }] }
    })
    const result = await transcribeCloudFile({ path, provider: 'muse-voice', apiKey: 'fixture', shouldContinue: () => true })
    expect(result.segments.map(row => [row.start, row.end, row.speaker]))
      .toEqual([[0, 600, 'request-1:A'], [600, 601, 'request-2:A']])
    expect(result.segments[1].words?.[0]).toEqual({ word: 'word', start: 600, end: 601 })
    expect(mocked.submit).toHaveBeenCalledTimes(2)
  })
  it('fails invalid source audio without submitting paid work', async () => {
    await expect(transcribeCloudFile({ path: 'nonexistent', provider: 'muse-voice', apiKey: 'fixture', shouldContinue: () => true }))
      .rejects.toThrow('conversion failed')
    expect(mocked.submit).not.toHaveBeenCalled()
  })
  it('resumes a second-clip failure without resubmitting the successful first clip', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hidock-cloud-asr-test-'))
    const path = join(directory, 'resume.wav')
    await writeFile(path, pcmWave(Buffer.alloc(601 * 32000)))
    const saved = new Map<string, CloudFileResult>()
    const checkpoint = async (key: string, action: () => Promise<CloudFileResult>) => {
      if (saved.has(key)) return structuredClone(saved.get(key)!)
      const result = await action(); saved.set(key, structuredClone(result)); return result
    }
    let call = 0
    mocked.submit.mockImplementation(async input => {
      const duration = pcmWavDuration(input.audio)
      if (++call === 2) throw new Error('fixture connection lost')
      return { text: 'word', model: 'fixture', requestId: `request-${call}`, audioSeconds: duration,
        speakerIdentityScope: 'request', streaming: false,
        segments: [{ text: 'word', start: 0, end: duration, speaker: `request-${call}:A`,
          speakerAttribution: 'diarization', timestampSource: 'provider-turn-timestamps' }] }
    })
    const options = { path, provider: 'muse-voice' as const, apiKey: 'fixture', shouldContinue: () => true, checkpoint }
    await expect(transcribeCloudFile(options)).rejects.toThrow('connection lost')
    const result = await transcribeCloudFile(options)
    expect(mocked.submit).toHaveBeenCalledTimes(3)
    expect(result.segments.map(row => [row.start, row.end, row.speaker]))
      .toEqual([[0, 600, 'request-1:A'], [600, 601, 'request-3:A']])
  })
})
