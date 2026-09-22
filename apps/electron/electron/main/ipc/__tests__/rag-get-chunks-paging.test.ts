/**
 * rag:get-chunks PAGE BOUNDS (2026-09).
 *
 * This handler used to return every chunk in the index in one response —
 * 237,920 rows with their text on the current library. The 500-row ceiling it
 * now applies is the thing that stops that from coming back, and the renderer
 * supplies offset/limit, so neither can be taken on trust.
 *
 * vector-store-page.test.ts covers what getDocumentPage does with the numbers.
 * This file covers the numbers the handler HANDS it: the default when the
 * renderer asks for nothing, the cap, and what a hostile or malformed request
 * gets normalized to. A mutation raising CHUNK_PAGE_MAX passed every other
 * suite, which is why these exist.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerRAGHandlers } from '../rag-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => 'test-path') }
}))

const getDocumentPage = vi.fn((offset: number, limit: number) => ({
  total: 1000,
  offset,
  limit,
  revision: 7,
  documents: []
}))

vi.mock('../../services/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    getDocumentCount: vi.fn(() => 0),
    getMeetingCount: vi.fn(() => 0),
    getEligibleDocumentCount: vi.fn(() => 0),
    getEligibleMeetingCount: vi.fn(() => 0),
    search: vi.fn(),
    getAllDocuments: vi.fn(() => []),
    getDocumentPage
  }))
}))

vi.mock('../../services/rag', () => ({ getRAGService: vi.fn(() => ({ chat: vi.fn() })) }))
vi.mock('../../services/chat-llm', () => ({
  getChatLLMService: vi.fn(() => ({ getStatus: vi.fn().mockResolvedValue({ backend: 'none' }) }))
}))
vi.mock('../../services/embeddings', () => ({
  getEmbeddingsService: vi.fn(() => ({ activeProviderId: vi.fn().mockResolvedValue(null) }))
}))
vi.mock('../../services/vector-startup-state', () => ({
  getVectorStartupState: vi.fn(() => ({ phase: 'ready', loaded: 0, total: 0, error: null }))
}))
vi.mock('../../services/database', () => ({
  getMeetingsForContact: vi.fn(() => []),
  getMeetingsForProject: vi.fn(() => [])
}))

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

/** The registered rag:get-chunks handler. */
function handler(): Handler {
  registerRAGHandlers()
  const entry = (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls.find(
    ([channel]) => channel === 'rag:get-chunks'
  )
  if (!entry) throw new Error('rag:get-chunks was never registered')
  return entry[1]
}

/** Invoke the handler and report the (offset, limit) it passed to the store. */
async function askedFor(request?: unknown): Promise<{ offset: number; limit: number }> {
  await handler()(null, request)
  const [offset, limit] = getDocumentPage.mock.calls[getDocumentPage.mock.calls.length - 1]
  return { offset, limit }
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

beforeEach(() => {
  vi.clearAllMocks()
})

describe('rag:get-chunks page bounds', () => {
  it('defaults to the first page when the renderer asks for nothing', async () => {
    expect(await askedFor(undefined)).toEqual({ offset: 0, limit: DEFAULT_LIMIT })
  })

  it('caps the page size at 500 however large the request', async () => {
    // The point of the cap: without it this handler serves the whole index
    // again, which is the regression the change exists to prevent.
    expect((await askedFor({ offset: 0, limit: 1_000_000 })).limit).toBe(MAX_LIMIT)
    expect((await askedFor({ offset: 0, limit: 501 })).limit).toBe(MAX_LIMIT)
    expect((await askedFor({ offset: 0, limit: Number.MAX_SAFE_INTEGER })).limit).toBe(MAX_LIMIT)
  })

  it('never serves a zero or negative page size', async () => {
    // A limit of 0 would make Next a no-op and strand the viewer forever.
    expect((await askedFor({ offset: 0, limit: 0 })).limit).toBe(1)
    expect((await askedFor({ offset: 0, limit: -50 })).limit).toBe(1)
  })

  it('normalizes a non-finite or non-numeric limit to the default', async () => {
    expect((await askedFor({ offset: 0, limit: Infinity })).limit).toBe(DEFAULT_LIMIT)
    expect((await askedFor({ offset: 0, limit: NaN })).limit).toBe(DEFAULT_LIMIT)
    expect((await askedFor({ offset: 0, limit: 'lots' })).limit).toBe(DEFAULT_LIMIT)
    expect((await askedFor({ offset: 0, limit: null })).limit).toBe(DEFAULT_LIMIT)
    expect((await askedFor({ offset: 0, limit: { valueOf: 'no' } })).limit).toBe(DEFAULT_LIMIT)
  })

  it('floors a fractional page size instead of passing it through', async () => {
    expect((await askedFor({ offset: 0, limit: 10.9 })).limit).toBe(10)
    expect((await askedFor({ offset: 2.7, limit: 10 })).offset).toBe(2)
  })

  it('clamps a negative or non-finite offset to zero', async () => {
    expect((await askedFor({ offset: -1, limit: 10 })).offset).toBe(0)
    expect((await askedFor({ offset: -Infinity, limit: 10 })).offset).toBe(0)
    expect((await askedFor({ offset: NaN, limit: 10 })).offset).toBe(0)
    expect((await askedFor({ offset: 'back', limit: 10 })).offset).toBe(0)
  })

  it('passes a numeric string through as the number it spells', async () => {
    expect(await askedFor({ offset: '300', limit: '25' })).toEqual({ offset: 300, limit: 25 })
  })

  it('survives a request that is not an object at all', async () => {
    expect(await askedFor(42)).toEqual({ offset: 0, limit: DEFAULT_LIMIT })
    expect(await askedFor(null)).toEqual({ offset: 0, limit: DEFAULT_LIMIT })
    expect(await askedFor('give me everything')).toEqual({ offset: 0, limit: DEFAULT_LIMIT })
  })

  it('echoes the page the store served, not the one requested', async () => {
    // The store clamps the offset into [0, total]; the renderer pages from what
    // it actually got, so the handler must not overwrite it with the request.
    getDocumentPage.mockReturnValueOnce({
      total: 1000,
      offset: 900,
      limit: 100,
      revision: 7,
      documents: []
    })
    const result = (await handler()(null, { offset: 99_999, limit: 100 })) as {
      total: number
      offset: number
      limit: number
      revision: number
      chunks: unknown[]
    }
    expect(result).toEqual({ total: 1000, offset: 900, limit: 100, revision: 7, chunks: [] })
  })

  it('projects a page into the viewer shape without leaking the embedding', async () => {
    getDocumentPage.mockReturnValueOnce({
      total: 1,
      offset: 0,
      limit: 100,
      revision: 3,
      documents: [
        {
          id: 'chunk-1',
          content: 'the text',
          embedding: new Float32Array(768),
          metadata: {
            meetingId: 'meet-1',
            recordingId: 'rec-1',
            chunkIndex: 4,
            subject: 'Weekly sync',
            timestamp: '2026-09-21T00:00:00Z'
          }
        }
      ]
    } as never)

    const result = (await handler()(null, {})) as { chunks: Record<string, unknown>[] }
    // The vector itself never crosses the boundary — only its width, which is
    // what the viewer displays.
    expect(result.chunks[0]).toEqual({
      id: 'chunk-1',
      content: 'the text',
      meetingId: 'meet-1',
      recordingId: 'rec-1',
      chunkIndex: 4,
      subject: 'Weekly sync',
      timestamp: '2026-09-21T00:00:00Z',
      embeddingDimensions: 768
    })
  })

  it('serves an unhydrated row as empty text rather than undefined', async () => {
    // A row deleted between the slice and the read comes back without content;
    // the viewer contract is a string.
    getDocumentPage.mockReturnValueOnce({
      total: 1,
      offset: 0,
      limit: 100,
      revision: 3,
      documents: [
        { id: 'chunk-1', embedding: new Float32Array(8), metadata: { chunkIndex: 0 } }
      ]
    } as never)

    const result = (await handler()(null, {})) as { chunks: { content: string }[] }
    expect(result.chunks[0].content).toBe('')
  })
})
