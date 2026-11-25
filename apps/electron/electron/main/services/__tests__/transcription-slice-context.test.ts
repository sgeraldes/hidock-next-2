// @vitest-environment node
import { expect, it } from 'vitest'
import { sliceContext } from '../transcription-slice-context'

it('rebases and clamps VAD, acoustic segments and duration to the extracted slice', () => {
  const result = sliceContext('RECORDING METADATA:\nDuration: 900 seconds', 300, 300,
    [{ start: 290, end: 310 }, { start: 360, end: 650 }, { start: 700, end: 800 }],
    { available: true, model: 'test', modelVersion: null, device: null, matches: [], segments: [
      { start: 360, end: 650, speaker: 'voice-alice' }, { start: 700, end: 800, speaker: 'voice-bob' }
    ] } as any)
  expect(result).toContain('Duration: 300 seconds')
  expect(result).toContain('Activity intervals: 0-10s, 60-300s')
  expect(result).toContain('60.00-300.00s voice-alice')
  expect(result).not.toContain('voice-bob')
  expect(result).not.toContain('360-650')
})
