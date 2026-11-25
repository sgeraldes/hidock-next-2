// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeDatabase, run, closeDatabase, queryOne } from '../database'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
paths.root = join(tmpdir(), `hidock-vector-atomic-${process.pid}-${Date.now()}`)
paths.db = `${paths.root}.sqlite`
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {}, embeddings: { provider: 'ollama', chunkSize: 500, chunkOverlap: 50 }, storage: { dataPath: paths.root } }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({ activeProviderId: async () => 'fixture', generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])) }) }))

describe('atomic transcript vector publication', () => {
  it('rolls back every chunk and publishes no documents when a later insert fails', async () => {
    await initializeDatabase()
    try {
      run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', ['atomic-r', 'atomic.webm', '2026-10-04'])
      const { VectorStore } = await import('../vector-store')
      const store = new VectorStore()
      // Ensure the store owns its schema before installing a real SQLite failure.
      await store.indexTranscript('Warmup.', { recordingId: 'warmup' })
      run("CREATE TRIGGER fail_second_vector BEFORE INSERT ON vector_embeddings WHEN NEW.recording_id='atomic-r' AND NEW.chunk_index=1 BEGIN SELECT RAISE(ABORT, 'later chunk failed'); END")
      await expect(store.indexTranscript('A long spoken sentence about the project. '.repeat(100), { recordingId: 'atomic-r' })).rejects.toThrow('later chunk failed')
      expect(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM vector_embeddings WHERE recording_id='atomic-r'")?.n).toBe(0)
      expect(store.getDocumentCount()).toBe(1)
    } finally { closeDatabase() }
  })
})

