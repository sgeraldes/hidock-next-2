// @vitest-environment node

/**
 * voice-backfill: channels (spec 2026-10-03, section 1b): Settings reads the progress and asks
 * for one recording to be measured. Both answer in the usual {success, data} | {success: false,
 * error} shape and never throw across IPC.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyChannel } from '../../../../src/shared/feature-registry'

const handlers: Record<string, (event: unknown, payload?: unknown) => Promise<unknown>> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => (handlers[channel] = fn) }
}))

const { getVoiceBackfillStatus, measureOneRecording } = vi.hoisted(() => ({
  getVoiceBackfillStatus: vi.fn(),
  measureOneRecording: vi.fn()
}))
vi.mock('../../services/voice-backfill', () => ({
  getVoiceBackfillStatus: () => getVoiceBackfillStatus(),
  measureOneRecording: () => measureOneRecording()
}))

import { registerVoiceBackfillHandlers } from '../voice-backfill-handlers'

beforeEach(() => {
  vi.clearAllMocks()
  registerVoiceBackfillHandlers()
})

describe('voice-backfill: IPC', () => {
  it('returns the status', async () => {
    getVoiceBackfillStatus.mockReturnValue({ schedule: 'night', done: 3, remaining: 7 })
    expect(await handlers['voice-backfill:getStatus']({})).toEqual({
      success: true,
      data: { schedule: 'night', done: 3, remaining: 7 }
    })
  })

  it('turns a status failure into an error result', async () => {
    getVoiceBackfillStatus.mockImplementation(() => {
      throw new Error('database is closed')
    })
    expect(await handlers['voice-backfill:getStatus']({})).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'database is closed' }
    })
  })

  it('measures one recording and returns the timing', async () => {
    measureOneRecording.mockResolvedValue({ recordingId: 'r', seconds: 90, audioSeconds: 1200, device: 'cpu' })
    expect(await handlers['voice-backfill:measureOne']({})).toEqual({
      success: true,
      data: { recordingId: 'r', seconds: 90, audioSeconds: 1200, device: 'cpu' }
    })
  })

  it('passes the reason when the measurement cannot run', async () => {
    measureOneRecording.mockRejectedValue(new Error('No recording is waiting for voice evidence.'))
    expect(await handlers['voice-backfill:measureOne']({})).toMatchObject({
      success: false,
      error: { message: 'No recording is waiting for voice evidence.' }
    })
  })

  it('is gated with transcription', () => {
    for (const channel of ['voice-backfill:getStatus', 'voice-backfill:measureOne']) {
      expect(classifyChannel(channel), channel).toEqual({ kind: 'feature', feature: 'transcription' })
    }
  })
})
