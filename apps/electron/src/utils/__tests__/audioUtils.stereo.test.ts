import { expect, it } from 'vitest'
import { generateWaveformData } from '../audioUtils'
it('samples each channel independently, including short buffers and final samples', async () => {
  const buffer = { getChannelData: (channel: number) => new Float32Array(channel ? [0.8, -0.9, 0.7] : [0.1, -0.2, 0.3]) } as AudioBuffer
  expect(Array.from(await generateWaveformData(buffer, 2, 1))).toEqual([expect.closeTo(0.8), expect.closeTo(0.9)])
  expect(Array.from(await generateWaveformData(buffer, 5, 0))).toContainEqual(expect.closeTo(0.3))
})
