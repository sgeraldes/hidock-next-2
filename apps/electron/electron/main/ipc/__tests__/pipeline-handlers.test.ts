/**
 * The pipeline:* channels of the Settings > Pipeline page: the state it draws, saving one step, and the
 * models a harness offers.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { AUTO_PROFILE, emptyPipelineConfig, type HarnessInfo, type PipelineConfig } from '../../../../src/shared/pipeline-config'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const state = vi.hoisted(() => {
  const info = (over: Record<string, unknown> & { id: string }) => ({
    label: over.id,
    vendor: 'v',
    kind: 'api',
    textCapable: true,
    modelSelectable: true,
    effortLevels: null,
    dataLeavesMachine: true,
    latency: 'fast',
    ...over
  })
  return {
    config: { pipeline: undefined as unknown },
    harnesses: [
      info({ id: 'gemini-api', vendor: 'Google' }),
      info({ id: 'ollama', kind: 'local', dataLeavesMachine: false, latency: 'medium' }),
      info({ id: 'claude-code', vendor: 'Anthropic', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      info({ id: 'kiro', kind: 'cli', latency: 'slow', modelSelectable: false }),
      info({ id: 'jev', kind: 'special', textCapable: false })
    ],
    available: { 'gemini-api': true, ollama: true, 'claude-code': false, kiro: true } as Record<string, boolean>,
    cooling: new Set<string>(),
    auth: {} as Record<string, { configured: boolean; method: string; detail?: string }>,
    stats: { value: {} as Record<string, unknown>, throws: false },
    models: [] as Array<{ id: string; label?: string }>,
    saveDelayMs: 0
  }
})

vi.mock('../../services/config', () => ({
  getConfig: () => state.config,
  replaceConfigSection: vi.fn(async (_section: string, value: unknown) => {
    if (state.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, state.saveDelayMs))
    state.config.pipeline = value
  })
}))

vi.mock('../../services/pipeline/harness-info', () => ({ listHarnessInfos: () => state.harnesses }))

vi.mock('../../services/pipeline/call-store', () => ({
  getStepStats: vi.fn(() => {
    if (state.stats.throws) throw new Error('The call ledger is not installed')
    return state.stats.value
  })
}))

vi.mock('../../services/brains/brain-cooldown', () => ({ isBrainCoolingDown: (id: string) => state.cooling.has(id) }))

vi.mock('../../services/brains', () => ({
  getBrainRouter: () => ({ canServe: async (id: string) => state.available[id] ?? false }),
  getBrainRegistry: () => ({
    get: (id: string) => ({
      id,
      authStatus: async () => state.auth[id] ?? { configured: true, method: 'api-key' }
    })
  }),
  discoverModels: vi.fn(async () => state.models)
}))

import { registerPipelineHandlers } from '../pipeline-handlers'
vi.mock('../../services/pipeline/decision-engines', () => ({
  createDecisionEngines: async () => [{ id: 'clef', descriptor: { label: 'Clef', costPerCallUsd: 0, dataLeavesMachine: 'lan' }, isAvailable: async () => true }]
}))
import { replaceConfigSection } from '../../services/config'
import { discoverModels } from '../../services/brains'
const labelService = vi.hoisted(() => ({ getLabelSet: vi.fn(), getLabelItem: vi.fn(), saveLabel: vi.fn(), clearLabel: vi.fn() }))
vi.mock('../../services/pipeline/decision-labels', () => labelService)

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<any>
let handlers: Record<string, IpcHandler>
const call = (channel: string, arg?: unknown) => handlers[channel]({}, arg)

describe('decision settings', () => {
  it('registers reference label reads and mutations', async () => {
    const args = { setId: 'set', recordingId: 'recording' }
    labelService.getLabelSet.mockReturnValue({ id: 'set' })
    expect(await call('pipeline:getLabelSet')).toEqual({ id: 'set' })
    await call('pipeline:getLabelItem', args)
    await call('pipeline:saveLabel', { ...args, answer: 'interview' })
    await call('pipeline:clearLabel', args)
    expect(labelService.getLabelItem).toHaveBeenCalledWith(args)
    expect(labelService.saveLabel).toHaveBeenCalledWith({ ...args, answer: 'interview' })
    expect(labelService.clearLabel).toHaveBeenCalledWith(args)
  })
  it('replaces removable overrides while preserving text plans', async () => {
    state.config.pipeline = { ...emptyPipelineConfig(), decisions: { preset: 'zero-cost', overrides: { evaluate: 'jev' } } }
    expect(await call('pipeline:saveDecisions', { preset: 'fastest', overrides: {} })).toEqual({ success: true })
    expect(state.config.pipeline).toEqual({ ...emptyPipelineConfig(), decisions: { preset: 'fastest', overrides: {} } })
  })
  it('rejects unknown presets, steps and engines', async () => {
    for (const config of [{ preset: 'bad', overrides: {} }, { preset: 'fastest', overrides: { notes: 'jev' } }, { preset: 'fastest', overrides: { evaluate: 'bad' } }]) {
      expect(await call('pipeline:saveDecisions', config)).toMatchObject({ success: false })
    }
  })
  it('reports decision engine availability and cost', async () => {
    expect((await call('pipeline:getState')).decisionEngines).toEqual([{ id: 'clef', label: 'Clef', costPerCallUsd: 0, dataLeavesMachine: 'lan', available: true }])
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  state.config.pipeline = undefined
  state.available = { 'gemini-api': true, ollama: true, 'claude-code': false, kiro: true }
  state.cooling = new Set()
  state.auth = {}
  state.stats = { value: {}, throws: false }
  state.models = []
  state.saveDelayMs = 0
  handlers = {}
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: IpcHandler) => {
    handlers[channel] = handler
    return undefined
  }) as never)
  registerPipelineHandlers()
})

describe('registerPipelineHandlers', () => {
  it('registers the eight pipeline channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(['pipeline:clearLabel', 'pipeline:getLabelItem', 'pipeline:getLabelSet', 'pipeline:getState', 'pipeline:listModels', 'pipeline:saveDecisions', 'pipeline:saveLabel', 'pipeline:saveStep'])
  })
})

describe('pipeline:getState', () => {
  it('returns the configuration, the text-capable harnesses with their availability, and the stats', async () => {
    state.stats.value = { notes: { calls: 3, failed: 0, medianMs: 1500, medianCostUsd: null } }
    state.auth['claude-code'] = { configured: false, method: 'cli-login', detail: 'Not signed in' }
    const result = await call('pipeline:getState')
    expect(result.config).toEqual(emptyPipelineConfig())
    expect(result.harnesses.map((h: HarnessInfo) => h.id)).toEqual(['gemini-api', 'ollama', 'claude-code', 'kiro'])
    expect(result.harnesses.find((h: { id: string }) => h.id === 'gemini-api')).toMatchObject({ available: true, reason: null })
    expect(result.harnesses.find((h: { id: string }) => h.id === 'claude-code')).toMatchObject({ available: false, reason: 'Not signed in' })
    expect(result.stats).toEqual({ notes: { calls: 3, failed: 0, medianMs: 1500, medianCostUsd: null } })
  })

  it('says why a harness has no turn: resting after its quota, signed out, or turned off', async () => {
    state.available = { 'gemini-api': false, ollama: false, 'claude-code': false, kiro: true }
    state.cooling.add('gemini-api')
    state.auth['claude-code'] = { configured: false, method: 'cli-login', detail: 'claude is not on PATH' }
    const byId = Object.fromEntries((await call('pipeline:getState')).harnesses.map((h: { id: string }) => [h.id, h]))
    expect(byId['gemini-api'].reason).toMatch(/quota/i)
    expect(byId['claude-code'].reason).toBe('claude is not on PATH')
    expect(byId.ollama.reason).toMatch(/Settings > AI providers/)
  })

  it('returns the configuration the owner saved', async () => {
    const saved: PipelineConfig = {
      version: 1,
      profiles: { ollama: { harness: 'ollama' } },
      steps: { notes: { passes: [{ calls: [{ profile: 'ollama', tasks: '*', role: 'produce' }] }] } }
    }
    state.config.pipeline = saved
    expect((await call('pipeline:getState')).config).toEqual(saved)
  })

  it('still answers, with no stats, when the ledger cannot be read', async () => {
    state.stats.throws = true
    const result = await call('pipeline:getState')
    expect(result.stats).toEqual({})
    expect(result.harnesses.length).toBe(4)
  })

  it('still answers when a harness status cannot be read', async () => {
    state.available['claude-code'] = false
    state.auth = new Proxy({}, { get: () => { throw new Error('boom') } })
    const result = await call('pipeline:getState')
    expect(result.harnesses.find((h: { id: string }) => h.id === 'claude-code').available).toBe(false)
  })
})

describe('pipeline:saveStep', () => {
  it('saves a valid draft by replacing the section, and returns success', async () => {
    const result = await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama', model: 'qwen3:8b' }, fallback: null })
    expect(result).toMatchObject({ success: true })
    expect(replaceConfigSection).toHaveBeenCalledTimes(1)
    expect(replaceConfigSection).toHaveBeenCalledWith('pipeline', {
      version: 1,
      profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' } },
      steps: { notes: { passes: [{ calls: [{ profile: 'ollama-qwen3-8b', tasks: '*', role: 'produce' }] }] } }
    })
  })

  it('refuses a draft with an error, saves nothing, and returns the issue', async () => {
    const result = await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'jev' }, fallback: null })
    expect(result.success).toBe(false)
    expect(result.issues[0].message).toMatch(/cannot write text/)
    expect(replaceConfigSection).not.toHaveBeenCalled()
  })

  it('is not stopped by a hand-edited error in a step the owner is not changing', async () => {
    state.config.pipeline = {
      version: 1,
      profiles: {},
      steps: { chat: { passes: [{ calls: [{ profile: 'ghost', tasks: '*', role: 'produce' }] }] } }
    }
    const result = await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama' }, fallback: null })
    expect(result.success).toBe(true)
    expect(replaceConfigSection).toHaveBeenCalledTimes(1)
  })

  it('refuses a fallback that is the same as the main choice', async () => {
    const same = { harness: 'ollama', model: 'm' }
    const result = await call('pipeline:saveStep', { step: 'chat', primary: same, fallback: same })
    expect(result.success).toBe(false)
    expect(result.issues[0].message).toMatch(/same/)
  })

  it('asks for confirmation once when a slow harness is chosen for a step that runs in bulk, then saves', async () => {
    const draft = { step: 'self-id', primary: { harness: 'claude-code' }, fallback: null }
    const first = await call('pipeline:saveStep', draft)
    expect(first).toMatchObject({ success: false, needsConfirmation: true })
    expect(replaceConfigSection).not.toHaveBeenCalled()
    const second = await call('pipeline:saveStep', { ...draft, confirmSlow: true })
    expect(second.success).toBe(true)
    expect(replaceConfigSection).toHaveBeenCalledTimes(1)
  })

  it('does not ask for confirmation for a slow harness on an interactive step', async () => {
    const result = await call('pipeline:saveStep', { step: 'chat', primary: { harness: 'claude-code' }, fallback: null })
    expect(result.success).toBe(true)
  })

  it('refuses a malformed request without throwing and without saving', async () => {
    for (const bad of [
      null,
      'notes',
      { step: 'nope', primary: 'auto', fallback: null },
      { step: 'notes', primary: 7, fallback: null },
      { step: 'notes', primary: { harness: 3 }, fallback: null },
      { step: 'notes', primary: 'auto', fallback: [] },
      { step: 'notes', primary: 'auto' }
    ]) {
      const result = await call('pipeline:saveStep', bad)
      expect(result.success, JSON.stringify(bad)).toBe(false)
    }
    expect(replaceConfigSection).not.toHaveBeenCalled()
  })

  it('serialises two saves that arrive together, so the second starts from what the first saved', async () => {
    state.saveDelayMs = 10
    const [a, b] = await Promise.all([
      call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama', model: 'a' }, fallback: null }),
      call('pipeline:saveStep', { step: 'reformat', primary: { harness: 'ollama', model: 'b' }, fallback: null })
    ])
    expect(a.success && b.success).toBe(true)
    const saved = state.config.pipeline as PipelineConfig
    expect(Object.keys(saved.steps).sort()).toEqual(['notes', 'reformat'])
    expect(Object.keys(saved.profiles).sort()).toEqual(['ollama-a', 'ollama-b'])
  })

  it('removes a step and the profile nobody uses when the draft is Automatic with no fallback', async () => {
    await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama', model: 'a' }, fallback: null })
    const result = await call('pipeline:saveStep', { step: 'notes', primary: AUTO_PROFILE, fallback: null })
    expect(result.success).toBe(true)
    expect(state.config.pipeline).toEqual(emptyPipelineConfig())
  })

  it('reports a failed write as an error and keeps going', async () => {
    vi.mocked(replaceConfigSection).mockRejectedValueOnce(new Error('disk full'))
    const failed = await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama' }, fallback: null })
    expect(failed).toMatchObject({ success: false, error: 'disk full' })
    const next = await call('pipeline:saveStep', { step: 'notes', primary: { harness: 'ollama' }, fallback: null })
    expect(next.success).toBe(true)
  })
})

describe('pipeline:listModels', () => {
  it('returns the models of a text-capable harness through the discovery cache', async () => {
    state.models = [{ id: 'qwen3:8b' }, { id: 'llama3.2:3b', label: 'Llama' }]
    expect(await call('pipeline:listModels', { harness: 'ollama' })).toEqual(state.models)
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('returns nothing for a harness it does not know, one that cannot write text, or a bad request', async () => {
    expect(await call('pipeline:listModels', { harness: 'nope' })).toEqual([])
    expect(await call('pipeline:listModels', { harness: 'jev' })).toEqual([])
    expect(await call('pipeline:listModels', null)).toEqual([])
    expect(await call('pipeline:listModels', { harness: 7 })).toEqual([])
    expect(discoverModels).not.toHaveBeenCalled()
  })
})
