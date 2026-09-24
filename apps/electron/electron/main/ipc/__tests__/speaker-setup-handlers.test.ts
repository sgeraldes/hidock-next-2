// @vitest-environment node

/**
 * The speakers: channels validate what the window sends before the service
 * sees it, and answer in the usual {success, data} | {success: false, error} shape.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, (event: unknown, payload?: unknown) => Promise<unknown>> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => (handlers[channel] = fn) },
}))

const { applySpeakerSetup, getSpeakerSetup, dismissSpeakerSetup, SpeakerSetupError } = vi.hoisted(() => ({
  applySpeakerSetup: vi.fn(),
  getSpeakerSetup: vi.fn(),
  dismissSpeakerSetup: vi.fn(),
  SpeakerSetupError: class SpeakerSetupError extends Error {},
}))
vi.mock('../../services/speaker-setup', () => ({
  applySpeakerSetup: (...a: unknown[]) => applySpeakerSetup(...a),
  getSpeakerSetup: (...a: unknown[]) => getSpeakerSetup(...a),
  dismissSpeakerSetup: () => dismissSpeakerSetup(),
  SpeakerSetupError,
}))

import { registerSpeakerSetupHandlers } from '../speaker-setup-handlers'

beforeEach(() => {
  vi.clearAllMocks()
  registerSpeakerSetupHandlers()
  applySpeakerSetup.mockResolvedValue({ ok: true })
  getSpeakerSetup.mockResolvedValue({ ok: true })
  dismissSpeakerSetup.mockResolvedValue(undefined)
})

describe('speakers: IPC', () => {
  it('rejects an unknown engine, a missing fingerprint and a confirmOff that is not a boolean', async () => {
    for (const payload of [
      { engine: 'rm -rf', fingerprint: 'x' },
      { engine: 'off' },
      { engine: 'off', fingerprint: 'x', confirmOff: 'yes' },
      undefined,
    ]) {
      const result = (await handlers['speakers:applySetup']({}, payload)) as { success: boolean; error?: { code: string } }
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
    }
    expect(applySpeakerSetup).not.toHaveBeenCalled()
  })

  it('passes a valid choice through and turns a SpeakerSetupError into a validation error', async () => {
    expect(await handlers['speakers:applySetup']({}, { engine: 'pyannote-local', fingerprint: 'amd:x' })).toMatchObject({
      success: true,
    })
    applySpeakerSetup.mockRejectedValueOnce(new SpeakerSetupError('The GPUs changed while this was open.'))
    expect(await handlers['speakers:applySetup']({}, { engine: 'pyannote-local', fingerprint: 'amd:x' })).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'The GPUs changed while this was open.' },
    })
  })

  it('reads the setup with or without a refresh, and refuses a malformed request', async () => {
    expect(await handlers['speakers:getSetup']({}, { refresh: true })).toMatchObject({ success: true })
    expect(getSpeakerSetup).toHaveBeenCalledWith({ refresh: true })
    expect(await handlers['speakers:getSetup']({}, { refresh: 'please' })).toMatchObject({ success: false })
  })

  it('records "Decide later"', async () => {
    expect(await handlers['speakers:dismissSetup']({})).toMatchObject({ success: true })
    expect(dismissSpeakerSetup).toHaveBeenCalledOnce()
  })
})
