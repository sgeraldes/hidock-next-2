/**
 * Vector Store Service
 * Simple in-memory vector store with SQLite persistence for meeting transcript embeddings
 */

import { getDatabase, getDatabasePath, isRecordingProcessable } from './database'
import { dirname, join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import {
  markVectorStartupFailed,
  markVectorStartupLoading,
  markVectorStartupReady,
  updateVectorStartupProgress,
} from './vector-startup-state'
import {
  cancelVectorCacheWrites,
  readVectorCacheAsync,
  waitForVectorCacheWrites,
  writeVectorCacheAsync,
  VECTOR_CACHE_FILENAME,
} from './vector-cache'
import {
  filterEligibleRecordingIds,
  filterEligibleProvenanceRows,
  isRecordingEligible
} from './recording-eligibility'
import { getEmbeddingsService } from './embeddings'

interface VectorDocument {
  id: string
  /**
   * Chunk text. ABSENT on documents straight out of the index.
   *
   * The boot load holds 237,920 chunks; their text is ~98 MB on disk and ~206 MB
   * as JS strings, resident for the whole session to serve the handful of chunks
   * a search actually returns. It is no longer loaded: `search()`,
   * `searchByMeeting()` and `getChunkNeighbors()` hydrate the documents they are
   * about to hand out, and anything else asks {@link VectorStore.hydrateContent}.
   *
   * Optional ON PURPOSE. Making it `string` and filling in '' would let a
   * consumer that forgot to hydrate read empty text and silently return an
   * answer with no evidence in it. As `string | undefined`, the compiler stops
   * at every read and forces the decision.
   */
  content?: string
  /** Float32Array for DB-loaded docs (zero-copy view, no 338M-value boxing);
   *  number[] for freshly embedded docs. Both are indexable array-likes. */
  embedding: number[] | Float32Array
  metadata: {
    meetingId?: string
    recordingId?: string
    chunkIndex: number
    timestamp?: string
    subject?: string
    /**
     * Non-transcript origin of the chunk (e.g. 'image' for a screenshot capture).
     * Absent/undefined for the legacy meeting-transcript chunks. Lets RAG label
     * an image-capture excerpt as "[Screenshot: …]" instead of "[Meeting: …]".
     */
    sourceType?: string
    /** knowledge_capture id backing this chunk, so a citation can link the source. */
    captureId?: string
    /**
     * PROVIDER PARTITION — the brain that embedded this chunk ('gemini-api',
     * 'local-onnx-embed', 'ollama'). Cosine scores are only comparable WITHIN
     * a partition: search() filters to the ACTIVE provider's partition so a
     * provider switch can never silently zero retrieval (2026-07 incident:
     * a dim/provider mismatch made every score 0 with zero user signal).
     * Undefined ⇒ legacy/unknown provenance ⇒ never served (fail-closed).
     */
    embedProvider?: string
    /** Embedding dimension, stamped at insert (integrity cross-check). */
    embedDims?: number
  }
}

/**
 * Persist an embedding as a compact binary Float32 BLOB (4 bytes/dimension)
 * rather than a JSON text array (~13 bytes/dimension). For the 3072-dim vectors
 * this app stores that is a ~3x size reduction and was the fix for the P0 where
 * vector_embeddings alone reached 1.7 GB and crashed the database (schema v36).
 */
function embeddingToBlob(embedding: number[] | Float32Array): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer)
}

/**
 * Decode a stored embedding back to a float vector. Accepts the binary Float32
 * BLOB (Buffer/Uint8Array, current format) and legacy JSON text (rows written
 * before the v36 migration, or not yet compacted). Returns [] on anything
 * unparseable so a single bad row can never break RAG load.
 *
 * PERF (boot load): the BLOB path returns a Float32Array VIEW over the source
 * buffer — NOT a boxed JS number[]. At 110k × 3072-dim, Array.from() allocated
 * ~338M boxed numbers (multi-second GC churn — the dominant boot freeze).
 */
function blobToEmbedding(value: unknown): number[] | Float32Array {
  if (value == null) return []
  if (typeof value === 'string') {
    try {
      const arr = JSON.parse(value)
      return Array.isArray(arr) ? (arr as number[]) : []
    } catch {
      return []
    }
  }
  const bytes =
    value instanceof Uint8Array ? value : Buffer.isBuffer(value) ? (value as Buffer) : null
  if (!bytes) return []
  // Copy into a standalone Float32Array (the sql.js row buffer is transient).
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.floor(bytes.byteLength / 4) * 4))
}

interface SearchResult {
  document: VectorDocument
  score: number
}

// Cosine similarity between two vectors (any indexable array-like)
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

// Split text into chunks for embedding
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = []
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)

  let currentChunk = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (currentChunk.length + trimmed.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      // Keep overlap from end of previous chunk
      const words = currentChunk.split(' ')
      const overlapWords = words.slice(-Math.ceil(overlap / 10))
      currentChunk = overlapWords.join(' ') + ' ' + trimmed
    } else {
      currentChunk += (currentChunk.length > 0 ? '. ' : '') + trimmed
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

/** Diversity reranking knobs (F5 PixelRAG — see {@link diversifyResults}). */
const DIVERSITY_CANDIDATE_MIN = 20
const DIVERSITY_CANDIDATE_FACTOR = 4
const MAX_CHUNKS_PER_CAPTURE = 2

/**
 * Light, deterministic diversity reranking over a score-sorted result list
 * (no LLM, O(candidates)). Raw cosine top-K over the shared corpus lets a few
 * near-duplicate screenshot descriptions consume the whole context window, so:
 *
 *  - a larger candidate set is considered (topK*4, min 20);
 *  - image-capture chunks are capped at {@link MAX_CHUNKS_PER_CAPTURE} per
 *    capture (near-identical chunks of one screenshot never stack);
 *  - when BOTH modalities are among the candidates, ceil(topK/2) slots are
 *    reserved for transcript chunks (images take at most topK - ceil(topK/2));
 *  - if the caps leave slots unfilled (e.g. transcripts are scarce), the
 *    best-scoring skipped chunks fill them, so topK results still come back.
 *
 * Pure-transcript queries are unchanged: with no image chunks in the candidate
 * set every cap is a no-op and the raw top-K order is returned.
 */
function diversifyResults(sorted: SearchResult[], topK: number): SearchResult[] {
  const candidates = sorted.slice(0, Math.max(topK * DIVERSITY_CANDIDATE_FACTOR, DIVERSITY_CANDIDATE_MIN))
  const hasTranscript = candidates.some((r) => r.document.metadata.sourceType !== 'image')
  const hasImage = candidates.some((r) => r.document.metadata.sourceType === 'image')
  if (!hasImage) return candidates.slice(0, topK)

  const maxImageSlots = hasTranscript ? Math.max(1, topK - Math.ceil(topK / 2)) : topK

  const selected: SearchResult[] = []
  const skipped: SearchResult[] = []
  const perCapture = new Map<string, number>()
  let imageCount = 0

  for (const result of candidates) {
    if (selected.length >= topK) break
    const meta = result.document.metadata
    if (meta.sourceType === 'image') {
      const captureKey = meta.captureId ?? meta.recordingId ?? result.document.id
      const captureCount = perCapture.get(captureKey) ?? 0
      if (imageCount >= maxImageSlots || captureCount >= MAX_CHUNKS_PER_CAPTURE) {
        skipped.push(result)
        continue
      }
      perCapture.set(captureKey, captureCount + 1)
      imageCount++
    }
    selected.push(result)
  }

  // Fill any slots the caps left open with the best skipped candidates so the
  // caller still receives topK results when the corpus allows.
  for (const result of skipped) {
    if (selected.length >= topK) break
    selected.push(result)
  }

  selected.sort((a, b) => b.score - a.score)
  return selected
}

class VectorStore {
  private documents: Map<string, VectorDocument> = new Map()
  private initialized = false
  private schemaReady = false
  private initialization: Promise<void> | null = null

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initialized) return
    if (!this.initialization) {
      markVectorStartupLoading()
      const reportProgress = (loaded: number, total: number): void => {
        updateVectorStartupProgress(loaded, total)
        onProgress?.(loaded, total)
      }
      this.initialization = this.initializeInternal(reportProgress)
        .then(() => markVectorStartupReady(this.documents.size))
        .catch((error) => {
          markVectorStartupFailed(error)
          throw error
        })
        .finally(() => {
          this.initialization = null
        })
    }
    await this.initialization
  }

  private async initializeInternal(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initialized) return

    this.ensureSchema()

    const activeProvider = await getEmbeddingsService().activeProviderId()
    if (!activeProvider) {
      this.initialized = true
      console.warn('[VectorStore] No active embedding provider — semantic index remains empty')
      return
    }

    const t0 = Date.now()
    if (await this.tryLoadFromCache(activeProvider, onProgress)) {
      this.initialized = true
      console.log(
        `Vector store initialized with ${this.documents.size} documents (binary cache, ${Date.now() - t0}ms)`
      )
      return
    }

    await this.loadFromDatabase(activeProvider, onProgress)

    this.initialized = true
    console.log(`Vector store initialized with ${this.documents.size} documents`)
    this.scheduleCacheWrite()
  }

  /**
   * Prepare the vector table without hydrating every embedding into RAM.
   * Boot-time backfills need schema/query access, not a multi-gigabyte in-memory
   * search index. Keeping this seam separate prevents 200k+ vectors from being
   * restored merely to discover there is no missing transcript to index.
   */
  ensureSchema(): void {
    if (this.schemaReady) return

    const db = getDatabase()

    // Create vector_embeddings table (separate from database.ts embeddings table)
    db.run(`
      CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        meeting_id TEXT,
        recording_id TEXT,
        chunk_index INTEGER,
        timestamp TEXT,
        subject TEXT,
        source_type TEXT,
        capture_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Add F5 (PixelRAG) columns to a pre-existing table. This table is owned here
    // (CREATE TABLE IF NOT EXISTS, NOT the database.ts migration runner), so the
    // ALTERs are guarded by a PRAGMA check and stay idempotent on every boot.
    // FAIL-CLOSED: throws when any column is still missing afterwards, so
    // `initialized` is never set on a half-upgraded table (every later INSERT
    // references these columns — a swallowed ALTER failure would silently break
    // ALL indexing for the whole process). A throw here leaves `initialized`
    // false, so the next initialize() call retries the repair.
    this.ensureColumns(db, ['source_type', 'capture_id', 'embed_provider', { name: 'embed_dims', type: 'INTEGER' }])

    // Backfill partition labels for pre-partition rows (see method docs).
    this.backfillProviderLabels(db)

    // Create index for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_meeting ON vector_embeddings(meeting_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_recording ON vector_embeddings(recording_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_vector_embeddings_provider_id ON vector_embeddings(embed_provider, id)`)
    this.schemaReady = true
  }

  /** Chunk buffers backing the cache-loaded Float32Array views (kept alive). */
  private cacheBuffers: Buffer[] | null = null

  /**
   * Single contiguous arena backing the DB-loaded Float32Array views, when the
   * partition has a uniform dimension. Every document's `embedding` is a
   * `subarray` into this, so the reference keeps it alive; dropping documents
   * does NOT reclaim its bytes until the whole store is reloaded. That is the
   * intended trade: one ~1 GB allocation instead of 125k fragmenting ones.
   */
  private partitionArena: Float32Array | null = null

  /** True when this boot's embeddings are views over one contiguous arena
   *  rather than per-row allocations (diagnostics/tests). */
  isArenaBacked(): boolean {
    return this.partitionArena !== null
  }

  /**
   * Fill in `content` for the given documents, reading it from SQLite.
   *
   * The index holds no chunk text (see {@link VectorDocument.content}); this is
   * how a caller about to USE documents gets it. Intended for bounded sets —
   * a search's top-K, one meeting's chunks, a chunk's neighbours. Handing it
   * the whole index re-materializes the ~206 MB this change removed, which is
   * a legitimate thing to do deliberately and a bug to do by accident.
   *
   * Returns NEW document objects; the indexed documents are never touched.
   * The first version mutated them in place, which quietly undid the whole
   * change: every hydrated chunk stayed resident in the index for the rest of
   * the session, and one `rag:get-chunks` call put all ~100 MB of text back
   * for good. Callers must use the returned array. A row that no longer
   * exists (deleted between the search and this read) leaves `content`
   * undefined rather than throwing — callers already handle an absent value.
   */
  hydrateContent<T extends { id: string; content?: string }>(docs: T[]): T[] {
    const missing = docs.filter((d) => d.content === undefined)
    if (missing.length === 0) return docs

    const db = getDatabase()
    // Chunked IN(...) — SQLite's default parameter limit is 999, and a caller
    // may legitimately pass more than that (one long meeting's chunks).
    const CHUNK = 500
    const text = new Map<string, string>()
    for (let i = 0; i < missing.length; i += CHUNK) {
      const slice = missing.slice(i, i + CHUNK)
      const placeholders = slice.map(() => '?').join(',')
      const rows = db.exec(
        `SELECT id, content FROM vector_embeddings WHERE id IN (${placeholders})`,
        slice.map((d) => d.id)
      )
      if (rows.length === 0) continue
      for (const row of rows[0].values) {
        text.set(row[0] as string, (row[1] as string | null) ?? '')
      }
    }

    return docs.map((doc) => {
      if (doc.content !== undefined) return doc
      const found = text.get(doc.id)
      // Shallow copy: `embedding` stays a view into the shared arena and
      // `metadata` is shared; only the text lives on the copy.
      return found === undefined ? doc : { ...doc, content: found }
    })
  }

  /** True when this boot's embeddings are zero-copy views over the binary
   *  cache buffer (diagnostics/tests). */
  isCacheBacked(): boolean {
    return this.cacheBuffers !== null
  }

  /**
   * Delete the binary vector cache file. Called on HARD PURGE: the cache
   * holds deleted recordings' embedding vectors on disk, and "permanent
   * deletion" must not leave recoverable vectors behind until the next
   * boot's fingerprint invalidation. The next boot SQL-loads (sans purged
   * rows) and rewrites the cache clean. In-memory docs are unaffected.
   */
  invalidateCache(): void {
    try {
      const path = this.vectorCachePath()
      cancelVectorCacheWrites(path)
      if (existsSync(path)) {
        unlinkSync(path)
        console.log('[VectorStore] Binary vector cache invalidated (hard purge)')
      }
    } catch (e) {
      console.warn('[VectorStore] cache invalidation failed (non-fatal):', e)
    }
  }

  private vectorCachePath(): string {
    return join(dirname(getDatabasePath()), VECTOR_CACHE_FILENAME)
  }

  /**
   * Boot accelerator: load metadata from SQL (no blobs) + embeddings as
   * zero-copy views over the binary cache. Valid ONLY when the live table's
   * provider count matches the cache AND every row id/provider/dimension
   * matches during paged metadata validation — mismatches fall
   * back to the SQL load (false). Unknown-provider rows are unservable by
   * design and excluded from BOTH the cache and its fingerprint.
   */
  private async tryLoadFromCache(
    activeProvider: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<boolean> {
    const db = getDatabase()
    // Count through the provider index, without reading the multi-GB vector
    // table for a dimensions GROUP BY. Verify dimensions per row below.
    const countRows = db.exec(
      'SELECT COUNT(*) FROM vector_embeddings WHERE embed_provider = ?',
      [activeProvider]
    )
    const liveCount = Number(countRows[0]?.values[0]?.[0] ?? 0)
    if (liveCount === 0) return false

    const cachePath = this.vectorCachePath()
    await waitForVectorCacheWrites(cachePath)
    const cache = await readVectorCacheAsync(cachePath, activeProvider)
    if (!cache) return false
    if (cache.rows.length !== liveCount) return false

    const byId = new Map(cache.rows.map((r) => [r.id, r]))
    const BATCH = 128
    let loaded = 0
    let afterId = ''
    let matched = 0
    for (;;) {
      const rows = db.exec(
        // `content` is NOT selected — see the VectorDocument.content docs. The
        // cache path skipped it too and still paid for it here.
        `SELECT id, meeting_id, recording_id, chunk_index, timestamp, subject, source_type, capture_id, embed_provider, embed_dims
         FROM vector_embeddings
         WHERE embed_provider = ? AND embed_dims IS NOT NULL AND id > ?
         ORDER BY id
         LIMIT ?`,
        [activeProvider, afterId, BATCH]
      )
      if (rows.length === 0 || rows[0].values.length === 0) break
      for (const row of rows[0].values) {
        const id = row[0] as string
        const cached = byId.get(id)
        if (!cached || cached.provider !== row[8] || cached.dims !== row[9]) {
          // Table changed between the fingerprint and the row scan — do not
          // serve a half-fresh store; fall back to the authoritative SQL load.
          this.documents.clear()
          return false
        }
        this.documents.set(id, {
          id,
          embedding: cached.vector,
          metadata: {
            meetingId: (row[1] as string | undefined) || undefined,
            recordingId: (row[2] as string | undefined) || undefined,
            chunkIndex: row[3] as number,
            timestamp: (row[4] as string | undefined) || undefined,
            subject: (row[5] as string | undefined) || undefined,
            sourceType: (row[6] as string | undefined) || undefined,
            captureId: (row[7] as string | undefined) || undefined,
            embedProvider: cached.provider,
            embedDims: cached.dims,
          },
        })
        matched++
      }
      loaded += rows[0].values.length
      afterId = rows[0].values[rows[0].values.length - 1][0] as string
      onProgress?.(Math.min(loaded, cache.rows.length), cache.rows.length)
      if (rows[0].values.length < BATCH) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (matched !== cache.rows.length) {
      this.documents.clear()
      return false
    }
    this.cacheBuffers = cache.buffers
    return true
  }

  /**
   * Persist the binary cache for the next boot without monopolizing Electron's
   * main event loop. Unknown-provider rows are excluded (unservable by design).
   */
  private scheduleCacheWrite(): void {
    void (async () => {
      await new Promise((resolve) => setImmediate(resolve))
      try {
        const documents = this.documents
        function* cacheDocuments() {
          for (const document of documents.values()) {
            if (!document.metadata.embedProvider || !document.metadata.embedDims) continue
            yield {
              id: document.id,
              embedding: document.embedding,
              provider: document.metadata.embedProvider,
              dims: document.metadata.embedDims,
            }
          }
        }
        const { totalCount } = await writeVectorCacheAsync(this.vectorCachePath(), cacheDocuments())
        console.log(`[VectorStore] Binary vector cache written (${totalCount} rows)`)
      } catch (e) {
        console.warn('[VectorStore] Binary vector cache write failed (next boot uses the SQL load):', e)
      }
    })()
  }

  /**
   * Stamp embed_provider / embed_dims on rows written before the provider
   * partition existed. Dimension implies provider for every model this app
   * has ever used: 3072 ⇒ gemini-api (gemini-embedding-001), 2048 ⇒
   * local-onnx-embed (Nemotron-3), 768 ⇒ ollama (nomic-embed-text). Rows
   * whose dims match NO known model stay NULL — unknown provenance is never
   * served (fail-closed, same as pre-partition behaviour where they scored 0
   * against every query). Legacy JSON-text rows are dimensioned in JS.
   * Idempotent: only NULL rows are touched.
   */
  private backfillProviderLabels(db: ReturnType<typeof getDatabase>): void {
    // Cheap NULL probe first: after the first post-partition boot these UPDATEs
    // are no-ops, but an unconditional UPDATE still full-scans every blob
    // (~1.3 GB at 110k rows) on EVERY boot.
    const pendingRes = db.exec(
      'SELECT COUNT(*) FROM vector_embeddings WHERE embed_dims IS NULL OR embed_provider IS NULL'
    )
    const pending = pendingRes.length > 0 ? (pendingRes[0].values[0][0] as number) : 0
    if (pending === 0) return
    console.log(`[VectorStore] Backfilling provider labels on ${pending} pre-partition rows…`)
    db.run(
      "UPDATE vector_embeddings SET embed_dims = LENGTH(embedding) / 4 WHERE embed_dims IS NULL AND typeof(embedding) = 'blob'"
    )
    // Legacy JSON-text rows (pre-v36 format) — parse in JS to get the length.
    const textRows = db.exec(
      "SELECT id, embedding FROM vector_embeddings WHERE embed_dims IS NULL AND typeof(embedding) = 'text'"
    )
    if (textRows.length > 0) {
      for (const [id, raw] of textRows[0].values) {
        const dims = blobToEmbedding(raw).length
        if (dims > 0) {
          db.run('UPDATE vector_embeddings SET embed_dims = ? WHERE id = ?', [dims, id as string])
        }
      }
    }
    const PROVIDER_BY_DIMS: Record<number, string> = {
      3072: 'gemini-api',
      2048: 'local-onnx-embed',
      768: 'ollama',
    }
    for (const [dims, provider] of Object.entries(PROVIDER_BY_DIMS)) {
      db.run('UPDATE vector_embeddings SET embed_provider = ? WHERE embed_provider IS NULL AND embed_dims = ?', [
        provider,
        Number(dims),
      ])
    }
  }

  /**
   * Idempotently add nullable TEXT columns to vector_embeddings, FAIL-CLOSED.
   *
   * Each ALTER is guarded by a PRAGMA check (a re-run or a DB created with the
   * column already present is a no-op — matches the database-migrations rule for
   * guarded ALTERs). After the repairs the column list is RE-READ and, if any
   * required column is still absent, this THROWS so initialize() fails before
   * setting `initialized` and can retry later. Per-column idempotence also makes
   * a partial upgrade (one of two ALTERs failed) recoverable: the next attempt
   * only adds the column that is still missing.
   */
  private ensureColumns(db: ReturnType<typeof getDatabase>, columns: Array<string | { name: string; type: string }>): void {
    const readColumns = (): string[] => {
      const info = db.exec('PRAGMA table_info(vector_embeddings)')
      return info.length > 0 ? info[0].values.map((row) => row[1] as string) : []
    }

    const specs = columns.map((c) => (typeof c === 'string' ? { name: c, type: 'TEXT' } : c))
    const existing = readColumns()
    for (const spec of specs.filter((c) => !existing.includes(c.name))) {
      try {
        db.run(`ALTER TABLE vector_embeddings ADD COLUMN ${spec.name} ${spec.type}`)
      } catch (e) {
        // Logged for diagnosis; the verification below decides pass/fail so a
        // transient error on one column cannot leave a silent partial upgrade.
        console.error(`[VectorStore] ALTER ADD COLUMN ${spec.name} failed:`, e)
      }
    }

    // Verification — fail closed if the table still lacks a required column.
    const after = readColumns()
    const stillMissing = specs.map((c) => c.name).filter((c) => !after.includes(c))
    if (stillMissing.length > 0) {
      throw new Error(
        `[VectorStore] vector_embeddings is missing required column(s) after repair: ${stillMissing.join(', ')}. ` +
          'Initialization aborted so it can be retried; indexing would otherwise fail on every insert.'
      )
    }
  }

  /**
   * Column order for the partition load. Explicit rather than `SELECT *` so the
   * per-row index lookup is a constant, and so adding a column to the table
   * never silently widens what boot pulls into RAM.
   */
  private static readonly LOAD_COLUMNS = [
    'id',
    'embedding',
    'meeting_id',
    'recording_id',
    'chunk_index',
    'timestamp',
    'subject',
    'source_type',
    'capture_id',
    'embed_provider',
    'embed_dims'
  ] as const

  private async loadFromDatabase(
    activeProvider: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const db = getDatabase()
    // One round trip for both numbers: the row count sizes the arena and the
    // dimension makes every row's offset arithmetic, not a per-row allocation.
    // MIN/MAX disagree only on a corrupt partition, which falls back below.
    const statsRes = db.exec(
      `SELECT COUNT(*), MIN(embed_dims), MAX(embed_dims)
         FROM vector_embeddings WHERE embed_provider = ?`,
      [activeProvider]
    )
    const stats = statsRes.length > 0 ? statsRes[0].values[0] : null
    const total = (stats?.[0] as number | undefined) ?? 0
    const minDims = (stats?.[1] as number | null | undefined) ?? null
    const maxDims = (stats?.[2] as number | null | undefined) ?? null

    // PERF (the 2026-09 OOM): the previous loader called blobToEmbedding per
    // row, and that does `bytes.buffer.slice(...)` — a FRESH ArrayBuffer for
    // every row. At 125k rows × 2048 dims that is 125k separate ~8 KB native
    // allocations, each with malloc overhead, fragmenting the native heap. The
    // live vectors are ~1 GB; the process was committing 8.4 GB.
    //
    // A uniform partition instead gets ONE contiguous arena and every document
    // holds a `subarray` VIEW into it. Same bytes, one allocation, no
    // fragmentation. A partition with mixed or unknown dimensions keeps the
    // old per-row path — correctness first, and it is the rare case.
    const uniformDims =
      minDims !== null && maxDims !== null && minDims === maxDims && minDims > 0 ? minDims : null
    let arena: Float32Array | null = null
    let arenaOffset = 0
    if (uniformDims !== null && total > 0) {
      try {
        arena = new Float32Array(total * uniformDims)
        this.partitionArena = arena
      } catch (e) {
        // A single allocation this large can fail where many small ones would
        // not. Degrade to the per-row path rather than failing the boot.
        console.warn(
          `[VectorStore] contiguous arena (${total}×${uniformDims}) allocation failed, using per-row load:`,
          e
        )
        arena = null
        this.partitionArena = null
      }
    }

    const cols = VectorStore.LOAD_COLUMNS
    const columnList = cols.join(', ')
    // `content` is deliberately absent — see the VectorDocument.content docs.
    const I = {
      id: 0,
      embedding: 1,
      meetingId: 2,
      recordingId: 3,
      chunkIndex: 4,
      timestamp: 5,
      subject: 6,
      sourceType: 7,
      captureId: 8,
      embedProvider: 9,
      embedDims: 10
    }

    // Batched load with event-loop yields: a single SELECT of 110k+ rows (and
    // the blob→float parse loop) blocks the main process for seconds at boot
    // (BootScheduler SLOW-task warnings). Bound each page to roughly 1.5 MB
    // for 3072-dim vectors rather than copying ~60 MB before each yield.
    const BATCH = 128
    let loaded = 0
    let afterId = ''
    for (;;) {
      const rows = db.exec(
        `SELECT ${columnList} FROM vector_embeddings
         WHERE embed_provider = ? AND id > ?
         ORDER BY id
         LIMIT ?`,
        [activeProvider, afterId, BATCH]
      )
      if (rows.length === 0 || rows[0].values.length === 0) break

      for (const row of rows[0].values) {
        // No intermediate `Record<string, unknown>` per row: the old loader
        // built a throwaway 13-key object 125k times purely to index it by
        // name. Fixed indices read straight off the row tuple.
        const embedding = this.readEmbeddingInto(row[I.embedding], uniformDims, arena, arenaOffset)
        if (embedding.usedArena) arenaOffset += uniformDims as number

        this.documents.set(row[I.id] as string, {
          id: row[I.id] as string,
          embedding: embedding.vector,
          metadata: {
            meetingId: (row[I.meetingId] as string | undefined) || undefined,
            recordingId: (row[I.recordingId] as string | undefined) || undefined,
            chunkIndex: row[I.chunkIndex] as number,
            timestamp: (row[I.timestamp] as string | undefined) || undefined,
            subject: (row[I.subject] as string | undefined) || undefined,
            sourceType: (row[I.sourceType] as string | undefined) || undefined,
            captureId: (row[I.captureId] as string | undefined) || undefined,
            embedProvider: (row[I.embedProvider] as string | undefined) || undefined,
            embedDims: (row[I.embedDims] as number | undefined) || undefined
          }
        })
      }

      loaded += rows[0].values.length
      afterId = rows[0].values[rows[0].values.length - 1][I.id] as string
      onProgress?.(Math.min(loaded, total), total)
      if (rows[0].values.length < BATCH) break
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /**
   * Place one stored BLOB into the partition arena and return a view over it.
   *
   * Falls back to the standalone per-row decode when there is no arena, when
   * the arena is full (rows inserted after the COUNT that sized it), or when
   * this row's byte length disagrees with the partition dimension. The caller
   * advances the arena offset only when `usedArena` is true, so a fallback row
   * never leaves a hole or shifts every later row.
   */
  private readEmbeddingInto(
    value: unknown,
    dims: number | null,
    arena: Float32Array | null,
    offset: number
  ): { vector: number[] | Float32Array; usedArena: boolean } {
    if (arena === null || dims === null || offset + dims > arena.length) {
      return { vector: blobToEmbedding(value), usedArena: false }
    }
    const bytes =
      value instanceof Uint8Array ? value : Buffer.isBuffer(value) ? (value as Buffer) : null
    if (!bytes || Math.floor(bytes.byteLength / 4) !== dims) {
      return { vector: blobToEmbedding(value), usedArena: false }
    }
    // Byte-wise copy into the arena, then hand back a view over it.
    //
    // This deliberately does NOT build a Float32Array over the source buffer:
    // Node hands out Buffers carved from a shared pool, so `bytes.byteOffset`
    // is rarely 4-byte aligned and `new Float32Array(buf, offset, dims)` would
    // throw RangeError on most rows. Uint8Array has no alignment requirement,
    // and both sides are little-endian, so the copy is byte-exact.
    const dst = new Uint8Array(arena.buffer, arena.byteOffset + offset * 4, dims * 4)
    dst.set(bytes.subarray(0, dims * 4))
    return { vector: arena.subarray(offset, offset + dims), usedArena: true }
  }

  /**
   * The partition label stamped on newly embedded chunks: the brain the
   * router says WOULD serve embeddings now, with a dims-based inference
   * fallback (the label must never be null for a successfully embedded chunk
   * or the row becomes unservable). A mid-call provider switch can mislabel
   * a batch by one row-set — harmless: the chunk is real and searchable
   * under the partition it is stamped with (scores stay within-model).
   */
  private async activePartitionLabel(dims: number): Promise<string | undefined> {
    const active = await getEmbeddingsService().activeProviderId()
    if (active) return active
    const BY_DIMS: Record<number, string> = { 3072: 'gemini-api', 2048: 'local-onnx-embed', 768: 'ollama' }
    return BY_DIMS[dims]
  }

  async addDocument(
    content: string,
    metadata: VectorDocument['metadata']
  ): Promise<string | null> {
    const embedding = await getEmbeddingsService().generateEmbedding(content)
    if (!embedding) {
      console.error('Failed to generate embedding for document')
      return null
    }

    const partition = await this.activePartitionLabel(embedding.length)
    const id = `${metadata.recordingId || 'doc'}_${metadata.chunkIndex}_${partition ?? 'unknown'}_${Date.now()}`

    const doc: VectorDocument = {
      id,
      // No `content`: the in-memory index does not hold chunk text (see
      // VectorDocument.content). Keeping it here only for freshly inserted
      // rows would make a backfill re-accumulate exactly what the boot load
      // stopped holding — a 125k-chunk reindex would end at the old figure.
      // The text is in the row being written a few lines below.
      embedding,
      metadata: { ...metadata, embedProvider: partition, embedDims: embedding.length }
    }

    // Store in memory
    this.documents.set(id, doc)

    // Persist to database
    const db = getDatabase()
    db.run(
      `INSERT OR REPLACE INTO vector_embeddings
       (id, content, embedding, meeting_id, recording_id, chunk_index, timestamp, subject, source_type, capture_id, embed_provider, embed_dims)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        content,
        embeddingToBlob(embedding),
        metadata.meetingId || null,
        metadata.recordingId || null,
        metadata.chunkIndex,
        metadata.timestamp || null,
        metadata.subject || null,
        metadata.sourceType || null,
        metadata.captureId || null,
        partition ?? null,
        embedding.length
      ]
    )

    return id
  }

  async indexTranscript(
    transcript: string,
    metadata: {
      meetingId?: string
      recordingId?: string
      timestamp?: string
      subject?: string
      /** Tags every chunk with a non-transcript origin (e.g. 'image' for a screenshot). */
      sourceType?: string
      /** knowledge_capture id backing the source, carried onto every chunk. */
      captureId?: string
      /**
       * RE-1 (Codex adversarial re-review round 2) — optional eligibility gate
       * re-checked AFTER embeddings are generated (an async await) and
       * immediately BEFORE the synchronous write loop. Returns false ⇒ the
       * caller's recording became ineligible (hard purge / trash / personal)
       * while embeddings ran, so nothing is persisted (returns 0). Not stored on
       * any chunk's metadata.
       */
      shouldPersist?: () => boolean
      /**
       * ADV41-2 (round-43) — PRE-PROVIDER eligibility gate. `shouldPersist`
       * above runs only AFTER the embeddings await (post-provider), so it can
       * block the WRITE but cannot un-send content to the external embeddings
       * provider. This callback is invoked in the SAME synchronous step
       * IMMEDIATELY BEFORE the embeddings provider call; returning false ⇒
       * indexTranscript returns 0 WITHOUT calling the provider. Every caller
       * whose recording can become excluded mid-run should pass it (the boot
       * backfill does). Not stored on any chunk's metadata.
       */
      shouldGenerate?: () => boolean
    }
  ): Promise<number> {
    this.ensureSchema()
    // Destructure the gates out so they never land on a stored chunk's metadata.
    const { shouldPersist, shouldGenerate, ...chunkMeta } = metadata
    // Check if already indexed FOR THE ACTIVE PROVIDER'S PARTITION. Chunks
    // embedded by another provider do NOT count — that is exactly the
    // provider-switch reindex path (the same recording gets a second set of
    // chunks under the new partition; the old set stays as the backup).
    const partitionProvider = await getEmbeddingsService().activeProviderId()
    if (chunkMeta.recordingId && partitionProvider) {
      const existing = Array.from(this.documents.values()).filter(
        (d) => d.metadata.recordingId === chunkMeta.recordingId && d.metadata.embedProvider === partitionProvider
      )
      if (existing.length > 0) {
        console.log(`Transcript ${chunkMeta.recordingId} already indexed (provider ${partitionProvider})`)
        return 0
      }
    }

    // Chunk the transcript and embed all chunks in one batched call
    const chunks = chunkText(transcript)

    // ADV41-2 (round-43) — PRE-PROVIDER gate, adjacent to the provider call with
    // NO await between here and generateEmbeddings. A top-of-function or batch
    // snapshot is defeated when an owner exclusion commits while an EARLIER
    // caller/row was awaiting; re-validate immediately before sending this
    // content to the external embeddings provider. Fail-closed callers return
    // false ⇒ nothing is sent, nothing is persisted (returns 0).
    if (shouldGenerate && !shouldGenerate()) {
      console.log(
        `[VectorStore] ${chunkMeta.recordingId ?? 'doc'} not eligible — skipping index (pre-provider)`
      )
      return 0
    }

    // ADV42-2 (round-44) — also forward shouldGenerate INTO the embeddings call so
    // the BrainRouter re-checks eligibility before the Gemini PRIMARY and the
    // Ollama FALLBACK embed attempts. The pre-provider guard above only covers
    // the moment before entering the router; if Gemini then fails and the router
    // falls back to Ollama, an exclusion committed during that window must not
    // reach the fallback provider either.
    const embeddings = await getEmbeddingsService().generateEmbeddings(chunks, { shouldGenerate, purpose: 'passage' })

    // RE-1 — re-check eligibility ADJACENT to the write, with no await between
    // here and the synchronous INSERT loop below. A hard purge that committed
    // while embeddings were generated must not leave orphaned vector rows.
    if (shouldPersist && !shouldPersist()) {
      console.log(`[VectorStore] ${chunkMeta.recordingId ?? 'doc'} no longer eligible — skipping index persist`)
      return 0
    }

    const db = getDatabase()
    const partition = partitionProvider ?? (await this.activePartitionLabel(embeddings.find(Boolean)?.length ?? 0))
    let indexed = 0
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i]
      if (!embedding) continue

      // The partition is part of the id: the same recording+chunk indexed
      // under two providers must NEVER collide (INSERT OR REPLACE would
      // silently overwrite the other partition's row).
      const id = `${chunkMeta.recordingId || 'doc'}_${i}_${partition ?? 'unknown'}_${Date.now()}`
      const doc: VectorDocument = {
        id,
        // No `content` — see addDocument. This is the path a full backfill
        // takes, so holding the text here is exactly what would undo the
        // change: 125k chunks reindexed would rebuild the ~206 MB.
        embedding,
        metadata: { ...chunkMeta, chunkIndex: i, embedProvider: partition, embedDims: embedding.length }
      }
      this.documents.set(id, doc)
      db.run(
        `INSERT OR REPLACE INTO vector_embeddings
         (id, content, embedding, meeting_id, recording_id, chunk_index, timestamp, subject, source_type, capture_id, embed_provider, embed_dims)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          chunks[i],
          embeddingToBlob(embedding),
          chunkMeta.meetingId || null,
          chunkMeta.recordingId || null,
          i,
          chunkMeta.timestamp || null,
          chunkMeta.subject || null,
          chunkMeta.sourceType || null,
          chunkMeta.captureId || null,
          partition ?? null,
          embedding.length
        ]
      )
      indexed++
    }

    console.log(`Indexed ${indexed} chunks for transcript`)
    return indexed
  }

  /**
   * Round-6 (RE6-1) — THE single choke-point every vector read primitive routes
   * through, so all consumers (global chat, meeting-scoped chat, summarize-
   * Meeting, meeting-scoped findActionItems, the rag:get-chunks chunk viewer)
   * inherit the same fail-closed eligibility policy.
   *
   * ADV23-1 (round-24) — POSITIVE PROVENANCE. Earlier the boundary KEPT any doc
   * that lacked a recordingId ("no recordingId ⇒ keep"). Legacy rows from the
   * removed optional-metadata rag:index-transcript path can carry NEITHER a
   * recordingId NOR a captureId, so they were unassociable — they survived every
   * recording exclusion / hard purge and still reached RAG + rag:get-chunks. A
   * doc is now kept ONLY if it has POSITIVE, resolvable, eligible provenance:
   * its recordingId resolves to an ELIGIBLE recording, OR its captureId resolves
   * to an ELIGIBLE capture. A doc with NEITHER (incl. the legacy neither-id rows)
   * is DROPPED. This is fail-closed and NON-DESTRUCTIVE — the rows stay in the
   * store, they are simply never served (a reindex/purge migration is a separate
   * follow-up). No legitimate doc lacks both: all four main-process indexers set
   * recordingId, and artifacts additionally set captureId (round 17).
   */
  private filterEligibleDocs(docs: VectorDocument[]): VectorDocument[] {
    // ADV11 (round-12) — POSITIVE PROVENANCE RESOLUTION against the DB.
    //
    // Round-11 discriminated recording-backed-ness by `captureId` PRESENCE
    // (`recordingId && !captureId`). That TRUSTED an UNTRUSTED field: the
    // `rag:index-transcript` IPC forwarded renderer-supplied metadata straight
    // into indexTranscript with no runtime stripping (the TS type omitting
    // captureId is compile-time only). A malicious/buggy renderer could index
    // `{recordingId: <excludedId>, captureId: <anything>}` → those chunks skipped
    // the recording allowlist and leaked an excluded recording's content back
    // into search / meeting retrieval / chunk display / the LLM. A doc's
    // `captureId` therefore cannot be a security discriminator.
    //
    // Instead, resolve provenance POSITIVELY: does `recordingId` name a REAL
    // recording row (any state)? Then it is recording-backed and MUST obey the
    // eligibility allowlist — a forged captureId cannot exempt a real excluded
    // recording. If `recordingId` does NOT resolve to a recording, the doc is a
    // genuine artifact ONLY when its `captureId` names an ELIGIBLE
    // knowledge_captures row; otherwise it is a forged chunk, a hard-purged
    // recording orphan, or an EXCLUDED artifact capture and is DROPPED (fail
    // closed). Docs with no `recordingId` are never gated here.
    //
    // ADV16-3 (round-17): the artifact branch previously kept a doc when its
    // captureId merely EXISTED (getExistingCaptureIds). Existence includes
    // soft-deleted + garbage/low-value captures, so excluded pdf/md/txt/image
    // artifact chunks reached global chat / meeting retrieval / chunk display.
    // Require ELIGIBILITY via the shared capture boundary instead of existence —
    // this still subsumes the forged-provenance protection (an ineligible/forged
    // captureId is absent from the eligible set ⇒ dropped) while keeping genuine
    // eligible artifacts (round-11 regression).
    //
    // ADV44 (round-46) — this positive-provenance logic is now the shared
    // {@link filterEligibleProvenanceRows} so the Today briefing's eligible-chunk
    // COUNT derives from the SAME implementation this read boundary uses (no
    // drift between what search serves and what the count claims).
    return filterEligibleProvenanceRows(
      docs,
      (d) => d.metadata.recordingId,
      (d) => d.metadata.captureId
    )
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const queryEmbedding = await getEmbeddingsService().generateEmbedding(query, { purpose: 'query' })
    if (!queryEmbedding) {
      console.error('Failed to generate query embedding')
      return []
    }

    // PROVIDER PARTITION — score only chunks embedded by the ACTIVE provider.
    // Cosine similarity is meaningless ACROSS models (different dims ⇒ 0 by
    // construction; same-dims-different-model ⇒ garbage). Pre-partition this
    // was the silent-dead-RAG failure mode (2026-07: Ollama-embedded queries
    // vs a Gemini-embedded store). Other partitions stay intact as the
    // instant backup when the user switches providers back.
    const activeProvider = await getEmbeddingsService().activeProviderId()

    // Calculate similarity scores over ELIGIBLE docs only (RE6-1 boundary).
    const results: SearchResult[] = []
    for (const doc of this.filterEligibleDocs([...this.documents.values()])) {
      if (doc.metadata.embedProvider !== activeProvider) continue
      if (doc.embedding.length !== queryEmbedding.length) continue
      const score = cosineSimilarity(queryEmbedding, doc.embedding)
      results.push({ document: doc, score })
    }

    // Sort by score descending, then apply light diversity reranking so a few
    // near-duplicate screenshot descriptions cannot evict all meeting evidence.
    results.sort((a, b) => b.score - a.score)
    const top = diversifyResults(results, topK)
    // Hydrate only the survivors: topK is single digits in every caller, so
    // this is a handful of rows read against the ~100 MB the index no longer
    // keeps resident for all 237k chunks. hydrateContent returns copies; the
    // indexed documents stay text-free.
    const hydrated = this.hydrateContent(top.map((r) => r.document))
    return top.map((r, i) => ({ ...r, document: hydrated[i] }))
  }

  /**
   * Index every transcript that has no vector embeddings yet. Runs in the
   * background after startup so the assistant's memory covers the whole
   * knowledge base, not just newly transcribed recordings.
   */
  async backfillMissingTranscripts(): Promise<{ indexed: number; skipped: number }> {
    this.ensureSchema()
    const db = getDatabase()
    // PROVIDER PARTITION — "missing" means missing FOR THE ACTIVE PROVIDER.
    // After a provider switch this re-embeds the whole library into the new
    // partition (the old partition is untouched — the instant backup).
    const activeProvider = await getEmbeddingsService().activeProviderId()
    if (!activeProvider) {
      console.log('[VectorStore] Backfill skipped — no usable embedding provider')
      return { indexed: 0, skipped: 0 }
    }
    const stmt = db.prepare(`
      SELECT t.recording_id, t.full_text, r.date_recorded, r.filename
      FROM transcripts t
      LEFT JOIN recordings r ON r.id = t.recording_id
      WHERE TRIM(COALESCE(t.full_text, '')) != ''
        AND COALESCE(r.personal, 0) = 0
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM vector_embeddings v WHERE v.recording_id = t.recording_id AND v.embed_provider = ?
        )
    `)
    stmt.bind([activeProvider])
    const rows: Array<{ recording_id: string; full_text: string; date_recorded?: string; filename?: string }> = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as never)
    }
    stmt.free()

    // ADV40 sweep (round-42) — route the candidate ids through THE shared
    // fail-closed boundary BEFORE the embeddings provider call. The SELECT above
    // only filters personal/deleted at the recording level, and its LEFT JOIN
    // treats a HARD-PURGED recording's orphaned transcript (r.* all NULL) as
    // eligible — so that content would be sent to the external embeddings
    // provider on boot. filterEligibleRecordingIds additionally excludes
    // value-excluded recordings and, being a positive allowlist, drops
    // hard-purged orphans. Fail-closed: on any lookup error index NOTHING this
    // pass (the RE-1 shouldPersist gate below remains for mid-run transitions).
    const { eligible, failClosed } = filterEligibleRecordingIds(rows.map((r) => r.recording_id))
    const eligibleRows = failClosed ? [] : rows.filter((r) => eligible.has(r.recording_id))

    let indexed = 0
    let skipped = rows.length - eligibleRows.length
    for (const row of eligibleRows) {
      try {
        // ADV41-2 (round-43) — `eligibleRows` snapshotted eligibility ONCE
        // before the loop. While an EARLIER row's indexTranscript awaited its
        // embeddings, the owner can exclude a LATER row (delete / personal /
        // value-exclude); that row is still in `eligibleRows`. Re-check per row
        // in the SAME synchronous step immediately before the call so an
        // excluded recording is never sent to the embeddings provider.
        if (!isRecordingEligible(row.recording_id)) {
          skipped++
          continue
        }
        const count = await this.indexTranscript(row.full_text, {
          recordingId: row.recording_id,
          timestamp: row.date_recorded,
          subject: row.filename,
          // ADV41-2 (round-43) — PRE-PROVIDER gate: re-validated by
          // indexTranscript IMMEDIATELY before the embeddings provider call, so
          // an exclusion committing during THIS row's own chunking window also
          // blocks the send (the per-row check above closes the window opened by
          // PRIOR rows' awaits; this closes the window inside indexTranscript).
          shouldGenerate: () => isRecordingEligible(row.recording_id),
          // P2 (round-3) — post-await defense: a hard purge / trash /
          // mark-personal landing DURING the embeddings await is re-checked
          // adjacent to the write (inside indexTranscript, after embeddings,
          // before the INSERT loop) so nothing orphaned is persisted.
          shouldPersist: () => isRecordingProcessable(row.recording_id)
        })
        if (count > 0) indexed++
        else skipped++
      } catch (e) {
        skipped++
        console.error(`[VectorStore] Backfill failed for ${row.recording_id}:`, e)
      }
    }
    if (rows.length > 0) {
      console.log(`[VectorStore] Backfill complete: ${indexed} transcripts indexed, ${skipped} skipped (of ${rows.length})`)
    }
    return { indexed, skipped }
  }

  /**
   * Neighbor re-attachment (Cerebras KB lesson): the chunks ADJACENT to a
   * matched chunk (chunkIndex±1, same recording) so an excerpt carries its
   * surrounding conversation. Restricted to the ACTIVE provider's partition
   * (neighbors must come from the same embedding run as the match) and routed
   * through the same eligibility boundary as every other read.
   */
  getChunkNeighbors(recordingId: string, chunkIndexes: Iterable<number>, providerId?: string): VectorDocument[] {
    const wanted = new Set<number>()
    for (const i of chunkIndexes) {
      wanted.add(i - 1)
      wanted.add(i + 1)
    }
    // Bounded by the neighbours of the chunks asked for; callers read the text.
    return this.hydrateContent(
      this.filterEligibleDocs(
        Array.from(this.documents.values()).filter(
          (d) =>
            d.metadata.recordingId === recordingId &&
            wanted.has(d.metadata.chunkIndex) &&
            (!providerId || d.metadata.embedProvider === providerId)
        )
      )
    )
  }

  async searchByMeeting(meetingId: string): Promise<VectorDocument[]> {
    // RE6-1 — meeting-scoped reads (meeting chat, summarizeMeeting, meeting-
    // scoped findActionItems) route through the SAME eligibility boundary.
    // PROVIDER PARTITION (see search()) — the re-ranker's query embedding is
    // only comparable within the active provider's model.
    const activeProvider = await getEmbeddingsService().activeProviderId()
    const docs = this.filterEligibleDocs(
      Array.from(this.documents.values()).filter(
        (d) => d.metadata.meetingId === meetingId && d.metadata.embedProvider === activeProvider
      )
    ).sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex)
    // Bounded by one meeting's chunks — the callers read the text.
    return this.hydrateContent(docs)
  }

  /**
   * Score ONE meeting's chunks against a query and return the best `topK`.
   *
   * This lived in rag.ts as a hand-rolled cosine loop over `doc.embedding`,
   * a second implementation of {@link cosineSimilarity} that happened to agree
   * with this one. Scoring belongs next to the vectors: it is the only reason
   * anything outside this file needed to read a raw embedding, and once the
   * vectors move to their own process a caller could not read them anyway.
   *
   * Matches the old rag.ts behaviour exactly, including its fallbacks: a
   * missing query embedding, or a chunk whose dimension disagrees with it,
   * scores 0.5 so the meeting's chunks are still returned in a sensible order
   * rather than disappearing from a meeting-scoped chat.
   */
  async searchWithinMeeting(
    meetingId: string,
    query: string,
    topK = 5
  ): Promise<SearchResult[]> {
    const docs = await this.searchByMeeting(meetingId)
    const queryEmbedding = await getEmbeddingsService().generateEmbedding(query, {
      purpose: 'query'
    })

    if (!queryEmbedding) {
      return docs.slice(0, topK).map((document) => ({ document, score: 0.5 }))
    }

    const scored = docs.map((document) => ({
      document,
      score:
        document.embedding.length === queryEmbedding.length
          ? cosineSimilarity(queryEmbedding, document.embedding)
          : 0.5
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  async deleteByRecording(recordingId: string): Promise<number> {
    const deleted = this.dropByRecordingFromMemory(recordingId)
    const db = getDatabase()
    db.run('DELETE FROM vector_embeddings WHERE recording_id = ?', [recordingId])
    return deleted
  }

  /**
   * Remove one recording's vectors from the live in-memory search corpus only.
   *
   * Transcript editing deletes the persisted rows in the same transaction as
   * the corrected source text, then calls this method after commit. Keeping the
   * memory mutation separate prevents a rolled-back database edit from leaving
   * the running assistant with a different corpus than SQLite.
   */
  dropByRecordingFromMemory(recordingId: string): number {
    let deleted = 0
    for (const [id, doc] of this.documents.entries()) {
      if (doc.metadata.recordingId !== recordingId) continue
      this.documents.delete(id)
      deleted++
    }
    return deleted
  }

  /**
   * AI-06 FIX: Update meeting_id for all chunks belonging to a recording
   * Called when AI links a recording to a meeting after transcription
   */
  async updateMeetingIdForRecording(recordingId: string, meetingId: string, meetingSubject?: string): Promise<number> {
    let updated = 0
    const db = getDatabase()

    // Update in-memory documents
    for (const doc of this.documents.values()) {
      if (doc.metadata.recordingId === recordingId) {
        doc.metadata.meetingId = meetingId
        if (meetingSubject) {
          doc.metadata.subject = meetingSubject
        }
        updated++
      }
    }

    // Update in database
    if (meetingSubject) {
      db.run(
        'UPDATE vector_embeddings SET meeting_id = ?, subject = ? WHERE recording_id = ?',
        [meetingId, meetingSubject, recordingId]
      )
    } else {
      db.run(
        'UPDATE vector_embeddings SET meeting_id = ? WHERE recording_id = ?',
        [meetingId, recordingId]
      )
    }

    console.log(`Updated meeting_id for ${updated} vector chunks (recording ${recordingId} -> meeting ${meetingId})`)
    return updated
  }

  getDocumentCount(): number {
    return this.documents.size
  }

  getMeetingCount(): number {
    const meetingIds = new Set<string>()
    for (const doc of this.documents.values()) {
      if (doc.metadata.meetingId) {
        meetingIds.add(doc.metadata.meetingId)
      }
    }
    return meetingIds.size
  }

  /**
   * ADV44-1 (round-46) — the ELIGIBILITY-FILTERED document count for status
   * surfaces (rag:status, Today statistics). getDocumentCount above returns the
   * RAW in-memory corpus size; soft-delete / value-exclude / personal intentionally
   * RETAIN their vector rows (retrieval filters them dynamically), so the raw size
   * over-counts excluded chunks and can make Chat look "ready" with ZERO eligible
   * docs. Route through the SAME fail-closed eligibility boundary search uses
   * ({@link filterEligibleDocs}); a lookup failure yields 0 (fail-closed).
   */
  getEligibleDocumentCount(providerId?: string): number {
    const docs = this.filterEligibleDocs([...this.documents.values()])
    return providerId ? docs.filter((d) => d.metadata.embedProvider === providerId).length : docs.length
  }

  /**
   * ADV44-1 (round-46) — distinct meetings among ELIGIBLE documents only (see
   * {@link getEligibleDocumentCount}). Excluded recordings no longer inflate the
   * displayed meeting count; fail-closed to 0 on any eligibility lookup failure.
   */
  getEligibleMeetingCount(providerId?: string): number {
    const meetingIds = new Set<string>()
    for (const doc of this.filterEligibleDocs([...this.documents.values()]).filter(
      (d) => !providerId || d.metadata.embedProvider === providerId
    )) {
      if (doc.metadata.meetingId) {
        meetingIds.add(doc.metadata.meetingId)
      }
    }
    return meetingIds.size
  }

  getAllDocuments(): VectorDocument[] {
    // RE6-1 — the chunk viewer (rag:get-chunks) and any other consumer of the
    // full document set inherit the fail-closed eligibility boundary here.
    return this.filterEligibleDocs(Array.from(this.documents.values()))
  }
}

// Singleton instance
let vectorStoreInstance: VectorStore | null = null

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    vectorStoreInstance = new VectorStore()
  }
  return vectorStoreInstance
}

export { VectorStore, chunkText, cosineSimilarity, diversifyResults }
export type { VectorDocument, SearchResult }
