// @vitest-environment node

/**
 * ADV43-3 (round-45) — the production sentiment scorer (geminiWindowScorer)
 * awaits a DYNAMIC config import BEFORE its generateContent call. An owner
 * exclusion committed during that setup await must abort the provider call. The
 * scorer receives a fail-closed shouldGenerate gate, re-checks it SYNCHRONOUSLY
 * after the awaited setup and immediately before generateContent, and returns an
 * empty score map (sentiment omitted, NO provider call) on false/throw.
 *
 * deriveSentimentSegments must FORWARD the gate to whichever scorer it uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGenerateContent = vi.fn(async () => ({
  response: { text: () => '[{"i":0,"score":0.5}]' },
}))
const mockGetGenerativeModel = vi.fn(() => ({ generateContent: mockGenerateContent }))
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(function () {
    return { getGenerativeModel: mockGetGenerativeModel }
  }),
}))
// geminiWindowScorer resolves getConfig via a DYNAMIC import — mocking the module
// makes that dynamic import resolve to this fake (with a key configured).
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { geminiApiKey: 'k', geminiModel: 'gemini-3.5-flash' } }),
}))

import { geminiWindowScorer, deriveSentimentSegments, type SentimentWindow } from '../timeline-analysis'
import { CURRENT_GEMINI_CHAT_MODEL } from '../gemini-model-ids'
import { setCallSink, type CallRecord } from '../pipeline/call-store'

const WINDOWS: SentimentWindow[] = [
  { index: 0, startSec: 0, endSec: 30, text: 'hola qué tal' },
  { index: 1, startSec: 30, endSec: 60, text: 'todo bien' },
]

describe('geminiWindowScorer shouldGenerate gate (round-45 ADV43-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exclusion during the setup await (gate false) ⇒ generateContent NOT called, empty scores', async () => {
    const scores = await geminiWindowScorer(WINDOWS, () => false)
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(scores.size).toBe(0)
  })

  it('a gate that THROWS is fail-closed ⇒ generateContent NOT called', async () => {
    const scores = await geminiWindowScorer(WINDOWS, () => {
      throw new Error('eligibility lookup failed')
    })
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(scores.size).toBe(0)
  })

  it('control: a gate that stays true calls generateContent and returns scores', async () => {
    const scores = await geminiWindowScorer(WINDOWS, () => true)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(scores.get(0)).toBe(0.5)
  })

  it('no gate configured ⇒ unchanged legacy behaviour (provider called)', async () => {
    const scores = await geminiWindowScorer(WINDOWS)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(scores.get(0)).toBe(0.5)
  })
})

describe('deriveSentimentSegments forwards shouldGenerate to the scorer (round-45 ADV43-3)', () => {
  it('passes the gate through as the scorer’s second argument', async () => {
    const gate = () => true
    let received: (() => boolean) | undefined
    const spyScorer = vi.fn(async (_windows: SentimentWindow[], shouldGenerate?: () => boolean) => {
      received = shouldGenerate
      return new Map<number, number>()
    })
    await deriveSentimentSegments(
      [{ speaker: 'Speaker 1', start: 0, end: 30, text: 'hola a todos, empecemos la reunión de hoy' }],
      { scoreWindows: spyScorer, shouldGenerate: gate }
    )
    expect(spyScorer).toHaveBeenCalledTimes(1)
    expect(received).toBe(gate)
  })
})

describe('geminiWindowScorer leaves a ledger row (phase 2b)', () => {
  let rows: CallRecord[]

  beforeEach(() => {
    vi.clearAllMocks()
    rows = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
  })

  afterEach(() => {
    setCallSink(null)
  })

  it('writes one completed row for the one provider call, with the model and the tokens the response reported', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '[{"i":0,"score":0.5}]',
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, totalTokenCount: 1020 }
      }
    } as never)
    const scores = await geminiWindowScorer(WINDOWS, () => true)
    expect(scores.get(0)).toBe(0.5)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      step: 'timeline',
      recordingId: null,
      route: 'direct:gemini-sdk',
      provider: 'gemini-api',
      model: CURRENT_GEMINI_CHAT_MODEL,
      status: 'completed'
    })
    expect(rows[0].usage).toMatchObject({ calls: 1, tokens: { input: 900, output: 120 } })
  })

  it('still writes a row, with no usage figures, when the response carries no usage', async () => {
    await geminiWindowScorer(WINDOWS, () => true)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
  })

  it('writes a failed row and lets the error through, as before, when the provider call throws', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('503 overloaded'))
    await expect(geminiWindowScorer(WINDOWS, () => true)).rejects.toThrow('503 overloaded')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step: 'timeline', status: 'failed', errorMessage: expect.stringMatching(/503 overloaded/) })
  })

  it('writes no row when the source became ineligible and no provider call was made', async () => {
    await geminiWindowScorer(WINDOWS, () => false)
    expect(rows).toEqual([])
  })
})
