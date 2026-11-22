import { describe, expect, it } from 'vitest'
import { parseAsrOutput, ASR_MODELS } from '../src/asr.mjs'

const result = { model: 'CohereLabs/cohere-transcribe-03-2026', modelVersion: 'fixture',
  text: 'Speaker 1: Hello', segments: [{ start: 0, end: 1, speaker: 'Speaker 1', text: 'Hello' }] }

describe('ASR output boundary', () => {
  it('accepts only the explicit native Nemotron model identity', () => {
    const model = 'nvidia/nemotron-3.5-asr-streaming-0.6b'
    expect(ASR_MODELS.has(model)).toBe(true)
    expect(parseAsrOutput(JSON.stringify({ ...result, model })).model).toBe(model)
    expect(ASR_MODELS.has('nvidia/nemotron')).toBe(false)
  })
  it('preserves valid transcript and engine provenance', () => {
    expect(parseAsrOutput(JSON.stringify(result))).toEqual(result)
  })
  it.each([
    { model: 'unadvertised' }, { modelVersion: undefined }, { text: undefined }, { segments: {} },
    ...[{ start: -1 }, { end: 0 }, { end: null }, { speaker: undefined }, { text: 42 }]
      .map(change => ({ segments: [{ ...result.segments[0], ...change }] }))
  ])('rejects incomplete or invalid output: %j', change => {
    expect(() => parseAsrOutput(JSON.stringify({ ...result, ...change }))).toThrow()
  })
})
