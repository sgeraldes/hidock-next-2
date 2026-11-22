// @vitest-environment node

/**
 * Where the recording gets diarized, and what happens when the other machine
 * is not there.
 *
 * The rule this file defends: a model host never makes a recording fail. A selected remote host never
 * silently starts a local CPU worker when it is unavailable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = {
  transcription: {
    speakerLinkingEnabled: true,
    remoteDiarizationModel: 'pyannote/speaker-diarization-3.1',
    speakerLinkingTimeoutSeconds: 600,
    modelHostUrl: '',
    modelHostToken: '',
    modelHostLocalFallback: false,
  },
}

vi.mock('../config', () => ({ getConfig: () => config }))
// The library's voice space, as libraryVoiceSpace() would read it. null = empty library.
let space: { model: string; model_version: string; clusters: number; anchored: number } | null = null
// Voices from other models, as the second libraryVoiceSpace() query counts them.
let otherModels = { clusters: 0, anchored: 0 }
const queriesSeen: string[] = []
let remoteIdentities: Array<{ identity_json: string }> = []
vi.mock('../remote-job-checkpoints', () => ({ hasRemoteJobIdentity: () => remoteIdentities.length > 0 }))

vi.mock('../database', () => ({
  queryAll: (sql: string) => sql.includes('remote_job_checkpoints') ? remoteIdentities : [],
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
  config.transcription.remoteDiarizationModel = 'pyannote/speaker-diarization-3.1'
  config.transcription.modelHostUrl = ''
  config.transcription.modelHostToken = ''
  config.transcription.modelHostLocalFallback = false
  remoteIdentities = []
  resetModelHostComplaint()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('where a recording gets diarized', () => {
  it.each([undefined, 'running', 'queued', 'cleanup-failed'])('blocks opted-in fallback with unresolved durable state %s', async observedStatus => {
    config.transcription.modelHostUrl = 'https://gamestation:8766'
    config.transcription.modelHostLocalFallback = true
    remoteIdentities = [{ identity_json: JSON.stringify({ key: 'intent', observedStatus }) }]
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => { throw new ModelHostUnavailableError('offline') })
    await expect(diarize('a.wav', () => true, 100, { local, remote, recordingId: 'recording' }))
      .rejects.toThrow('Remote work may still be running')
    expect(local).not.toHaveBeenCalled()
  })

  it.each(['absent', 'completed', 'failed', 'cancelled', 'interrupted'])('allows opted-in fallback only without unresolved work: %s', async status => {
    config.transcription.modelHostUrl = 'https://gamestation:8766'
    config.transcription.modelHostLocalFallback = true
    if (status !== 'absent') remoteIdentities = [{ identity_json: JSON.stringify({ observedStatus: status }) }]
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => { throw new ModelHostUnavailableError('offline') })
    await expect(diarize('a.wav', () => true, 100, { local, remote, recordingId: 'recording' }))
      .resolves.toMatchObject({ executionLocation: 'local' })
    expect(local).toHaveBeenCalledOnce()
  })

  it('rechecks an identity persisted during the failed remote attempt', async () => {
    config.transcription.modelHostUrl = 'https://gamestation:8766'
    config.transcription.modelHostLocalFallback = true
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn(async () => {
      remoteIdentities = [{ identity_json: JSON.stringify({ key: 'new-intent' }) }]
      throw new ModelHostUnavailableError('lost response')
    })
    await expect(diarize('a.wav', () => true, 100, { local, remote, recordingId: 'recording' }))
      .rejects.toThrow('Remote work may still be running')
    expect(local).not.toHaveBeenCalled()
  })

  it('fails closed for malformed saved identity and for a removed host address', async () => {
    config.transcription.modelHostLocalFallback = true
    remoteIdentities = [{ identity_json: '{invalid' }]
    const local = vi.fn(async () => LOCAL)
    await expect(diarize('a.wav', () => true, 100, { local, recordingId: 'recording' }))
      .rejects.toThrow('Remote work may still be running')
    expect(local).not.toHaveBeenCalled()
  })
  it('runs locally when no host is selected, without asking the network', async () => {
    const local = vi.fn(async () => LOCAL), remote = vi.fn()
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never })
    expect(result).toMatchObject({ ...LOCAL, executionLocation: 'local' })
    expect(remote).not.toHaveBeenCalled()
  })
  it('records the host destination and sends the recording identity', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    config.transcription.modelHostToken = 'tok'
    const local = vi.fn(async () => LOCAL), remote = vi.fn(async (..._args: unknown[]) => ({...REMOTE, hostJobId:'host-job'}))
    const result = await diarize('a.wav', () => true, 100, { local, remote: remote as never, recordingId:'recording-1' })
    expect(result).toMatchObject({ ...REMOTE, executionLocation: 'remote', host:'gamestation:8765', hostJobId:'host-job' })
    expect(local).not.toHaveBeenCalled()
    expect(remote.mock.calls[0][1]).toEqual({ url: 'gamestation:8765', token: 'tok' })
    expect(remote.mock.calls[0][2]).toMatchObject({ recordingId:'recording-1' })
  })
  it.each(['Host offline', 'Host busy', 'Host paused', 'Worker failed'])('never starts local CPU when the host fails: %s', async reason => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL), remote = vi.fn(async () => { throw new ModelHostUnavailableError(reason) })
    await expect(diarize('a.wav', () => true, 100, { local, remote: remote as never }))
      .rejects.toThrow(/Local diarization was not started/)
    expect(local).not.toHaveBeenCalled()
  })
  it('does not hide a malformed result by retrying locally', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL), remote = vi.fn(async () => { throw new Error('incomplete result') })
    await expect(diarize('a.wav', () => true, 100, { local, remote: remote as never })).rejects.toThrow('incomplete result')
    expect(local).not.toHaveBeenCalled()
  })
  it('does not spawn local workers for simultaneous failed host requests', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL), remote = vi.fn(async () => { throw new ModelHostUnavailableError('offline') })
    const results = await Promise.allSettled(Array.from({length:6}, (_, i) =>
      diarize(`rec${i}.wav`, () => true, 100, { local, remote: remote as never })))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(local).not.toHaveBeenCalled()
  })
  it('can use the host again after an unavailable request without switching engines', async () => {
    config.transcription.modelHostUrl = 'gamestation:8765'
    const local = vi.fn(async () => LOCAL)
    const remote = vi.fn().mockRejectedValueOnce(new ModelHostUnavailableError('offline')).mockResolvedValueOnce(REMOTE)
    await expect(diarize('a.wav', () => true, 100, { local, remote })).rejects.toThrow('offline')
    expect(await diarize('b.wav', () => true, 100, { local, remote })).toMatchObject({ executionLocation:'remote' })
    expect(local).not.toHaveBeenCalled()
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

  it('rejects an incompatible host model without running locally', async () => {
    space = LIBRARY
    config.transcription.modelHostUrl = 'gamestation:8765'
    config.transcription.modelHostToken = 'tok'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local = vi.fn(async () => V31)
    const remote = vi.fn(async () => OTHER_MODEL)
    await expect(diarize('a.wav', () => true, 100, { local, remote: remote as never })).rejects.toThrow(/Local diarization was not started/)
    expect(local).not.toHaveBeenCalled()
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

describe('native remote diarization selection', () => {
  it('requests segmentation model without matching it to embedding model', async () => {
    config.transcription.modelHostUrl = 'https://gamestation:8766'
    config.transcription.remoteDiarizationModel = 'nvidia/Nemotron-3-Diarization'
    const native = {...REMOTE, model: 'nvidia/Nemotron-3-Diarization', speakers: []}
    const remote = vi.fn(async (_path: string, _settings: unknown, _options: unknown) => native)
    const local = vi.fn(async () => LOCAL)
    await expect(diarize('a.wav', () => true, 10, { remote, local, recordingId: 'r' }))
      .resolves.toMatchObject({model: native.model, executionLocation: 'remote', speakers: []})
    expect(remote.mock.calls[0][2]).toMatchObject({model: native.model})
    expect(local).not.toHaveBeenCalled()
  })
  it('never substitutes a local model when selected native worker is unavailable', async () => {
    config.transcription.modelHostUrl = 'https://gamestation:8766'
    config.transcription.remoteDiarizationModel = 'nvidia/Nemotron-3-Diarization'
    config.transcription.modelHostLocalFallback = true
    const remote = vi.fn(async () => {throw new ModelHostUnavailableError('offline')})
    const local = vi.fn(async () => LOCAL)
    await expect(diarize('a.wav', () => true, 10, { remote, local, recordingId: 'r' })).rejects.toThrow()
    expect(local).not.toHaveBeenCalled()
  })
})