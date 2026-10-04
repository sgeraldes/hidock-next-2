/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import initSqlJs from 'sql.js'
const deps = vi.hoisted(() => ({
  yield: vi.fn(async () => {}),
  progress: [] as number[],
  cache: null as null | {
    rows: Array<{
      id: string
      provider: string
      dims: number
      vector: Float32Array
    }>
    buffers: Buffer[]
  }
}))
vi.mock('../event-loop', () => ({ yieldToEventLoop: deps.yield }))
vi.mock('../database', () => ({
  getDatabase: () => db,
  getDatabasePath: () => 'unused/test.db',
  isRecordingProcessable: () => true
}))
vi.mock('../embeddings', () => ({
  getEmbeddingsService: () => ({
    activeProviderId: async () => 'ollama',
    generateEmbedding: async () => [1, 0]
  })
}))
vi.mock('../recording-eligibility', () => ({
  filterEligibleRecordingIds: (ids: string[]) => ({
    eligible: new Set(ids),
    failClosed: false
  }),
  filterEligibleProvenanceRows: (rows: unknown[]) => rows,
  isRecordingEligible: () => true
}))
vi.mock('../vector-cache', () => ({
  VECTOR_CACHE_FILENAME: 'unused.bin',
  readVectorCacheAsync: async () => deps.cache,
  waitForVectorCacheWrites: async () => {},
  writeVectorCacheAsync: async () => ({ totalCount: 0 }),
  cancelVectorCacheWrites: () => {}
}))
import { VectorStore } from '../vector-store'
let db: initSqlJs.Database
beforeEach(async () => {
  const SQL = await initSqlJs()
  db = new SQL.Database()
  new VectorStore().ensureSchema()
  deps.yield.mockClear()
  deps.progress = []
  deps.cache = null
})
afterEach(() => db.close())
function seed(n: number, legacy = false): void {
  for (let i = 0; i < n; i++)
    db.run(
      'INSERT INTO vector_embeddings (id, content, embedding, embed_provider, embed_dims, chunk_index) VALUES (?,?,?,?,?,?)',
      [
        String(i).padStart(5, '0'),
        'chunk',
        new Uint8Array(
          new Float32Array(legacy ? 768 : 2).fill(i === 0 ? 1 : 0).buffer
        ),
        legacy ? null : 'ollama',
        legacy ? null : 2,
        i
      ]
    )
}
describe('semantic restore bounded scans', () => {
  it('batches cache lookup construction and metadata, preserving SQL-loaded vectors and search', async () => {
    seed(2050)
    const sqlStore = new VectorStore()
    await sqlStore.initialize()
    const expected = sqlStore.getAllDocuments()
    const expectedHits = await sqlStore.search('query', 2)
    deps.cache = {
      rows: expected.map((d) => ({
        id: d.id,
        provider: 'ollama',
        dims: 2,
        vector: new Float32Array(d.embedding)
      })),
      buffers: []
    }
    deps.yield.mockClear()
    const cachedStore = new VectorStore()
    await cachedStore.initialize()
    expect(deps.yield).toHaveBeenCalledTimes(9)
    expect(cachedStore.isCacheBacked()).toBe(true)
    expect(cachedStore.getAllDocuments()).toEqual(expected)
    expect(await cachedStore.search('query', 2)).toEqual(expectedHits)
  })
  it('bounds lightweight scans to 1024 rows and embedding reads to 128, yielding after every page', async () => {
    seed(2050)
    const exec = vi.spyOn(db, 'exec')
    const store = new VectorStore()
    await store.initialize((loaded) => deps.progress.push(loaded))
    expect(deps.yield).toHaveBeenCalledTimes(23)
    expect(deps.progress).toEqual([
      ...Array.from({ length: 16 }, (_, i) => (i + 1) * 128),
      2050
    ])
    const scans = exec.mock.calls.filter(
      ([sql]) => /SELECT/i.test(sql) && /vector_embeddings/i.test(sql)
    )
    expect(
      scans.some(
        ([sql]) =>
          /embed_dims IS NULL OR embed_provider IS NULL/.test(sql) &&
          !/LIMIT/.test(sql)
      )
    ).toBe(false)
    expect(
      scans.some(([sql]) => /MIN\(embed_dims\)/.test(sql) && !/LIMIT/.test(sql))
    ).toBe(false)
    for (const [sql, params] of scans.filter(([sql]) =>
      /ORDER BY (id|rowid)/.test(sql)
    )) {
      const limit = /SELECT id, embedding,/.test(sql) ? 128 : 1024
      expect((params as unknown[]).at(-1)).toBe(limit)
    }
    expect(store.getAllDocuments().map((d) => d.id)).toEqual(
      Array.from({ length: 2050 }, (_, i) => String(i).padStart(5, '0'))
    )
    expect(
      store
        .getAllDocuments()
        .every((d) => d.embedding.length === 2 && d.content === undefined)
    ).toBe(true)
    const hits = await store.search('query', 1)
    expect(hits[0].document.id).toBe('00000')
    expect(hits[0].score).toBeCloseTo(Math.SQRT1_2)
    expect(hits[0].document.content).toBe('chunk')
  })
  it('labels legacy BLOB rows in bounded pages with the same inferred provider and dimensions', async () => {
    seed(257, true)
    const store = new VectorStore()
    await store.initialize()
    expect(deps.yield).toHaveBeenCalledTimes(7)
    expect(
      db.exec(
        'SELECT DISTINCT embed_provider, embed_dims FROM vector_embeddings'
      )[0].values
    ).toEqual([['ollama', 768]])
    expect(store.getDocumentCount()).toBe(257)
    expect(store.isArenaBacked()).toBe(true)
  })
})
it('preserves the synchronous label repair for mixed BLOB, JSON, malformed and unknown rows', async () => {
  const vectors: Array<[string, unknown, string | null, number | null]> = [
    ['blob', new Uint8Array(new Float32Array(768).buffer), null, null],
    ['json', JSON.stringify(new Array(3072).fill(0)), null, null],
    ['malformed', '{', null, null],
    ['empty-json', '[]', null, null],
    ['unknown', new Uint8Array(new Float32Array(5).buffer), null, null],
    [
      'provider-kept',
      new Uint8Array(new Float32Array(768).buffer),
      'custom',
      null
    ],
    ['dims-kept', '[1,2]', null, 2048]
  ]
  for (const [id, raw, provider, dims] of vectors)
    db.run(
      'INSERT INTO vector_embeddings(id,content,embedding,embed_provider,embed_dims) VALUES(?,?,?,?,?)',
      [id, 'text', raw as Uint8Array, provider, dims]
    )
  const SQL = await initSqlJs()
  const original = db
  const reference = new SQL.Database(original.export())
  db = reference
  new VectorStore().ensureSchema()
  const expected = reference.exec(
    'SELECT id, embed_provider, embed_dims FROM vector_embeddings ORDER BY id'
  )
  db = original
  await new VectorStore().initialize()
  expect(
    original.exec(
      'SELECT id, embed_provider, embed_dims FROM vector_embeddings ORDER BY id'
    )
  ).toEqual(expected)
  reference.close()
})
