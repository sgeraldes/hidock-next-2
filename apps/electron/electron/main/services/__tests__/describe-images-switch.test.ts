/**
 * "Describe images with AI" (Settings > Privacy & capture): off means no image
 * leaves the computer, even with a Gemini key.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = vi.hoisted(() => ({ capture: { describeImages: true } as { describeImages?: boolean } }))
const gemini = vi.hoisted(() => ({ generateContent: vi.fn() }))

vi.mock('../config', () => ({
  getConfig: () => ({ capture: cfg.capture, chat: {}, transcription: {} })
}))
vi.mock('../brains', () => ({ resolveGeminiApiKey: () => 'key' }))
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: gemini.generateContent }
    }
  }
}))

import { getArtifactType } from '../artifact-types'

beforeEach(() => {
  gemini.generateContent.mockReset()
  gemini.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ description: 'a whiteboard', tags: ['plan'] }) } })
})

describe('describe images switch', () => {
  it('off: the image is not sent and the capture says why', async () => {
    cfg.capture = { describeImages: false }
    const result = await getArtifactType('image')!.extractText('shot.png', Buffer.from('png'))
    expect(gemini.generateContent).not.toHaveBeenCalled()
    expect(result.metadata).toMatchObject({ description: null, note: 'image description turned off in Settings' })
  })

  it('on (the default): the image is described', async () => {
    cfg.capture = {}
    await getArtifactType('image')!.extractText('shot.png', Buffer.from('png'))
    expect(gemini.generateContent).toHaveBeenCalledTimes(1)
  })
})
