// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compareRepairVoices, type VoiceObservation } from '../repair-voice-evidence'
const row = (label: string, embedding: unknown, over: Partial<VoiceObservation> = {}): VoiceObservation =>
  ({ label, embedding, model: 'voice-model', version: '1', dimension: 2, speechSeconds: 12, ...over })
describe('recording-local acoustic comparisons', () => {
  it('reports measured similarity without treating it as calibrated identity confidence', () => {
    const result = compareRepairVoices([row('A', [1, 0]), row('B', [2, 0]), row('C', [0, 1])])
    expect(result.comparisons).toEqual([
      { a: 'A', b: 'B', cosineSimilarity: 1 }, { a: 'A', b: 'C', cosineSimilarity: 0 },
      { a: 'B', b: 'C', cosineSimilarity: 0 }
    ])
    expect(result.confidenceCalibrated).toBe(false)
    expect(JSON.stringify(result)).not.toContain('embedding":')
  })
  it('never compares incompatible spaces or invalid/zero vectors', () => {
    expect(compareRepairVoices([row('A', [1, 0]), row('version', [1, 0], { version: '2' }),
      row('model', [1, 0], { model: 'different' }), row('dimension', [1, 0], { dimension: 3 }),
      row('nan', [NaN, 1]), row('zero', [0, 0])]).comparisons).toEqual([])
  })
})
