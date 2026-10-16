import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerBrainsHandlers } from '../brains-handlers'
import { getConfig, replaceConfigSection, updateConfig } from '../../services/config'
import { getBrainRegistry } from '../../services/brains/brain-registry'
import { getBrainCredentialStore } from '../../services/brains/brain-credential-store'
import type { AIBrain, BrainAuthStatus, BrainCapability } from '../../services/brains/types'
import { getVectorStore } from '../../services/vector-store'

const recoveryMode = vi.hoisted(() => vi.fn(() => false))
const backfill = vi.hoisted(() => vi.fn(async () => ({ indexed: 0, skipped: 0 })))
vi.mock('../../recovery-mode', () => ({ isRecoveryMode: recoveryMode }))

const generationProfile = vi.hoisted(() => vi.fn())
vi.mock('../../services/brains/model-host-generate-brain', () => ({ readRemoteGenerationCapability: generationProfile }))
const remoteSpace = vi.hoisted(() => vi.fn())
vi.mock('../../services/brains/model-host-embed-brain', () => ({ readRemoteEmbeddingSpace: remoteSpace }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../services/config', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  replaceConfigSection: vi.fn(),
}))

vi.mock('../../services/brains/brain-registry', () => ({
  getBrainRegistry: vi.fn(),
}))

vi.mock('../../services/brains/brain-credential-store', () => ({
  getBrainCredentialStore: vi.fn(),
}))

vi.mock('../../services/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    backfillMissingTranscripts: backfill,
  })),
}))

/** Minimal fake brain: only the surface brains:list reads. */
function fakeBrain(
  id: AIBrain['id'],
  label: string,
  caps: BrainCapability[],
  auth: BrainAuthStatus | (() => Promise<BrainAuthStatus>)
): AIBrain {
  return {
    id,
    label,
    capabilities: () => new Set(caps),
    authStatus: typeof auth === 'function' ? auth : () => Promise.resolve(auth),
    generate: async () => null,
    chat: async () => null,
  }
}

const BRAINS = [
  fakeBrain('gemini-api', 'Gemini (API key)', ['generate', 'chat', 'embed', 'analyzeAudio'], {
    configured: true,
    method: 'api-key',
    detail: 'Key set',
  }),
  fakeBrain('claude-code', 'Claude Code SDK', ['generate', 'chat', 'agentic'], {
    configured: false,
    method: 'cli-login',
    detail: 'Needs login',
  }),
]

const CONFIG_BRAINS = {
  enabled: { 'gemini-api': true, ollama: true, 'claude-code': false, codex: false, 'gemini-cli': false },
  defaultBrain: 'gemini-api',
  taskRouting: {},
  models: {},
}

type IpcHandler = (event?: any, ...args: any[]) => any

describe('Brains IPC Handlers', () => {
  let handlers: Record<string, IpcHandler> = {}
  const setSecret = vi.fn()
  const hasSecret = vi.fn(() => false)

  beforeEach(() => {
    vi.clearAllMocks()
    recoveryMode.mockReturnValue(false)
    handlers = {}
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: IpcHandler) => {
      handlers[channel] = handler
      return undefined as any
    }) as any)
    vi.mocked(getConfig).mockReturnValue({ brains: CONFIG_BRAINS } as any)
    vi.mocked(updateConfig).mockResolvedValue(undefined)
    vi.mocked(replaceConfigSection).mockResolvedValue(undefined)
    hasSecret.mockReturnValue(false)
    vi.mocked(getBrainRegistry).mockReturnValue({ list: () => BRAINS, get: () => null } as any)
    vi.mocked(getBrainCredentialStore).mockReturnValue({ setSecret, hasSecret } as any)
    registerBrainsHandlers()
  })

  afterEach(() => vi.useRealTimers())

  it('bounds a hanging adapter, deduplicates overlapping/repeated loads and never publishes its late status', async () => {
    vi.useFakeTimers()
    let settle!: (auth: BrainAuthStatus) => void
    const authStatus = vi.fn(() => new Promise<BrainAuthStatus>(resolve => { settle = resolve }))
    const brain = fakeBrain('model-host-generate', 'Managed', ['chat'], authStatus)
    vi.mocked(getBrainRegistry).mockReturnValue({ list: () => [brain], get: () => brain } as any)
    const first = handlers['brains:list']()
    const second = handlers['brains:list']()
    await vi.advanceTimersByTimeAsync(4999)
    expect(authStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const firstRows = await first, secondRows = await second
    expect(firstRows[0].auth).toMatchObject({ configured: false, detail: 'Status unavailable' })
    expect(secondRows[0].auth).toEqual(firstRows[0].auth)
    expect((await handlers['brains:list']())[0].auth.configured).toBe(false)
    expect(authStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    settle({ configured: true, method: 'api-key', detail: 'late result' })
    await vi.advanceTimersByTimeAsync(0)
    expect(firstRows[0].auth.configured).toBe(false)
    expect(secondRows[0].auth.configured).toBe(false)
    authStatus.mockResolvedValue({ configured: false, method: 'none', detail: 'fresh check' })
    expect((await handlers['brains:list']())[0].auth.detail).toBe('fresh check')
    expect(authStatus).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans metadata timers on both success and rejection', async () => {
    vi.useFakeTimers()
    const good = fakeBrain('gemini-api', 'Good', ['chat'], async () => ({ configured: true, method: 'api-key' }))
    const bad = fakeBrain('ollama', 'Bad', ['chat'], async () => { throw new Error('metadata failed') })
    vi.mocked(getBrainRegistry).mockReturnValue({ list: () => [good, bad] } as any)
    const rows = await handlers['brains:list']()
    expect(rows.map((row: any) => row.auth.configured)).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('binds the authenticated remote space and enables only after explicit semantic selection', async () => {
    remoteSpace.mockResolvedValue({ spaceId: 'nemotron-import-sha256:' + 'a'.repeat(64) })
    await handlers['brains:setTaskRouting']({}, { task: 'embed', id: 'model-host-embed' })
    expect(replaceConfigSection).toHaveBeenCalledWith('brains', expect.objectContaining({
      modelHostEmbedding: { spaceId: 'nemotron-import-sha256:' + 'a'.repeat(64) },
      taskRouting: { embed: 'model-host-embed' }, enabled: expect.objectContaining({ 'model-host-embed': true })
    }))
  })
  it('leaves routing unchanged when authenticated remote readiness fails', async () => {
    remoteSpace.mockRejectedValue(new Error('unavailable'))
    await expect(handlers['brains:setTaskRouting']({}, { task: 'embed', id: 'model-host-embed' })).rejects.toThrow('unavailable')
    expect(replaceConfigSection).not.toHaveBeenCalled()
  })

  it('persists an explicit remote embedding binding in recovery without initializing or backfilling vectors', async () => {
    recoveryMode.mockReturnValue(true)
    remoteSpace.mockResolvedValue({ spaceId: 'nemotron-import-sha256:' + 'b'.repeat(64) })
    await handlers['brains:setTaskRouting']({}, { task: 'embed', id: 'model-host-embed' })
    expect(replaceConfigSection).toHaveBeenCalledWith('brains', expect.objectContaining({
      modelHostEmbedding: { spaceId: 'nemotron-import-sha256:' + 'b'.repeat(64) },
      taskRouting: { embed: 'model-host-embed' },
      enabled: expect.objectContaining({ 'model-host-embed': true })
    }))
    expect(getVectorStore).not.toHaveBeenCalled()
    expect(backfill).not.toHaveBeenCalled()
  })

  it.each(['enable', 'route', 'default'])('atomically binds managed generation for explicit %s only', async action => {
    generationProfile.mockResolvedValue({ modelVersion: 'measured-version' })
    if (action === 'enable') await handlers['brains:setEnabled']({}, { id: 'model-host-generate', enabled: true })
    if (action === 'route') await handlers['brains:setTaskRouting']({}, { task: 'chat', id: 'model-host-generate' })
    if (action === 'default') await handlers['brains:setDefault']({}, { id: 'model-host-generate' })
    expect(replaceConfigSection).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(replaceConfigSection).mock.calls[0][1] as any
    expect(saved.modelHostGeneration).toEqual({ modelVersion: 'measured-version' })
    expect(saved.enabled['model-host-generate']).toBe(true)
    expect(saved.defaultBrain).toBe(action === 'default' ? 'model-host-generate' : 'gemini-api')
    expect(saved.taskRouting).toEqual(action === 'route' ? { chat: 'model-host-generate' } : {})
    expect(updateConfig).not.toHaveBeenCalled()
  })
  it.each(['enable', 'route', 'default'])('does not alter configuration when managed readiness fails during %s', async action => {
    generationProfile.mockRejectedValue(new Error('not ready'))
    const call = action === 'enable' ? handlers['brains:setEnabled']({}, { id: 'model-host-generate', enabled: true })
      : action === 'route' ? handlers['brains:setTaskRouting']({}, { task: 'chat', id: 'model-host-generate' })
      : handlers['brains:setDefault']({}, { id: 'model-host-generate' })
    await expect(call).rejects.toThrow('not ready')
    expect(replaceConfigSection).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
  })
  it('does not accept a text-only engine for audio, embedding, or agentic roles', async () => {
    for (const task of ['embed', 'transcribeAnalyze', 'handover'])
      await expect(handlers['brains:setTaskRouting']({}, { task, id: 'model-host-generate' })).rejects.toThrow('text roles')
    expect(generationProfile).not.toHaveBeenCalled()
    expect(replaceConfigSection).not.toHaveBeenCalled()
  })

  it('registers all eight brains:* channels', () => {
    for (const ch of [
      'brains:list',
      'brains:getRouting',
      'brains:setEnabled',
      'brains:setDefault',
      'brains:setTaskRouting',
      'brains:setCredential',
      'brains:getOpenAiCompatible',
      'brains:setOpenAiCompatible',
    ]) {
      expect(ipcMain.handle).toHaveBeenCalledWith(ch, expect.any(Function))
    }
  })

  it('brains:list projects registry + config + auth into serialisable items', async () => {
    const res = await handlers['brains:list']()
    expect(res).toHaveLength(2)
    expect(res[0]).toEqual({
      id: 'gemini-api',
      label: 'Gemini (API key)',
      capabilities: ['generate', 'chat', 'embed', 'analyzeAudio'],
      enabled: true,
      isDefault: true,
      auth: { configured: true, method: 'api-key', detail: 'Key set' },
    })
    expect(res[1]).toMatchObject({ id: 'claude-code', enabled: false, isDefault: false })
    expect(res[1].auth).toEqual({ configured: false, method: 'cli-login', detail: 'Needs login' })
  })

  it('brains:list survives a brain whose authStatus throws', async () => {
    vi.mocked(getBrainRegistry).mockReturnValue({
      get: () => null,
      list: () => [
        BRAINS[0],
        fakeBrain('codex', 'Codex', ['generate', 'agentic'], () => Promise.reject(new Error('boom'))),
      ],
    } as any)
    registerBrainsHandlers()
    const res = await handlers['brains:list']({} as any)
    expect(res).toHaveLength(2)
    expect(res[1].id).toBe('codex')
    expect(res[1].auth.configured).toBe(false)
  })

  it('brains:setEnabled persists a merged enabled map', async () => {
    const res = await handlers['brains:setEnabled']({}, { id: 'claude-code', enabled: true })
    expect(res).toEqual({ success: true })
    expect(updateConfig).toHaveBeenCalledWith('brains', {
      enabled: { ...CONFIG_BRAINS.enabled, 'claude-code': true },
    })
  })

  it('brains:setDefault persists the new default brain', async () => {
    await handlers['brains:setDefault']({}, { id: 'ollama' })
    expect(updateConfig).toHaveBeenCalledWith('brains', { defaultBrain: 'ollama' })
  })

  it('brains:setTaskRouting sets and clears a per-task override by replacing the section', async () => {
    // updateConfig merges deeply and would keep a cleared override, so the section is replaced.
    await handlers['brains:setTaskRouting']({}, { task: 'chat', id: 'ollama' })
    expect(replaceConfigSection).toHaveBeenCalledWith('brains', { ...CONFIG_BRAINS, taskRouting: { chat: 'ollama' } })

    vi.mocked(getConfig).mockReturnValue({
      brains: { ...CONFIG_BRAINS, taskRouting: { chat: 'ollama' } },
    } as any)
    await handlers['brains:setTaskRouting']({}, { task: 'chat', id: null })
    expect(replaceConfigSection).toHaveBeenLastCalledWith('brains', { ...CONFIG_BRAINS, taskRouting: {} })
    expect(updateConfig).not.toHaveBeenCalled()
  })

  describe('the OpenAI-compatible connection', () => {
    it('brains:getOpenAiCompatible returns the saved connection with the defaults filled in, and whether a key is stored, never the key', async () => {
      expect(await handlers['brains:getOpenAiCompatible']()).toEqual({
        baseUrl: 'http://localhost:1234/v1',
        model: '',
        embeddingModel: '',
        hasKey: false,
      })
      vi.mocked(getConfig).mockReturnValue({
        brains: { ...CONFIG_BRAINS, openaiCompatible: { baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-8b', embeddingModel: 'nomic' } },
      } as any)
      hasSecret.mockReturnValue(true)
      const saved = await handlers['brains:getOpenAiCompatible']()
      expect(saved).toEqual({ baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-8b', embeddingModel: 'nomic', hasKey: true })
      expect(hasSecret).toHaveBeenCalledWith('openai-compatible', 'apiKey')
    })

    it('brains:getOpenAiCompatible still answers when the credential store cannot be read', async () => {
      hasSecret.mockImplementation(() => {
        throw new Error('store locked')
      })
      expect(await handlers['brains:getOpenAiCompatible']()).toMatchObject({ hasKey: false })
    })

    it('brains:setOpenAiCompatible saves a valid connection with the values trimmed, leaving the other brain settings', async () => {
      const result = await handlers['brains:setOpenAiCompatible']({}, { baseUrl: ' http://192.168.1.20:1234/v1 ', model: ' qwen3-8b ', embeddingModel: '' })
      expect(result).toEqual({ success: true })
      expect(replaceConfigSection).toHaveBeenCalledWith('brains', {
        ...CONFIG_BRAINS,
        openaiCompatible: { baseUrl: 'http://192.168.1.20:1234/v1', model: 'qwen3-8b', embeddingModel: '' },
      })
    })

    it('brains:setOpenAiCompatible refuses an address that is not http or https, a name that is too long, and a malformed request', async () => {
      for (const bad of [
        { baseUrl: 'file:///etc/passwd', model: '', embeddingModel: '' },
        { baseUrl: 'ftp://host/v1', model: '', embeddingModel: '' },
        { baseUrl: 'javascript:alert(1)', model: '', embeddingModel: '' },
        { baseUrl: 'localhost:1234', model: '', embeddingModel: '' },
        { baseUrl: '', model: '', embeddingModel: '' },
        { baseUrl: 'http://x/v1', model: 'm'.repeat(201), embeddingModel: '' },
        { baseUrl: 'http://x/v1', model: '', embeddingModel: 'e'.repeat(201) },
        { baseUrl: 7, model: '', embeddingModel: '' },
        null,
        'http://x/v1',
      ]) {
        const result = await handlers['brains:setOpenAiCompatible']({}, bad)
        expect(result.success, JSON.stringify(bad)).toBe(false)
        expect(typeof result.error).toBe('string')
      }
      expect(replaceConfigSection).not.toHaveBeenCalled()
    })

    it('brains:setOpenAiCompatible reports a failed write as an error', async () => {
      vi.mocked(replaceConfigSection).mockRejectedValueOnce(new Error('disk full'))
      expect(await handlers['brains:setOpenAiCompatible']({}, { baseUrl: 'http://x/v1', model: '', embeddingModel: '' })).toEqual({
        success: false,
        error: 'disk full',
      })
    })
  })

  it('brains:setCredential writes to the credential store', async () => {
    const res = await handlers['brains:setCredential']({}, { id: 'codex', field: 'OPENAI_API_KEY', value: 'sk-x' })
    expect(res).toEqual({ success: true })
    expect(setSecret).toHaveBeenCalledWith('codex', 'OPENAI_API_KEY', 'sk-x')
  })
})
