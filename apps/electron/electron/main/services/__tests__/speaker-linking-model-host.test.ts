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
// The library's voice space, as libraryVoiceSpace() would read it. null = empty library.
let space: { model: string; model_version: string; clusters: number; anchored: number } | null = null
// Voices from other models, as the second libraryVoiceSpace() query counts them.
let otherModels = { clusters: 0, anchored: 0 }
const queriesSeen: string[] = []

vi.mock('../database', () => ({
  queryAll: () => [],
  queryOne: (sql: string) => {
    queriesSeen.push(sql)
    return /WHERE NOT \(model = \?/.test(sql) ? otherModels : space
  },
  runInTransaction: (fn: () => unknown) => fn(),
  runNoSave: () => {},
}))

import {
  assertInLibraryVoiceSpace,
  diarize,
  libraryVoiceSpace,
  pinnedVoiceModel,
  resetModelHostComplaint,
  SpeakerLinkingUnavailableError
} from '../speaker-linking'
import { ModelHostUnavailableError } from '../model-host-client'

const LOCAL = {
  model: 'pyannote/speaker-diarization-3.1',
  modelVersion: '1.0',
  device: 'cpu',
  segments: [{ start: 0, end: 3, speaker: 'SPEAKER_00' }],
  speakers: [{ label: 'SPEAKER_00', embedding: [0.1], speechSeconds: 3 }],
}
const REMOTE = { ...LOCAL, device: 'cuda:0' }
// What a host from before model pinning returns when it is configured for community-1.
const OTHER_MODEL = { ...REMOTE, model: 'pyannote/speaker-diarization-community-1' }

beforeEach(() => {
  space = null
  otherModels = { clusters: 0, anchored: 0 }
  queriesSeen.length = 0
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

  it('says it once even when recordings overlap', async () => {
    // A backlog drains in parallel, so the sequential version of this test
    // proved nothing about the case that actually happens.
    config.transcription.modelHostUrl = 'gamestation:8765'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new ModelHostUnavailableError('The model host did not answer.')
    })
    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        diarize(`rec${i}.wav`, () => true, 100, { local, remote: remote as never })
      )
    )
    expect(local).toHaveBeenCalledTimes(6)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('one recording succeeding does not un-say a failure still in flight', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const local = vi.fn(async () => LOCAL)
    let call = 0
    const remote = vi.fn(async () => {
      const mine = call++
      // First and third fail slowly, second succeeds fast in between.
      await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 1 : 20))
      if (mine === 1) return REMOTE
      throw new ModelHostUnavailableError('The model host did not answer.')
    })
    await Promise.all([
      diarize('a.wav', () => true, 100, { local, remote: remote as never }),
      diarize('b.wav', () => true, 100, { local, remote: remote as never }),
      diarize('c.wav', () => true, 100, { local, remote: remote as never }),
    ])
    expect(warn).toHaveBeenCalledTimes(1)
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

describe('the voice model is pinned to the library', () => {
  const LIBRARY = { model: 'pyannote/speaker-diarization-3.1', model_version: '4.0.7', clusters: 244, anchored: 6 }
  const V31 = { ...LOCAL, model: 'pyannote/speaker-diarization-3.1', modelVersion: '4.0.7' }

  it('defaults to pyannote 3.1 when the library is empty', () => {
    expect(pinnedVoiceModel()).toBe('pyannote/speaker-diarization-3.1')
  })

  it("follows the library's model when it has voices", () => {
    space = { ...LIBRARY, model: 'pyannote/speaker-diarization-community-1' }
    expect(pinnedVoiceModel()).toBe('pyannote/speaker-diarization-community-1')
  })

  it('asks the host for the pinned model', async () => {
    space = LIBRARY
    config.transcription.modelHostUrl = 'gamestation:8765'
    config.transcription.modelHostToken = 'tok'
    const remote = vi.fn(async () => V31)
    await diarize('a.wav', () => true, 100, { local: vi.fn(), remote: remote as never })
    const options = (remote as unknown as { mock: { calls: [string, unknown, { model?: string }][] } }).mock.calls[0][2]
    expect(options.model).toBe('pyannote/speaker-diarization-3.1')
  })

  it('diarizes here when a host answers in another model', async () => {
    space = LIBRARY
    config.transcription.modelHostUrl = 'gamestation:8765'
    config.transcription.modelHostToken = 'tok'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => V31)
    const remote = vi.fn(async () => OTHER_MODEL)
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    expect(result).toBe(V31)
    expect(local).toHaveBeenCalledOnce()
  })

  it('reports the winning model and counts the voices of every other model', () => {
    space = LIBRARY
    otherModels = { clusters: 12, anchored: 2 }
    expect(libraryVoiceSpace()).toEqual({
      model: 'pyannote/speaker-diarization-3.1',
      modelVersion: '4.0.7',
      clusters: 244,
      anchored: 6,
      otherModelClusters: 12,
      otherModelAnchored: 2
    })
    // The winner is the model with the most anchored voices, then the most voices.
    expect(queriesSeen[0]).toMatch(/ORDER BY anchored DESC, clusters DESC/)
  })

  it('warns, and still writes, when only the model version changed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lib = {
      model: LIBRARY.model,
      modelVersion: '4.0.7',
      clusters: 244,
      anchored: 6,
      otherModelClusters: 0,
      otherModelAnchored: 0
    }
    expect(() => assertInLibraryVoiceSpace({ ...V31, modelVersion: '4.1.0' }, lib)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('4.0.7 -> 4.1.0'))
  })

  it('refuses to write a result from another model into the library', () => {
    const lib = {
      model: LIBRARY.model,
      modelVersion: LIBRARY.model_version,
      clusters: 244,
      anchored: 6,
      otherModelClusters: 0,
      otherModelAnchored: 0
    }
    expect(() => assertInLibraryVoiceSpace(OTHER_MODEL, lib)).toThrow(SpeakerLinkingUnavailableError)
    expect(() => assertInLibraryVoiceSpace(V31, lib)).not.toThrow()
    expect(() => assertInLibraryVoiceSpace(OTHER_MODEL, null)).not.toThrow()
  })
})
