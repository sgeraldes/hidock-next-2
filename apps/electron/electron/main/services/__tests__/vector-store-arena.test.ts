/**
 * Vector-store CONTIGUOUS ARENA load path (2026-09).
 *
 * The 2026-09 OOM: loadFromDatabase decoded every row with blobToEmbedding,
 * whose `bytes.buffer.slice(...)` allocates a FRESH ArrayBuffer per row. At
 * 125k rows × 2048 dims that is 125k separate ~8 KB native allocations; the
 * main process committed 8.4 GB against ~1.3 GB of live state.
 *
 * A partition whose rows all share one dimension now gets ONE Float32Array
 * arena, and each document's embedding is a `subarray` view into it. These
 * tests pin the three things that can silently regress:
 *   - the arena is actually used, and every vector is a view over the SAME
 *     buffer (one allocation, not 125k),
 *   - the bytes survive the copy exactly, including rows whose source Buffer
 *     lands on a non-4-byte-aligned offset in Node's shared pool,
 *   - a row that disagrees with the partition dimension falls back WITHOUT
 *     leaving a hole in the arena or shifting every later row.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import initSqlJs from 'sql.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'

const CACHE_DIR = join(tmpdir(), 'vs-arena-test')

const deps = vi.hoisted(() => ({
  activeProvider: 'local-onnx-embed' as string | null,
  // Query vector must match the stored dimension — cosineSimilarity returns 0
  // on a length mismatch, which would make search() look broken for the wrong
  // reason. Unit basis vector e0, so an aligned row scores 1.
  queryVector: (() => {
    const v = new Array(64).fill(0)
    v[0] = 1
    return v
  })(),
}))

vi.mock('../embeddings', () => ({
  getEmbeddingsService: () => ({
    generateEmbedding: async () => deps.queryVector,
    generateEmbeddings: async (texts: string[]) => texts.map(() => deps.queryVector),
    activeProviderId: async () => deps.activeProvider,
  }),
}))

vi.mock('../recording-eligibility', () => ({
  filterEligibleRecordingIds: (ids: Iterable<string>) => ({
    eligible: new Set(ids),
    failClosed: false,
  }),
  filterEligibleProvenanceRows: (rows: unknown[]) => rows,
  isRecordingEligible: () => true,
}))

let dbInstance: import('sql.js').Database | null = null
vi.mock('../database', () => ({
  getDatabase: () => dbInstance,
  getDatabasePath: () => join(CACHE_DIR, 'test.db'),
  isRecordingProcessable: () => true,
}))

import { VectorStore } from '../vector-store'

let SQL: initSqlJs.SqlJsStatic

/** Deterministic vector so a byte-exact comparison is meaningful. */
function makeVector(seed: number, dims: number): Float32Array {
  const v = new Float32Array(dims)
  for (let i = 0; i < dims; i++) v[i] = Math.sin(seed * 31.7 + i * 0.013)
  return v
}

/**
 * Insert a row whose BLOB is carried by a Buffer taken from Node's pool. The
 * pool is why the loader cannot build a Float32Array over the source buffer:
 * `Buffer.from(...)` hands back a view whose byteOffset is usually NOT a
 * multiple of 4, which `new Float32Array(buf, offset, dims)` rejects.
 */
function insertRow(id: string, provider: string, vector: Float32Array, declaredDims: number): void {
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
      'rec-1',
      Number(id.split('-')[1]),
      '2026-09-21T00:00:00Z',
      'Some subject',
      null,
      null,
      provider,
      declaredDims,
    ]
  )
}

beforeEach(async () => {
  rmSync(CACHE_DIR, { recursive: true, force: true })
  mkdirSync(CACHE_DIR, { recursive: true })
  deps.activeProvider = 'local-onnx-embed'
  SQL = await initSqlJs()
  dbInstance = new SQL.Database()
  // Let the store build its own schema, then seed rows into it.
  new VectorStore().ensureSchema()
})

afterEach(() => {
  dbInstance?.close()
  dbInstance = null
})

/** Load a store straight from the DB (no cache file exists in CACHE_DIR). */
async function loadFromDb(): Promise<VectorStore> {
  const store = new VectorStore()
  await store.initialize()
  return store
}

describe('VectorStore contiguous arena', () => {
  const DIMS = 64

  it('backs a uniform partition with ONE buffer shared by every vector', async () => {
    const expected = new Map<string, Float32Array>()
    for (let i = 0; i < 25; i++) {
      const v = makeVector(i, DIMS)
      expected.set(`row-${i}`, v)
      insertRow(`row-${i}`, 'local-onnx-embed', v, DIMS)
    }

    const store = await loadFromDb()
    expect(store.isArenaBacked()).toBe(true)
    expect(store.getDocumentCount()).toBe(25)

    const docs = store.getAllDocuments()
    // One allocation: every embedding is a view over the same ArrayBuffer.
    const buffers = new Set(docs.map((d) => (d.embedding as Float32Array).buffer))
    expect(buffers.size).toBe(1)

    // And the bytes survived the copy exactly.
    for (const doc of docs) {
      const want = expected.get(doc.id)!
      const got = doc.embedding as Float32Array
      expect(got.length).toBe(DIMS)
      expect(Array.from(got)).toEqual(Array.from(want))
    }
  })

  it('falls back to per-row decode when the partition has mixed dimensions', async () => {
    insertRow('row-0', 'local-onnx-embed', makeVector(0, DIMS), DIMS)
    insertRow('row-1', 'local-onnx-embed', makeVector(1, DIMS * 2), DIMS * 2)

    const store = await loadFromDb()
    expect(store.isArenaBacked()).toBe(false)
    expect(store.getDocumentCount()).toBe(2)

    const byId = new Map(store.getAllDocuments().map((d) => [d.id, d]))
    expect(byId.get('row-0')!.embedding.length).toBe(DIMS)
    expect(byId.get('row-1')!.embedding.length).toBe(DIMS * 2)
  })

  it('a row whose bytes disagree with the partition dims does not shift the others', async () => {
    // Rows 0 and 2 are well-formed; row 1 declares DIMS but stores fewer bytes,
    // the shape a truncated write leaves behind. It must fall back on its own
    // without consuming an arena slot, or every later row reads shifted floats.
    insertRow('row-0', 'local-onnx-embed', makeVector(0, DIMS), DIMS)
    insertRow('row-1', 'local-onnx-embed', makeVector(1, DIMS - 8), DIMS)
    insertRow('row-2', 'local-onnx-embed', makeVector(2, DIMS), DIMS)

    const store = await loadFromDb()
    expect(store.getDocumentCount()).toBe(3)

    const byId = new Map(store.getAllDocuments().map((d) => [d.id, d]))
    expect(Array.from(byId.get('row-0')!.embedding)).toEqual(Array.from(makeVector(0, DIMS)))
    expect(Array.from(byId.get('row-2')!.embedding)).toEqual(Array.from(makeVector(2, DIMS)))
    // The malformed row still loads, just not from the arena.
    expect(byId.get('row-1')!.embedding.length).toBe(DIMS - 8)
  })

  it('search() returns hits over arena-backed vectors', async () => {
    // Row 0 points exactly at the query direction the embeddings mock returns
    // ([1,0,0,0,...]), so it must outrank a vector pointing elsewhere.
    const aligned = new Float32Array(DIMS)
    aligned[0] = 1
    const orthogonal = new Float32Array(DIMS)
    orthogonal[1] = 1
    insertRow('row-0', 'local-onnx-embed', aligned, DIMS)
    insertRow('row-1', 'local-onnx-embed', orthogonal, DIMS)

    const store = await loadFromDb()
    expect(store.isArenaBacked()).toBe(true)

    const hits = await store.search('anything', 2)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].document.id).toBe('row-0')
    expect(hits[0].score).toBeGreaterThan(0.9)
  })

  it('does NOT keep chunk text resident after the load', async () => {
    for (let i = 0; i < 5; i++) {
      insertRow(`row-${i}`, 'local-onnx-embed', makeVector(i, DIMS), DIMS)
    }
    const store = await loadFromDb()
    // The whole point of the change: 237k chunks' worth of strings stay in
    // SQLite. A doc handed out by the index carries no text until hydrated.
    for (const doc of store.getAllDocuments()) {
      expect(doc.content).toBeUndefined()
    }
  })

  it('hydrateContent() fills text in place and leaves deleted rows undefined', async () => {
    insertRow('row-0', 'local-onnx-embed', makeVector(0, DIMS), DIMS)
    insertRow('row-1', 'local-onnx-embed', makeVector(1, DIMS), DIMS)
    const store = await loadFromDb()

    // A row deleted from the table AFTER the index loaded: hydration must not
    // throw and must not invent text for it.
    dbInstance!.run("DELETE FROM vector_embeddings WHERE id = 'row-1'")

    const docs = store.getAllDocuments()
    const returned = store.hydrateContent(docs)
    expect(returned).toBe(docs) // mutates in place, returns the same array

    const byId = new Map(docs.map((d) => [d.id, d]))
    expect(byId.get('row-0')!.content).toBe('content of row-0')
    expect(byId.get('row-1')!.content).toBeUndefined()
  })

  it('search() hands back hydrated documents', async () => {
    const aligned = new Float32Array(DIMS)
    aligned[0] = 1
    insertRow('row-0', 'local-onnx-embed', aligned, DIMS)
    const store = await loadFromDb()

    // Before the search the index holds no text...
    expect(store.getAllDocuments()[0].content).toBeUndefined()
    // ...and the caller still gets it, because search() hydrates its top-K.
    const hits = await store.search('anything', 5)
    expect(hits[0].document.content).toBe('content of row-0')
  })

  it('hydrates past the SQLite bind-parameter limit', async () => {
    // One meeting's chunks can exceed SQLite's 999-parameter default, so the
    // IN(...) is chunked. A single oversized query would throw instead.
    const n = 1200
    for (let i = 0; i < n; i++) {
      insertRow(`row-${i}`, 'local-onnx-embed', makeVector(i, DIMS), DIMS)
    }
    const store = await loadFromDb()
    const docs = store.hydrateContent(store.getAllDocuments())
    expect(docs.length).toBe(n)
    expect(docs.every((d) => typeof d.content === 'string')).toBe(true)
    expect(docs.find((d) => d.id === 'row-1199')!.content).toBe('content of row-1199')
  })

  it('ignores rows from other partitions when sizing the arena', async () => {
    insertRow('row-0', 'local-onnx-embed', makeVector(0, DIMS), DIMS)
    insertRow('row-1', 'local-onnx-embed', makeVector(1, DIMS), DIMS)
    // A larger foreign partition must not widen the arena or get loaded.
    insertRow('other-0', 'gemini-api', makeVector(9, DIMS * 3), DIMS * 3)

    const store = await loadFromDb()
    expect(store.isArenaBacked()).toBe(true)
    expect(store.getDocumentCount()).toBe(2)
    const buffers = new Set(store.getAllDocuments().map((d) => (d.embedding as Float32Array).buffer))
    expect(buffers.size).toBe(1)
    // Exactly the two rows' worth of floats, nothing reserved for the other one.
    expect([...buffers][0].byteLength).toBe(2 * DIMS * 4)
  })
})
