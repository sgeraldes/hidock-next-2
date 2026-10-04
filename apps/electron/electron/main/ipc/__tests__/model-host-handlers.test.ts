import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerModelHostHandlers } from '../model-host-handlers'
import {
  checkModelHost,
  resetModelHostHealthCache,
} from '../../services/model-host-client'
import { getConfig, saveConfig } from '../../services/config'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../services/model-host-client', () => ({
  checkModelHost: vi.fn(),
  pairWithModelHost: vi.fn(),
  resetModelHostHealthCache: vi.fn(),
}))

vi.mock('../../services/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

type Handler = (...args: any[]) => Promise<unknown>

function handlerFor(handlers: Record<string, Handler>, channel: string): Handler {
  const handler = handlers[channel]
  if (!handler) throw new Error(`No handler registered for ${channel}.`)
  return handler
}

describe('Model Host IPC handlers', () => {
  let handlers: Record<string, Handler>

  beforeEach(() => {
    handlers = {}
    vi.clearAllMocks()
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Handler) => {
      handlers[channel] = handler
      return undefined as never
    })
    vi.mocked(getConfig).mockReturnValue({
      transcription: { modelHostToken: 'saved-token' },
    } as ReturnType<typeof getConfig>)
    vi.mocked(saveConfig).mockResolvedValue(undefined)
    registerModelHostHandlers()
  })

  it('forces a live health request when Settings checks a host', async () => {
    vi.mocked(checkModelHost).mockResolvedValue(null)

    await expect(handlerFor(handlers, 'model-host:check')({}, { url: 'gamestation:8765' }))
      .resolves.toEqual({ success: false, error: 'No host answered at that address.' })

    expect(checkModelHost).toHaveBeenCalledWith(
      { url: 'gamestation:8765', token: 'saved-token' },
      fetch,
      { forceRefresh: true }
    )
  })

  it('reports the saved host, whether speaker work goes there, and what it said', async () => {
    vi.mocked(getConfig).mockReturnValue({
      transcription: {
        modelHostUrl: 'gamestation:8765',
        modelHostToken: 'saved-token',
        speakerLinkingEnabled: true,
        speakerEngine: 'auto',
      },
    } as ReturnType<typeof getConfig>)
    const health = { version: '0.2.0', state: 'paused', capabilities: ['diarize'], pause: { by: 'game' } }
    vi.mocked(checkModelHost).mockResolvedValue(health as never)

    await expect(handlerFor(handlers, 'model-host:status')({})).resolves.toEqual({
      success: true,
      status: { configured: true, paired: true, usedForSpeakers: true, address: 'gamestation:8765', health },
    })
    // The status line polls; it shares the diarization path's short cache.
    expect(checkModelHost).toHaveBeenCalledWith({ url: 'gamestation:8765', token: 'saved-token' })
  })

  it('says a host is paired but unused when the speaker engine runs here', async () => {
    vi.mocked(getConfig).mockReturnValue({
      transcription: {
        modelHostUrl: 'gamestation:8765',
        modelHostToken: 'saved-token',
        speakerLinkingEnabled: true,
        speakerEngine: 'onnx-local',
      },
    } as ReturnType<typeof getConfig>)
    vi.mocked(checkModelHost).mockResolvedValue(null)

    const result = (await handlerFor(handlers, 'model-host:status')({})) as { status: { usedForSpeakers: boolean } }
    expect(result.status.usedForSpeakers).toBe(false)
  })

  it('does not call anything when no host is saved', async () => {
    await expect(handlerFor(handlers, 'model-host:status')({})).resolves.toEqual({
      success: true,
      status: { configured: false, paired: true, usedForSpeakers: false, address: '', health: null },
    })
    expect(checkModelHost).not.toHaveBeenCalled()
  })

  it('clears the health cache when Settings forgets a host', async () => {
    await expect(handlerFor(handlers, 'model-host:forget')({})).resolves.toEqual({ success: true })

    expect(resetModelHostHealthCache).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith({
      transcription: { modelHostUrl: '', modelHostToken: '' },
    })
  })
})
