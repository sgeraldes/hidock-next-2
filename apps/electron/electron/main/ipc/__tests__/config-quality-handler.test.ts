/**
 * config:update-section('quality') hands the old and new rules to the
 * recompute, so stored warnings and reasons can follow a changed rule.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { applyQualityRules, resolveQualityRules } from '../../services/quality-rules'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const recompute = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  shell: { openExternal: vi.fn() }
}))
vi.mock('../../services/config', () => ({
  getConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
  // The real updateConfig refreshes the rules through applyQualityRules.
  updateConfig: vi.fn(async (section: string, values: unknown) => {
    if (section === 'quality') applyQualityRules({ quality: values })
  }),
  RETIRED_GEMINI_MODELS: [],
  getDefaultConfig: vi.fn(() => ({}))
}))
vi.mock('../../services/connectors', () => ({ startConnectorSchedule: vi.fn() }))
vi.mock('../../services/file-storage', () => ({ initializeFileStorage: vi.fn() }))
vi.mock('../../services/gemini-models', () => ({ listGeminiTranscriptionModels: vi.fn() }))
vi.mock('../../services/activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../../services/feature-gate', () => ({ getResolvedFeatures: vi.fn() }))
vi.mock('../../services/feature-lifecycle', () => ({ reconcileFeatures: vi.fn() }))
vi.mock('../../services/speaker-model-access', () => ({ checkSpeakerModelAccess: vi.fn(), SPEAKER_MODEL_ACCESS_URL: '' }))
vi.mock('../../services/quality-recompute', () => ({ recomputeForQualityChange: recompute }))

import { registerConfigHandlers } from '../config-handlers'

describe('config:update-section quality', () => {
  it('passes the rules before and after the save to the recompute', async () => {
    applyQualityRules({})
    registerConfigHandlers()
    const result = (await handlers.get('config:update-section')!({}, 'quality', { meaningfulWords: 150 })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(recompute).toHaveBeenCalledWith(resolveQualityRules({}), resolveQualityRules({ meaningfulWords: 150 }))
  })

  it('leaves the recompute alone for any other section', async () => {
    recompute.mockClear()
    registerConfigHandlers()
    await handlers.get('config:update-section')!({}, 'ui', { skipSeconds: 5 })
    expect(recompute).not.toHaveBeenCalled()
  })
})
