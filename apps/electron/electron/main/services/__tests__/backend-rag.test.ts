// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ excluded: false, rawAnswer: 'RAW-DO-NOT-RELEASE' }))
vi.mock('../database', () => ({ queryOne: () => ({ id: 's1' }), run: vi.fn() }))
vi.mock('../feature-gate', () => ({ isFeatureEnabled: () => true }))
vi.mock('../pipeline/plans', () => ({ resolvePlan: () => ({ calls: [] }) }))
vi.mock('../recording-eligibility', () => ({
  filterEligibleRecordingIds: (ids: string[]) => ({ eligible: new Set(state.excluded ? [] : ids), failClosed: false }),
  filterEligibleCaptureIds: (ids: string[]) => ({ eligible: new Set(ids), failClosed: false }),
}))
vi.mock('../vector-store', () => ({ getVectorStore: () => ({ initialize: async () => {}, getEligibleDocumentCount: () => 1 }) }))
vi.mock('../rag', () => ({ getRAGService: () => ({
  chat: async () => ({ answer: state.rawAnswer, sources: [{ content: 'raw' }], generationId: 'g1' }),
  consumeAssistantAnswer: () => ({ kind: 'rag', content: 'main-owned answer', sources: '[{"content":"sanitized"}]', prov: { recordingIds: ['r1'], captureIds: [], unverifiable: false } }),
  cancelRequest: () => true,
}) }))
import { backendRagChat } from '../backend-rag'
describe('backend RAG release boundary', () => {
  beforeEach(() => { state.excluded = false })
  it('releases only the consumed main generation with revalidated provenance', async () => {
    const result = await backendRagChat('s1', 'question')
    expect(result).toMatchObject({ status: 'ok', answer: 'main-owned answer', sources: [{ content: 'sanitized' }], provenance: { recordingIds: ['r1'] } })
    expect(JSON.stringify(result)).not.toContain(state.rawAnswer)
  })
  it('redacts the entire answer when its source is excluded at release', async () => {
    state.excluded = true
    const result = await backendRagChat('s1', 'question')
    expect(result).toMatchObject({ status: 'redacted', sources: [] })
    expect(JSON.stringify(result)).not.toContain('main-owned answer')
    expect(JSON.stringify(result)).not.toContain(state.rawAnswer)
  })
})
