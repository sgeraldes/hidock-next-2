/**
 * config:get-defaults gives Settings the shipped defaults for "Default:" and
 * Reset, with every secret field redacted like config:get (28-sep-2026).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  shell: { openExternal: vi.fn() }
}))
vi.mock('../../services/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
  RETIRED_GEMINI_MODELS: [],
  getDefaultConfig: () => ({
    embeddings: { chunkSize: 500, chunkOverlap: 50 },
    transcription: { geminiApiKey: '', localAsrHfToken: 'hf_should_not_leave', speakerLinkingMatchThreshold: 0.72 }
  })
}))
vi.mock('../../services/connectors', () => ({ startConnectorSchedule: vi.fn() }))
vi.mock('../../services/file-storage', () => ({ initializeFileStorage: vi.fn() }))
vi.mock('../../services/gemini-models', () => ({ listGeminiTranscriptionModels: vi.fn() }))
vi.mock('../../services/activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../../services/feature-gate', () => ({ getResolvedFeatures: vi.fn() }))
vi.mock('../../services/feature-lifecycle', () => ({ reconcileFeatures: vi.fn() }))
vi.mock('../../services/speaker-model-access', () => ({ checkSpeakerModelAccess: vi.fn(), SPEAKER_MODEL_ACCESS_URL: '' }))
vi.mock('../../services/quality-recompute', () => ({ recomputeForQualityChange: vi.fn() }))
vi.mock('../../services/retrieval-trace-service', () => ({ syncTraceSettings: vi.fn(), retrievalTraceStats: vi.fn() }))

import { registerConfigHandlers } from '../config-handlers'

describe('config:get-defaults', () => {
  it('returns the defaults with secrets redacted', async () => {
    registerConfigHandlers()
    const result = (await handlers.get('config:get-defaults')!()) as {
      success: boolean
      data: { embeddings: { chunkSize: number }; transcription: Record<string, unknown> }
    }
    expect(result.success).toBe(true)
    expect(result.data.embeddings.chunkSize).toBe(500)
    expect(result.data.transcription.speakerLinkingMatchThreshold).toBe(0.72)
    expect(JSON.stringify(result.data)).not.toContain('hf_should_not_leave')
  })
})
