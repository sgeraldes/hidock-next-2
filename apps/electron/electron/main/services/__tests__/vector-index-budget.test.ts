// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeDatabase, run, closeDatabase } from '../database'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
paths.root = join(tmpdir(), `hidock-vector-budget-${process.pid}-${Date.now()}`)
paths.db = `${paths.root}.sqlite`
const providerWaitMs = vi.hoisted(() => ({ value: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {}, embeddings: { provider: 'ollama', chunkSize: 500, chunkOverlap: 50 }, storage: { dataPath: paths.root } }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({
  activeProviderId: async () => 'fixture',
  generateEmbeddings: vi.fn(async (texts: string[]) => {
    if (providerWaitMs.value) await new Promise((resolve) => setTimeout(resolve, providerWaitMs.value))
    return texts.map(() => [1, 0, 0])
  })
}) }))

const longText = 'A long spoken sentence about the project and its plan. '.repeat(60)

describe('vector indexing and the main-thread budget', () => {
  it('does not report the embedding provider wait as a main-thread hold', async () => {
    await initializeDatabase()
    const warn = vi.spyOn(console, 'warn')
    try {
      run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', ['budget-r', 'budget.webm', '2026-10-04'])
      const { VectorStore } = await import('../vector-store')
      const store = new VectorStore()
      await store.indexTranscript('Warmup.', { recordingId: 'warmup' })
      providerWaitMs.value = 150
      const indexed = await store.indexTranscript(longText, { recordingId: 'budget-r' })
      expect(indexed).toBeGreaterThanOrEqual(8) // two or more 4-chunk batches, each waiting 150 ms
      expect(warn.mock.calls.filter(([message]) => String(message).includes('held the main thread'))).toEqual([])
    } finally { providerWaitMs.value = 0; warn.mockRestore(); closeDatabase() }
  })

  it('sizes the vector arena to the batches it will index when maxBatches stops early', async () => {
    await initializeDatabase()
    try {
      run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', ['budget-m', 'budget-m.webm', '2026-10-04'])
      const { VectorStore } = await import('../vector-store')
      const store = new VectorStore()
      await store.indexTranscript('Warmup.', { recordingId: 'warmup-m' })
      expect(await store.indexTranscript(longText, { recordingId: 'budget-m', maxBatches: 1 })).toBe(4)
      const docs = [...(store as unknown as { documents: Map<string, { embedding: Float32Array; metadata: { recordingId?: string } }> }).documents.values()]
        .filter((doc) => doc.metadata.recordingId === 'budget-m')
      expect(docs).toHaveLength(4)
      // Four chunks of three float32 dimensions: the retained buffer holds them and no more.
      for (const doc of docs) expect(doc.embedding.buffer.byteLength).toBe(4 * 3 * 4)
    } finally { closeDatabase() }
  })
})
