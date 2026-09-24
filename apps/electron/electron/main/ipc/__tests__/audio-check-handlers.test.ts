// @vitest-environment node

/**
 * The audio: channels validate the recording id, answer in the usual
 * {success, data} | {success: false, error} shape, and say plainly when the
 * audio file is not on this computer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, (event: unknown, payload?: unknown) => Promise<unknown>> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => (handlers[channel] = fn) },
}))

const store = vi.hoisted(() => ({
  profileRecordingNow: vi.fn(),
  getAudioProfile: vi.fn(),
  backfillAudioProfiles: vi.fn(),
}))
vi.mock('../../services/audio-profile-store', () => store)

import { registerAudioCheckHandlers } from '../audio-check-handlers'

const PROFILE = {
  category: 'silent',
  durationSeconds: 19.94,
  soundSeconds: 0,
  soundShare: 0,
  longestSoundSeconds: 0,
  spikeCount: 0,
  ranges: [],
  envelope: new Uint8Array(3),
}

beforeEach(() => {
  vi.clearAllMocks()
  registerAudioCheckHandlers()
  store.backfillAudioProfiles.mockResolvedValue({})
})

describe('audio: IPC', () => {
  it('checks one recording and returns its category, without the envelope', async () => {
    store.profileRecordingNow.mockResolvedValue({ recordingId: 'r1', profile: PROFILE, capturesRated: 1 })
    const result = (await handlers['audio:checkRecording']({}, 'r1')) as { success: boolean; data: Record<string, unknown> }
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ category: 'silent', capturesRated: 1 })
    expect(result.data).not.toHaveProperty('envelope')
  })

  it('says the audio file is not on this computer', async () => {
    store.profileRecordingNow.mockResolvedValue({ recordingId: 'r1', profile: null, skipped: 'no-file', capturesRated: 0 })
    expect(await handlers['audio:checkRecording']({}, 'r1')).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })

  it('refuses a malformed recording id', async () => {
    for (const bad of [undefined, '', 42, 'x'.repeat(500)]) {
      expect(await handlers['audio:checkRecording']({}, bad)).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } })
    }
    expect(store.profileRecordingNow).not.toHaveBeenCalled()
  })

  it('reads a stored check, or null before the first one', async () => {
    store.getAudioProfile.mockReturnValueOnce(null)
    expect(await handlers['audio:getCheck']({}, 'r1')).toEqual({ success: true, data: null })
    store.getAudioProfile.mockReturnValueOnce({
      category: 'noise', duration_seconds: 30, sound_seconds: 0.6, sound_share: 0.02,
      longest_sound_seconds: 0.4, spike_count: 2, ranges_json: 'not json',
    })
    expect(await handlers['audio:getCheck']({}, 'r1')).toMatchObject({ success: true, data: { category: 'noise', ranges: [] } })
  })

  it('starts the library pass without waiting for it', async () => {
    expect(await handlers['audio:checkLibrary']({})).toEqual({ success: true, data: { started: true } })
    expect(store.backfillAudioProfiles).toHaveBeenCalledOnce()
  })
})
