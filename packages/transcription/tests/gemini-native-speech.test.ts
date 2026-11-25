// GeminiEngine with speechIntervals: only the stretches with voice are sent, times come back on
// the recording's timeline, and a short answer is judged against the voice (16-oct-2026).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInteractionsCreate = vi.fn()
const mockFilesUpload = vi.fn()
const mockFilesGet = vi.fn()
const mockFilesDelete = vi.fn()

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContentStream: vi.fn() }
    interactions = { create: mockInteractionsCreate }
    files = { upload: mockFilesUpload, get: mockFilesGet, delete: mockFilesDelete }
  }
  return {
    GoogleGenAI,
    FileState: { PROCESSING: 'PROCESSING', ACTIVE: 'ACTIVE', FAILED: 'FAILED' },
    ThinkingLevel: { MINIMAL: 'MINIMAL' },
    Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', BOOLEAN: 'BOOLEAN' },
  }
})

import { GeminiEngine } from '../src/engines/gemini-engine.js'

const RATE = 8000
/** Mono 16-bit PCM WAV of `seconds` (silence; the engine never decodes it, the provider is mocked). */
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

const uploadedSeconds: number[] = []
beforeEach(() => {
  vi.clearAllMocks()
  uploadedSeconds.length = 0
  mockFilesUpload.mockImplementation(async ({ file, config }: { file: Blob; config: { mimeType: string } }) => {
    const bytes = Buffer.from(await file.arrayBuffer())
    uploadedSeconds.push(bytes.readUInt32LE(40) / (RATE * 2))
    return { name: `files/${uploadedSeconds.length}`, state: 'ACTIVE', uri: `files://${uploadedSeconds.length}`, mimeType: config.mimeType }
  })
  mockFilesDelete.mockResolvedValue(undefined)
})

/** One word per request at `offset` seconds into the span sent. */
function wordAt(offset: number, text = 'hola') {
  return { status: 'completed', steps: [{ content: [{ annotations: [
    { type: 'word_info', text, speaker: 'spk_0', start_offset: `${offset}s`, end_offset: `${offset + 0.4}s` },
  ] }] }] }
}

const engine = () => new GeminiEngine({ apiKey: 'x', model: 'gemini-3.5-transcribe', language: 'es' })

describe('GeminiEngine with speechIntervals', () => {
  it('a channel with no voice makes no request at all', async () => {
    const segments = await collect(engine().transcribe(wav(600), { source: 'mic', durationSeconds: 600, speechIntervals: [] }))
    expect(segments).toEqual([])
    expect(mockFilesUpload).not.toHaveBeenCalled()
    expect(mockInteractionsCreate).not.toHaveBeenCalled()
  })

  it('sends only the stretches with voice and puts the words back on the recording timeline', async () => {
    mockInteractionsCreate.mockResolvedValueOnce(wordAt(1)).mockResolvedValueOnce(wordAt(2))
    const segments = await collect(engine().transcribe(wav(600), {
      source: 'mic', durationSeconds: 600, speechIntervals: [{ start: 100, end: 110 }, { start: 400, end: 404 }],
    }))
    // Two spans (the 290 s silence between them is skipped), each padded by 0.5 s.
    expect(uploadedSeconds.map((s) => Math.round(s * 10) / 10)).toEqual([11, 5])
    expect(segments.map((s) => Math.round(s.startTime * 10) / 10)).toEqual([100.5, 401.5])
  })

  it('a short answer is fine when the voice ends early in the span (the Rec12/Rec16 false failures)', async () => {
    // Voice for the first 20 s, then a lone blip; Gemini covers the 20 s.
    mockInteractionsCreate.mockResolvedValueOnce(wordAt(19))
    const segments = await collect(engine().transcribe(wav(600), {
      source: 'mic', durationSeconds: 600, speechIntervals: [{ start: 0, end: 20 }, { start: 40, end: 40.3 }],
    }))
    expect(segments).toHaveLength(1)
  })

  it('text that stops while the voice goes on is still caught (the Rec07 case)', async () => {
    // Voice 0-300 s in one span; Gemini answers with words only up to 125 s.
    mockInteractionsCreate.mockResolvedValueOnce(wordAt(125))
    await expect(collect(engine().transcribe(wav(600), {
      source: 'mic', durationSeconds: 600, speechIntervals: [{ start: 0, end: 300 }],
    }))).rejects.toThrow(/Provider response retained: text ends at 2:05 but voice continues to 5:00/)
  })

  it('never sends a span longer than the per-request cap', async () => {
    // Each answer reaches the end of the span it was given, so every span is complete.
    mockInteractionsCreate.mockImplementation(async () => wordAt(uploadedSeconds.at(-1)! - 1))
    const segments = await collect(engine().transcribe(wav(900), {
      source: 'mic', durationSeconds: 900, speechIntervals: [{ start: 0, end: 900 }],
    }))
    expect(segments).toHaveLength(uploadedSeconds.length)
    expect(uploadedSeconds.length).toBeGreaterThan(1)
    expect(Math.max(...uploadedSeconds)).toBeLessThanOrEqual(GeminiEngine.NATIVE_SPEECH_SPAN_SECONDS)
  })
})
