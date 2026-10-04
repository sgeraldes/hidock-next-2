import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerModelHostHandlers } from '../model-host-handlers'
import {
  checkModelHost,
  pairWithModelHost,
  resetModelHostHealthCache,
  sendHfTokenToModelHost,
  setModelHostStepAside,
  getModelHostDiagnostics,
  repairModelHostRuntime,
  sendModelHostUpdate,
} from '../../services/model-host-client'
import { getConfig, saveConfig } from '../../services/config'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../services/model-host-client', () => ({
  checkModelHost: vi.fn(),
  pairWithModelHost: vi.fn(),
  resetModelHostHealthCache: vi.fn(),
  sendHfTokenToModelHost: vi.fn(),
  setModelHostStepAside: vi.fn(),
  getModelHostDiagnostics: vi.fn(),
  repairModelHostRuntime: vi.fn(),
  sendModelHostUpdate: vi.fn(),
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

function configWith(transcription: Record<string, unknown>) {
  vi.mocked(getConfig).mockReturnValue({ transcription } as ReturnType<typeof getConfig>)
}

const PAIRED = {
  modelHostUrl: 'gamestation:8765',
  modelHostToken: 'saved-token',
  localAsrHfToken: 'hf_local',
  modelHostStepAside: 'games',
  speakerLinkingEnabled: true,
  speakerEngine: 'auto',
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
    configWith({ modelHostToken: 'saved-token' })
    vi.mocked(saveConfig).mockResolvedValue(undefined)
    vi.mocked(sendHfTokenToModelHost).mockResolvedValue({ status: 'validating' })
    vi.mocked(setModelHostStepAside).mockResolvedValue(undefined)
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

  it('pairs with an empty code (the host’s automatic window), then hands the host its token and the step-aside choice', async () => {
    configWith({ ...PAIRED, modelHostToken: '' })
    vi.mocked(pairWithModelHost).mockResolvedValue({ token: 'new-token' })

    const result = await handlerFor(handlers, 'model-host:pair')({}, { url: 'gamestation:8765', code: '' })

    expect(pairWithModelHost).toHaveBeenCalledWith('gamestation:8765', '')
    expect(saveConfig).toHaveBeenCalledWith({
      transcription: { modelHostUrl: 'gamestation:8765', modelHostToken: 'new-token' },
    })
    const settings = { url: 'gamestation:8765', token: 'new-token' }
    expect(sendHfTokenToModelHost).toHaveBeenCalledWith(settings, 'hf_local')
    expect(setModelHostStepAside).toHaveBeenCalledWith(settings, 'games')
    expect(result).toEqual({ success: true, setup: { status: 'validating' } })
  })

  it('pairs even when this computer has no Hugging Face token, and says so', async () => {
    configWith({ ...PAIRED, localAsrHfToken: '' })
    vi.mocked(pairWithModelHost).mockResolvedValue({ token: 'new-token' })
    const result = (await handlerFor(handlers, 'model-host:pair')({}, { url: 'gamestation:8765', code: '' })) as {
      success: boolean
      warning?: string
    }
    expect(result.success).toBe(true)
    expect(result.warning).toMatch(/Hugging Face token/)
    expect(sendHfTokenToModelHost).not.toHaveBeenCalled()
  })

  it('on Check, sends the token again to a host that is still waiting for it', async () => {
    configWith(PAIRED)
    vi.mocked(checkModelHost)
      .mockResolvedValueOnce({ version: '0.3.0', state: 'ready', capabilities: [], setup: { status: 'needs-token' }, stepAside: 'games' } as never)
      .mockResolvedValueOnce({ version: '0.3.0', state: 'ready', capabilities: [], setup: { status: 'validating' }, stepAside: 'games' } as never)
    const result = (await handlerFor(handlers, 'model-host:check')({}, { url: 'gamestation:8765' })) as {
      health: { setup: { status: string } }
    }
    expect(sendHfTokenToModelHost).toHaveBeenCalledWith({ url: 'gamestation:8765', token: 'saved-token' }, 'hf_local')
    expect(result.health.setup.status).toBe('validating')
  })

  it('on Check, leaves a ready host alone', async () => {
    configWith(PAIRED)
    vi.mocked(checkModelHost).mockResolvedValue({
      version: '0.3.0', state: 'ready', capabilities: ['diarize'], setup: { status: 'ready' }, stepAside: 'games',
    } as never)
    await handlerFor(handlers, 'model-host:check')({}, { url: 'gamestation:8765' })
    expect(sendHfTokenToModelHost).not.toHaveBeenCalled()
    expect(setModelHostStepAside).not.toHaveBeenCalled()
  })

  it('saves when to step aside and sends it to the paired host', async () => {
    configWith(PAIRED)
    await expect(handlerFor(handlers, 'model-host:set-step-aside')({}, { value: 'any-use' })).resolves.toEqual({
      success: true,
      sent: true,
    })
    expect(saveConfig).toHaveBeenCalledWith({ transcription: { modelHostStepAside: 'any-use' } })
    expect(setModelHostStepAside).toHaveBeenCalledWith({ url: 'gamestation:8765', token: 'saved-token' }, 'any-use')
  })

  it('keeps the choice when the host is not answering; it goes over on the next Check or pairing', async () => {
    configWith(PAIRED)
    vi.mocked(setModelHostStepAside).mockRejectedValue(new Error('fetch failed'))
    await expect(handlerFor(handlers, 'model-host:set-step-aside')({}, { value: 'never' })).resolves.toEqual({
      success: true,
      sent: false,
    })
    expect(saveConfig).toHaveBeenCalled()
  })

  it('refuses a step-aside value that is not one of the three', async () => {
    const result = (await handlerFor(handlers, 'model-host:set-step-aside')({}, { value: 'sometimes' })) as {
      success: boolean
    }
    expect(result.success).toBe(false)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('reports the saved host, whether speaker work goes there, whether there is a token to send, and what it said', async () => {
    configWith(PAIRED)
    const health = { version: '0.3.0', state: 'ready', capabilities: ['diarize'], setup: { status: 'ready' } }
    vi.mocked(checkModelHost).mockResolvedValue(health as never)

    await expect(handlerFor(handlers, 'model-host:status')({})).resolves.toEqual({
      success: true,
      status: {
        configured: true,
        paired: true,
        usedForSpeakers: true,
        hasHfToken: true,
        address: 'gamestation:8765',
        health,
      },
    })
    expect(checkModelHost).toHaveBeenCalledWith({ url: 'gamestation:8765', token: 'saved-token' })
  })

  it('says a host is paired but unused when the speaker engine runs here', async () => {
    configWith({ ...PAIRED, speakerEngine: 'onnx-local' })
    vi.mocked(checkModelHost).mockResolvedValue(null)
    const result = (await handlerFor(handlers, 'model-host:status')({})) as { status: { usedForSpeakers: boolean } }
    expect(result.status.usedForSpeakers).toBe(false)
  })

  it('does not call anything when no host is saved', async () => {
    await expect(handlerFor(handlers, 'model-host:status')({})).resolves.toEqual({
      success: true,
      status: { configured: false, paired: true, usedForSpeakers: false, hasHfToken: false, address: '', health: null },
    })
    expect(checkModelHost).not.toHaveBeenCalled()
  })

  it('reads diagnostics, repairs and updates the paired host with the saved token', async () => {
    configWith(PAIRED)
    vi.mocked(getModelHostDiagnostics).mockResolvedValue({ torch: { cudaAvailable: false } })
    vi.mocked(repairModelHostRuntime).mockResolvedValue({ status: 'repairing' })
    vi.mocked(sendModelHostUpdate).mockResolvedValue(undefined)
    const settings = { url: 'gamestation:8765', token: 'saved-token' }

    await expect(handlerFor(handlers, 'model-host:diagnostics')({})).resolves.toEqual({
      success: true,
      diagnostics: { torch: { cudaAvailable: false } },
    })
    await expect(handlerFor(handlers, 'model-host:repair')({})).resolves.toEqual({ success: true, setup: { status: 'repairing' } })
    await expect(
      handlerFor(handlers, 'model-host:update')({}, { path: 'G:\\x\\HiDock-Model-Host-0.3.1-Setup.exe' })
    ).resolves.toEqual({ success: true })
    expect(getModelHostDiagnostics).toHaveBeenCalledWith(settings)
    expect(repairModelHostRuntime).toHaveBeenCalledWith(settings)
    expect(sendModelHostUpdate).toHaveBeenCalledWith(settings, 'G:\\x\\HiDock-Model-Host-0.3.1-Setup.exe')
  })

  it('says why when there is no paired host to look after', async () => {
    const result = (await handlerFor(handlers, 'model-host:repair')({})) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not paired/)
  })

  it('clears the health cache when Settings forgets a host', async () => {
    await expect(handlerFor(handlers, 'model-host:forget')({})).resolves.toEqual({ success: true })

    expect(resetModelHostHealthCache).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith({
      transcription: { modelHostUrl: '', modelHostToken: '' },
    })
  })
})
