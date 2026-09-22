/**
 * Vector-store PAGED chunk reads (2026-09).
 *
 * The chunk viewer (rag:get-chunks) returned every chunk in the index in one
 * response — 237,920 rows with their full text on the current library. Once the
 * index stopped holding chunk text resident (see vector-store-arena.test.ts),
 * serving that also meant hydrating the whole index: ~200 MB of strings built
 * per invocation, then serialized over IPC to show a screenful.
 *
 * getDocumentPage() is the fix. These tests pin what can silently regress:
 *   - only the page asked for is hydrated; every other row stays text-free,
 *   - hydration does NOT write back into the index, so paging through the whole
 *     corpus cannot re-grow the resident text one page at a time,
 *   - `total` counts the ELIGIBLE corpus and the boundary is applied BEFORE the
 *     slice, so paging cannot walk past it into an excluded recording,
 *   - out-of-range offsets and limits clamp instead of throwing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import initSqlJs from 'sql.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'

const CACHE_DIR = join(tmpdir(), 'vs-page-test')

const deps = vi.hoisted(() => ({
  activeProvider: 'local-onnx-embed' as string | null,
  /** Recording ids the eligibility boundary lets through; null means "all". */
  eligibleRecordings: null as Set<string> | null,
}))

vi.mock('../embeddings', () => ({
  getEmbeddingsService: () => ({
    generateEmbedding: async () => new Array(64).fill(0),
    generateEmbeddings: async (texts: string[]) => texts.map(() => new Array(64).fill(0)),
    activeProviderId: async () => deps.activeProvider,
  }),
}))

vi.mock('../recording-eligibility', () => ({
  filterEligibleRecordingIds: (ids: Iterable<string>) => ({
    eligible: new Set(
      [...ids].filter((id) => deps.eligibleRecordings === null || deps.eligibleRecordings.has(id))
    ),
    failClosed: false,
  }),
  // The real boundary resolves provenance against the DB; here it is reduced to
  // the one dimension these tests exercise — which recordings are eligible.
  filterEligibleProvenanceRows: <T,>(rows: T[], recIdOf: (row: T) => string | null | undefined): T[] =>
    deps.eligibleRecordings === null
      ? rows
      : rows.filter((row) => {
          const id = recIdOf(row)
          return !!id && deps.eligibleRecordings!.has(id)
        }),
  isRecordingEligible: (id: string) =>
    deps.eligibleRecordings === null || deps.eligibleRecordings.has(id),
}))

let dbInstance: import('sql.js').Database | null = null
vi.mock('../database', () => ({
  getDatabase: () => dbInstance,
  getDatabasePath: () => join(CACHE_DIR, 'test.db'),
  isRecordingProcessable: () => true,
}))

import { VectorStore } from '../vector-store'

let SQL: initSqlJs.SqlJsStatic

const DIMS = 64

function makeVector(seed: number): Float32Array {
  const v = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(seed * 31.7 + i * 0.013)
  return v
}

function insertRow(id: string, chunkIndex: number, recordingId = 'rec-1'): void {
  const vector = makeVector(chunkIndex)
  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  dbInstance!.run(
    `INSERT INTO vector_embeddings
       (id, content, embedding, meeting_id, recording_id, chunk_index, timestamp,
        subject, source_type, capture_id, embed_provider, embed_dims)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      `content of ${id}`,
      blob,
      'meet-1',
      recordingId,
      chunkIndex,
      '2026-09-21T00:00:00Z',
      'Some subject',
      null,
      null,
      'local-onnx-embed',
      DIMS,
    ]
  )
}

async function loadFromDb(): Promise<VectorStore> {
  const store = new VectorStore()
  await store.initialize()
  return store
}

beforeEach(async () => {
  rmSync(CACHE_DIR, { recursive: true, force: true })
  mkdirSync(CACHE_DIR, { recursive: true })
  deps.activeProvider = 'local-onnx-embed'
  deps.eligibleRecordings = null
  SQL = await initSqlJs()
  dbInstance = new SQL.Database()
  // Let the store build its own schema, then seed rows into it.
  new VectorStore().ensureSchema()
})

afterEach(() => {
  dbInstance?.close()
  dbInstance = null
})

describe('VectorStore.getDocumentPage', () => {
  it('hydrates ONLY the page it returns', async () => {
    for (let i = 0; i < 30; i++) insertRow(`row-${i}`, i)
    const store = await loadFromDb()

    const page = store.getDocumentPage(10, 5)

    expect(page.total).toBe(30)
    expect(page.offset).toBe(10)
    expect(page.limit).toBe(5)
    expect(page.documents).toHaveLength(5)
    // Every returned row carries its text...
    for (const doc of page.documents) {
      expect(doc.content).toBe(`content of ${doc.id}`)
    }
    // ...and the other 25 were never read back. This is the whole point: the
    // old handler materialized all 237k chunks' strings to show a screenful.
    const pageIds = new Set(page.documents.map((d) => d.id))
    const untouched = store.getAllDocuments().filter((d) => !pageIds.has(d.id))
    expect(untouched).toHaveLength(25)
    expect(untouched.every((d) => d.content === undefined)).toBe(true)
  })

  it('does not write the page text back into the index', async () => {
    for (let i = 0; i < 10; i++) insertRow(`row-${i}`, i)
    const store = await loadFromDb()

    // Page through the ENTIRE corpus. hydrateContent() fills in place, so
    // handing it the index's own documents would leave every chunk's text
    // resident by the end — re-growing exactly what the index stopped holding.
    for (let offset = 0; offset < 10; offset += 3) {
      const page = store.getDocumentPage(offset, 3)
      expect(page.documents.every((d) => typeof d.content === 'string')).toBe(true)
    }

    expect(store.getAllDocuments().every((d) => d.content === undefined)).toBe(true)
  })

  it('counts and pages the ELIGIBLE corpus only', async () => {
    for (let i = 0; i < 6; i++) insertRow(`ok-${i}`, i, 'rec-ok')
    for (let i = 0; i < 6; i++) insertRow(`bad-${i}`, i, 'rec-excluded')
    const store = await loadFromDb()
    expect(store.getDocumentCount()).toBe(12)

    // The boundary runs over the whole corpus BEFORE the slice, so an excluded
    // recording cannot surface by asking for a later page.
    deps.eligibleRecordings = new Set(['rec-ok'])

    const seen: string[] = []
    for (let offset = 0; offset < 12; offset += 4) {
      const page = store.getDocumentPage(offset, 4)
      expect(page.total).toBe(6)
      seen.push(...page.documents.map((d) => d.id))
    }
    expect(seen.sort()).toEqual(['ok-0', 'ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5'])
  })

  it('covers the corpus exactly once across consecutive pages', async () => {
    for (let i = 0; i < 25; i++) insertRow(`row-${i}`, i)
    const store = await loadFromDb()

    const seen: string[] = []
    let offset = 0
    for (;;) {
      const page = store.getDocumentPage(offset, 7)
      if (page.documents.length === 0) break
      seen.push(...page.documents.map((d) => d.id))
      offset += page.documents.length
    }

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('clamps an offset past the end instead of throwing', async () => {
    for (let i = 0; i < 4; i++) insertRow(`row-${i}`, i)
    const store = await loadFromDb()

    const page = store.getDocumentPage(999, 10)
    expect(page.total).toBe(4)
    expect(page.offset).toBe(4)
    expect(page.documents).toEqual([])
  })

  it('clamps a negative offset and a negative limit', async () => {
    for (let i = 0; i < 4; i++) insertRow(`row-${i}`, i)
    const store = await loadFromDb()

    expect(store.getDocumentPage(-5, 2).offset).toBe(0)
    expect(store.getDocumentPage(-5, 2).documents).toHaveLength(2)
    expect(store.getDocumentPage(0, -1).documents).toEqual([])
  })

  it('reports a total of 0 and an empty page on an empty index', async () => {
    const store = await loadFromDb()
    const page = store.getDocumentPage(0, 100)
    expect(page).toEqual({ total: 0, offset: 0, limit: 100, documents: [] })
  })
})
