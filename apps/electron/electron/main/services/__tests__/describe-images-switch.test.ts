/**
 * "Describe images with AI" (Settings > Privacy & capture): off means no image
 * leaves the computer, even with a Gemini key.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { CURRENT_GEMINI_CHAT_MODEL } from '../gemini-model-ids'
import { setCallSink, type CallRecord } from '../pipeline/call-store'

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

describe('image description leaves a ledger row (phase 2b)', () => {
  let rows: CallRecord[]

  beforeEach(() => {
    rows = []
    cfg.capture = {}
    setCallSink((_id, record) => {
      rows.push(record)
    })
  })

  afterEach(() => {
    setCallSink(null)
  })

  it('writes one completed row for the vision call, with the model and the tokens, and returns the description as before', async () => {
    gemini.generateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ description: 'a whiteboard', tags: ['plan'] }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 90, totalTokenCount: 1590 }
      }
    })
    const result = await getArtifactType('image')!.extractText('shot.png', Buffer.from('png'))
    expect(result.metadata).toMatchObject({ description: 'a whiteboard', source: 'gemini-vision' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      step: 'image-describe',
      recordingId: null,
      route: 'direct:gemini-sdk',
      provider: 'gemini-api',
      model: CURRENT_GEMINI_CHAT_MODEL,
      status: 'completed'
    })
    expect(rows[0].usage).toMatchObject({ calls: 1, tokens: { input: 1500, output: 90 } })
  })

  it('writes a failed row, and the import still goes on without a description, when the vision call throws', async () => {
    gemini.generateContent.mockRejectedValue(new Error('429 quota'))
    const result = await getArtifactType('image')!.extractText('shot.png', Buffer.from('png'))
    expect(result.text).toBe('')
    expect(result.metadata).toMatchObject({ description: null, source: 'gemini-vision', error: '429 quota' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step: 'image-describe', status: 'failed', errorMessage: expect.stringMatching(/429 quota/) })
  })

  it('writes no row when the switch is off and no image leaves the computer', async () => {
    cfg.capture = { describeImages: false }
    await getArtifactType('image')!.extractText('shot.png', Buffer.from('png'))
    expect(rows).toEqual([])
  })
})
