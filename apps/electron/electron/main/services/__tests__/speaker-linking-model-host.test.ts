// @vitest-environment node

/**
 * Where the recording gets diarized, and what happens when the other machine
 * is not there.
 *
 * The rule this file defends: a model host never makes a recording fail. Every
 * reason it cannot serve a job ends in the local worker, which is exactly what
 * happens on a machine that never had a host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = {
  transcription: {
    speakerLinkingEnabled: true,
    speakerLinkingTimeoutSeconds: 600,
    modelHostUrl: '',
    modelHostToken: '',
  },
}

vi.mock('../config', () => ({ getConfig: () => config }))
vi.mock('../database', () => ({
  queryAll: () => [],
  queryOne: () => null,
  runInTransaction: (fn: () => unknown) => fn(),
  runNoSave: () => {},
}))

import { diarize, resetModelHostComplaint } from '../speaker-linking'
import { ModelHostUnavailableError } from '../model-host-client'

const LOCAL = {
  model: 'pyannote/speaker-diarization-community-1',
  modelVersion: '1.0',
  device: 'cpu',
  segments: [{ start: 0, end: 3, speaker: 'SPEAKER_00' }],
  speakers: [{ label: 'SPEAKER_00', embedding: [0.1], speechSeconds: 3 }],
}
const REMOTE = { ...LOCAL, device: 'cuda:0' }

beforeEach(() => {
  config.transcription.modelHostUrl = ''
  config.transcription.modelHostToken = ''
  resetModelHostComplaint()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('where a recording gets diarized', () => {
  it('runs here when no host is configured, without asking the network', async () => {
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn()
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    expect(result).toBe(LOCAL)
    expect(remote).not.toHaveBeenCalled()
  })

  it('runs on the host when there is one', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    config.transcription.modelHostToken = 'tok'
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => REMOTE)
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    expect(result).toBe(REMOTE)
    expect(local).not.toHaveBeenCalled()
    const settings = (remote as unknown as { mock: { calls: [string, unknown][] } }).mock.calls[0][1]
    expect(settings).toEqual({ url: 'gamestation:8765', token: 'tok' })
  })

  it('runs here when the host cannot serve the job', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => {
      throw new ModelHostUnavailableError('The model host did not answer.')
    })
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    expect(result).toBe(LOCAL)
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('does NOT swallow a real bug from the host', async () => {
    // A host that answers 200 with nonsense is not a network condition. The
    // local worker would hide it and the next release would ship it.
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => {
      throw new Error('the model host returned an incomplete diarization result')
    })
    await expect(diarize('a.wav', () => true, 100, { local, remote: remote as never }))
      .rejects.toThrow(/incomplete diarization result/)
    expect(local).not.toHaveBeenCalled()
  })

  it('says the host is down once, not once per recording', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => {
      throw new ModelHostUnavailableError('The model host did not answer.')
    })
    for (let i = 0; i < 5; i++) {
      await diarize(`rec${i}.wav`, () => true, 100, { local, remote: remote as never })
    }
    expect(local).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('says it again when the reason changes', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => LOCAL)
    const reasons = ['The model host did not answer.', 'The host is paused.']
    let call = 0
    const remote = vi.fn(async () => {
      throw new ModelHostUnavailableError(reasons[Math.min(call++, 1)])
    })
    await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    await diarize('b.wav', () => true, 100, { local, remote: remote as never })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('stops complaining once the host comes back', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => LOCAL)
    let healthy = false
    const remote = vi.fn(async () => {
      if (!healthy) throw new ModelHostUnavailableError('The model host did not answer.')
      return REMOTE
    })
    await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    healthy = true
    await diarize('b.wav', () => true, 100, { local, remote: remote as never })
    healthy = false
    await diarize('c.wav', () => true, 100, { local, remote: remote as never })
    // Down, up, down again: the second outage is worth saying out loud.
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
