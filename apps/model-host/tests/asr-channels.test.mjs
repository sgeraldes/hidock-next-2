import { describe, it, expect, vi } from 'vitest'
import { writeFile, access, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { channelRequest, mergeChannelResults, runSeparateChannels } from '../src/asr-channels.mjs'
import { WorkerJobs } from '../src/jobs.mjs'
import { HostState, READY } from '../src/state.mjs'

const result = { model: 'fixture', modelVersion: '1', device: 'cpu', wallSeconds: 1,
  segments: [{ start: 0.5, end: 1.5, text: 'fixture', speaker: 'Speaker 0', timestampSource: 'audio-window' }] }

describe('separate channel ASR', () => {
  it.each([1, 2])('aggregates missing diarization across %i tracks', count => {
    const degraded = { ...result, diarizationStatus: 'degraded', diarizationUnavailableSegments: 1,
      speakerEmbeddingsAvailable: false, segments: [{ ...result.segments[0], speaker: 'Speaker unresolved',
        speakerAttribution: 'unresolved', speakerConfidence: 0, diarizationStatus: 'unavailable' }] }
    const labeled = { ...result, diarizationStatus: 'window-scoped-clusters', diarizationUnavailableSegments: 0,
      speakerEmbeddingsAvailable: false }
    const merged = mergeChannelResults([{ sourceChannel: 0, result: count === 2 ? degraded : labeled },
      { sourceChannel: 1, result: degraded }], { channels: 2, durationSeconds: 2 }, [])
    expect(merged).toMatchObject({ diarizationStatus: 'degraded', diarizationUnavailableSegments: count,
      speakerEmbeddingsAvailable: false })
    expect(merged.segments.filter(s => s.diarizationStatus === 'unavailable').every(s =>
      s.speaker === 'Speaker unresolved' && s.speakerAttribution === 'unresolved' && s.speakerConfidence === 0)).toBe(true)
  })
  it('passes remaining operation deadline, not a fresh timeout for each track', async () => {
    let now = 100, calls = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await expect(runSeparateChannels('input', { channelMode: 'separate', workerPath: '/trusted/worker.py', timeoutMs: 100 },
        async (_path, options) => { calls++; expect(options.timeoutMs).toBe(60); now += 70; return result },
        async (_audio, options) => {
          expect(options.timeoutMs).toBe(100); now += 40
          const args = options.workerArgs('input'), dir = args[args.indexOf('--output-dir') + 1]
          const tracks = [join(dir, 'channel-0.wav'), join(dir, 'channel-1.wav')]
          await Promise.all(tracks.map(path => writeFile(path, 'fixture')))
          return { channels: 2, durationSeconds: 2, sourceSha256: 'a'.repeat(64), tracks }
        })).rejects.toThrow('timed out')
      expect(calls).toBe(1)
    } finally { clock.mockRestore() }
  })
  it('validates explicit provenance and preserves legacy defaults', () => {
    expect(channelRequest()).toEqual({ channelMode: 'mixed', channelMap: [] })
    expect(() => channelRequest({ channelMode: 'separate', channelMap: [{ sourceChannel: 0, role: 'microphone', evidence: 'unverified' }] })).toThrow()
    expect(() => channelRequest({ channelMode: 'separate', channelMap: [{ sourceChannel: 2, role: 'unknown', evidence: 'unverified' }] })).toThrow()
    for (const activeChannels of [[], [0, 0], [2], ['0']]) {
      expect(() => channelRequest({ channelMode: 'separate', activeChannels })).toThrow('active channels')
    }
    expect(() => channelRequest({ activeChannels: [0] })).toThrow('active channels')
    expect(channelRequest({ channelMode: 'separate', activeChannels: [1, 0] }).activeChannels).toEqual([0, 1])
  })
  it.each([false, true])('runs only selected track, reports every actual channel, cancellation=%s', async cancel => {
    const controller = new AbortController()
    let directory, calls = 0
    const operation = runSeparateChannels('input', { channelMode: 'separate', activeChannels: [1],
      workerPath: '/trusted/worker.py', signal: controller.signal }, async (path, options) => {
      calls++
      expect(path).toContain('channel-1.wav')
      expect(options.activeChannels).toBeUndefined()
      if (cancel) controller.abort()
      return result
    }, async (_audio, options) => {
      const args = options.workerArgs('input'); directory = args[args.indexOf('--output-dir') + 1]
      const tracks = [join(directory, 'channel-0.wav'), join(directory, 'channel-1.wav')]
      await Promise.all(tracks.map(path => writeFile(path, 'fixture')))
      return { channels: 2, durationSeconds: 2, sourceSha256: 'a'.repeat(64), tracks }
    })
    if (cancel) await expect(operation).rejects.toThrow('cancelled')
    else {
      const merged = await operation
      expect(merged.activeChannels).toEqual([1])
      expect(merged.channelResults).toMatchObject([
        { sourceChannel: 0, status: 'no-activity-skip', segmentCount: 0, policyReason: 'client-energy-preflight' },
        { sourceChannel: 1, status: 'completed', segmentCount: 1 }])
      expect(merged.segments.every(row => row.sourceChannel === 1)).toBe(true)
    }
    expect(calls).toBe(1)
    await expect(access(directory)).rejects.toThrow()
  })
  it('preserves overlapping times and timestamps, namespaces labels without identity inference', () => {
    const merged = mergeChannelResults([{ sourceChannel: 1, result }, { sourceChannel: 0, result }],
      { channels: 2, durationSeconds: 2 }, [{ sourceChannel: 0, role: 'microphone', evidence: 'user-confirmed' }])
    expect(merged.segments.map(s => s.sourceChannel)).toEqual([0, 1])
    expect(merged.segments[0]).toMatchObject({ speaker: 'ch0:Speaker 0', start: .5, end: 1.5,
      channelRole: 'microphone', timestampSource: 'audio-window' })
    expect(merged.segments[1].channelRole).toBe('unknown')
  })
  it.each(['success', 'cancel', 'second-failure'])('serializes tracks and cleans owned files: %s', async mode => {
    let directory, calls = 0, running = 0
    const controller = new AbortController()
    const split = async (_audio, options) => {
      const args = options.workerArgs('input'); directory = args[args.indexOf('--output-dir') + 1]
      const tracks = [join(directory, 'channel-0.wav'), join(directory, 'channel-1.wav')]
      await Promise.all(tracks.map(path => writeFile(path, 'fixture')))
      return { channels: 2, durationSeconds: 2, sourceSha256: 'a'.repeat(64), tracks }
    }
    const operation = runSeparateChannels('original', { channelMode: 'separate', workerPath: '/trusted/worker.py', signal: controller.signal },
      async () => {
        expect(running++).toBe(0); calls++
        await new Promise(resolve => setTimeout(resolve, 2)); running--
        if (mode === 'cancel') controller.abort()
        if (mode === 'second-failure' && calls === 2) throw Error('track failed')
        return result
      }, split)
    if (mode === 'success') expect((await operation).segments).toHaveLength(2)
    else await expect(operation).rejects.toThrow()
    expect(calls).toBe(mode === 'cancel' ? 1 : 2)
    await expect(access(directory)).rejects.toThrow()
  })
  it('binds channel settings to durable identity and rejects non-ASR separate requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-jobs-'))
    const jobs = new WorkerJobs({ directory, state: new HostState({ initial: READY }), execute: async () => result, options: () => ({}) })
    try {
      await jobs.initialize()
      const request = { idempotencyKey: 'channel-fixture-recording', audioHash: 'a'.repeat(64), bytes: 44,
        model: 'fixture', extension: '.wav', stage: 'transcription', channelMode: 'separate' }
      const job = await jobs.create(request, 'owner')
      expect(job.channelMode).toBe('separate')
      await expect(jobs.create({ ...request, channelMode: 'mixed' }, 'owner')).rejects.toThrow('different input')
      await expect(jobs.create({ ...request, activeChannels: [1] }, 'owner')).rejects.toThrow('different input')
      await expect(jobs.create({ ...request, channelMap: [{ sourceChannel: 0, role: 'microphone', evidence: 'user-confirmed' }] }, 'owner')).rejects.toThrow('different input')
      await expect(jobs.create({ ...request, stage: 'vad' }, 'owner')).rejects.toThrow('transcription')
    } finally { await jobs.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
