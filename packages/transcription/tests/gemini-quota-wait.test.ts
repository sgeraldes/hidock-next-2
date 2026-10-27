// GeminiEngine waits out a rate limit on one span and sends that span again,
// instead of failing the whole recording (27-oct-2026: Rec14 and Rec16 ended in
// error at their second span on the free tier's 10,000 tokens per minute).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInteractionsCreate = vi.fn()
const mockFilesUpload = vi.fn()
const mockFilesDelete = vi.fn()

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContentStream: vi.fn() }
    interactions = { create: mockInteractionsCreate }
    files = { upload: mockFilesUpload, get: vi.fn(), delete: mockFilesDelete }
  }
  return {
    GoogleGenAI,
    FileState: { PROCESSING: 'PROCESSING', ACTIVE: 'ACTIVE', FAILED: 'FAILED' },
    ThinkingLevel: { MINIMAL: 'MINIMAL' },
    Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', BOOLEAN: 'BOOLEAN' },
  }
})

import { GeminiEngine, quotaRetrySeconds, retryAfterSeconds } from '../src/engines/gemini-engine.js'
import { TranscriptionCancelledError } from '../src/engines/engine-interface.js'

const RATE = 8000
function wav(seconds: number): Buffer {
  const body = Buffer.alloc(seconds * RATE * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + body.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(body.length, 40)
  return Buffer.concat([h, body])
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

const word = (offset: number) => ({ status: 'completed', steps: [{ content: [{ annotations: [
  { type: 'word_info', text: 'hola', speaker: 'spk_0', start_offset: `${offset}s`, end_offset: `${offset + 0.4}s` },
] }] }] })
const quota = (retry: string) => Object.assign(
  new Error(`429 Rate limit exceeded for model gemini-3.5-transcribe (limit: 10000 input tokens per minute on Free Tier). Please retry in ${retry} or upgrade`),
  { status: 429 })

beforeEach(() => {
  vi.clearAllMocks()
  let n = 0
  mockFilesUpload.mockImplementation(async ({ config }: { config: { mimeType: string } }) => {
    n++
    return { name: `files/${n}`, state: 'ACTIVE', uri: `files://${n}`, mimeType: config.mimeType }
  })
  mockFilesDelete.mockResolvedValue(undefined)
})

const engine = () => new GeminiEngine({ apiKey: 'x', model: 'gemini-3.5-transcribe', language: 'es' })
const twoSpans = { source: 'mic' as const, durationSeconds: 600, speechIntervals: [{ start: 10, end: 20 }, { start: 400, end: 410 }] }

describe('GeminiEngine and the rate limit', () => {
  it('reads the wait the provider asks for, and nothing from other errors', () => {
    expect(quotaRetrySeconds(quota('52s'))).toBe(53)
    expect(quotaRetrySeconds(quota('0.05s'))).toBeCloseTo(1.05)
    expect(quotaRetrySeconds(Object.assign(new Error('Resource has been exhausted'), { status: 429 }))).toBe(30)
    expect(quotaRetrySeconds(new Error('RESOURCE_EXHAUSTED: quota'))).toBe(30)
    expect(quotaRetrySeconds(new Error('fetch failed'))).toBeNull()
    expect(quotaRetrySeconds(Object.assign(new Error('400 Bad Request'), { status: 400 }))).toBeNull()
  })

  it('reads waits given in hours and minutes', () => {
    expect(retryAfterSeconds('Please retry in 18h17m50s or upgrade')).toBe(18 * 3600 + 17 * 60 + 50)
    expect(retryAfterSeconds('Please retry in 1m30s')).toBe(90)
    expect(retryAfterSeconds('Please retry in 52s')).toBe(52)
    expect(retryAfterSeconds('Please retry in 250ms')).toBeCloseTo(0.25)
    expect(retryAfterSeconds('no hint here')).toBeNull()
  })

  it('does not wait for a daily quota: the request fails at once (27-oct-2026, 25 requests per day)', async () => {
    const daily = Object.assign(new Error('429 Rate limit exceeded for model gemini-3.5-transcribe (limit: 25 requests per day on Free Tier). Please retry in 18h17m50s or upgrade'), { status: 429 })
    mockInteractionsCreate.mockResolvedValueOnce(word(1)).mockRejectedValue(daily)
    await expect(collect(engine().transcribe(wav(600), twoSpans))).rejects.toThrow(/25 requests per day/)
    expect(mockInteractionsCreate).toHaveBeenCalledTimes(2)
  })

  it('waits out a 429 on the second span and sends that span again', async () => {
    vi.useFakeTimers()
    try {
      mockInteractionsCreate
        .mockResolvedValueOnce(word(1))
        .mockRejectedValueOnce(quota('2s'))
        .mockResolvedValueOnce(word(2))
      const run = collect(engine().transcribe(wav(600), twoSpans))
      await vi.advanceTimersByTimeAsync(10_000)
      const segments = await run
      expect(segments.map((s) => Math.round(s.startTime * 10) / 10)).toEqual([10.5, 401.5])
      expect(mockInteractionsCreate).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on a span after the bounded number of waits', async () => {
    vi.useFakeTimers()
    try {
      mockInteractionsCreate.mockRejectedValue(quota('1s'))
      const run = collect(engine().transcribe(wav(600), twoSpans)).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(60_000)
      const error = await run
      expect(String(error)).toMatch(/429 Rate limit exceeded/)
      expect(mockInteractionsCreate).toHaveBeenCalledTimes(GeminiEngine.QUOTA_WAITS_PER_REQUEST + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting when the recording is cancelled', async () => {
    vi.useFakeTimers()
    try {
      let wanted = true
      mockInteractionsCreate.mockImplementation(async () => { wanted = false; throw quota('30s') })
      const run = collect(engine().transcribe(wav(600), { ...twoSpans, shouldGenerate: () => wanted })).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await run).toBeInstanceOf(TranscriptionCancelledError)
      expect(mockInteractionsCreate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
