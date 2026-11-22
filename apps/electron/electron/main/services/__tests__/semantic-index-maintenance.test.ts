vi.mock('../feature-gate', () => ({ isFeatureEnabled: () => deps.feature }))
/** @vitest-environment node */
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import initSqlJs from 'sql.js'
const deps = vi.hoisted(() => ({
  db: null as any,
  feature: true,
  eligible: true,
  recover: false,
  space: 'space-a',
  release: null as null | (() => void),
  generate: vi.fn(),
  profile: vi.fn()
}))
vi.mock('../database', () => ({
  getDatabase: () => deps.db,
  queryAll: (sql: string, params: unknown[] = []) => {
    const stmt = deps.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  },
  queryOne: (sql: string, params: unknown[] = []) => {
    const stmt = deps.db.prepare(sql)
    try {
      stmt.bind(params)
      return stmt.step() ? stmt.getAsObject() : undefined
    } finally {
      stmt.free()
    }
  }
}))
vi.mock('../config', () => ({
  getConfig: () => ({
    brains: {
      taskRouting: { embed: 'model-host-embed' },
      enabled: { 'model-host-embed': true },
      modelHostEmbedding: { spaceId: deps.space }
    },
    transcription: { modelHostUrl: 'https://test:8766' }
  })
}))
vi.mock('../../recovery-mode', () => ({ isRecoveryMode: () => deps.recover }))
vi.mock('../recording-eligibility', () => ({
  isRecordingEligible: () => deps.eligible
}))
vi.mock('../brains/model-host-embed-brain', () => ({
  readRemoteEmbeddingSpace: () => deps.profile()
}))
vi.mock('../vector-store', () => ({
  getVectorStore: () => ({
    indexTranscript: async (_text: string, options: any) => {
      deps.db.run('INSERT OR IGNORE INTO vector_index_pending VALUES (?,?)', [
        options.recordingId,
        options.expectedProviderId
      ])
      if (!options.shouldGenerate()) return 0
      await deps.generate()
      if (!options.shouldPersist()) return 0
      deps.db.run('INSERT INTO vector_embeddings VALUES (?,?)', [options.recordingId, options.expectedProviderId])
      options.onBatchCommitted(4)
      return 4
    }
  })
}))
import { SemanticIndexMaintenance } from '../semantic-index-maintenance'
let service: SemanticIndexMaintenance
beforeEach(async () => {
  deps.db = new (await initSqlJs()).Database()
  deps.db.run(`CREATE TABLE recordings(id TEXT); CREATE TABLE transcripts(recording_id TEXT,full_text TEXT);
    CREATE TABLE vector_embeddings(id TEXT,embed_provider TEXT);CREATE TABLE vector_index_pending(recording_id TEXT,embed_provider TEXT,PRIMARY KEY(recording_id,embed_provider));
    INSERT INTO recordings VALUES ('a'); INSERT INTO transcripts VALUES ('a','fixture');INSERT INTO vector_embeddings VALUES ('old','old-provider');`)
  deps.feature = true
  deps.eligible = true
  deps.recover = false
  deps.space = 'space-a'
  deps.release = null
  deps.profile.mockReset().mockResolvedValue({ spaceId: 'space-a' })
  deps.generate.mockReset().mockResolvedValue(undefined)
  service = new SemanticIndexMaintenance()
})
afterEach(async () => {
  deps.release?.()
  await service.waitForIdle()
  deps.db.close()
})
it('does no startup work and persists a bounded, resumable ledger preserving old partitions', async () => {
  expect(service.status().state).toBe('idle')
  expect(deps.profile).not.toHaveBeenCalled()
  const started = service.start({ maxBatches: 2 })
  await service.waitForIdle()
  expect(service.status()).toMatchObject({
    state: 'paused',
    batches: 2,
    indexedChunks: 8,
    otherPartitionRows: 1
  })
  const restored = new SemanticIndexMaintenance()
  expect(restored.status().state).toBe('paused')
  expect(deps.generate).toHaveBeenCalledTimes(2)
  restored.control('resume', started.runId!)
  await restored.waitForIdle()
  expect(restored.status()).toMatchObject({
    state: 'paused',
    batches: 4,
    indexedChunks: 16,
    otherPartitionRows: 1
  })
})
it('cancel holds ownership until the in-flight call settles and refuses its late vectors', async () => {
  deps.generate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        deps.release = resolve
      })
  )
  const run = service.start()
  await vi.waitFor(() => expect(deps.release).not.toBeNull())
  expect(service.control('cancel', run.runId!).state).toBe('cancelling')
  expect(() => service.start()).toThrow('existing')
  deps.release!()
  await service.waitForIdle()
  expect(service.status()).toMatchObject({
    state: 'cancelled',
    indexedChunks: 0,
    activePartitionRows: 0,
    otherPartitionRows: 1
  })
})
it('pause finishes only the current batch; explicit resume refuses a changed binding', async () => {
  deps.generate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        deps.release = resolve
      })
  )
  const run = service.start()
  await vi.waitFor(() => expect(deps.release).not.toBeNull())
  service.control('pause', run.runId!)
  deps.release!()
  await service.waitForIdle()
  expect(service.status()).toMatchObject({
    state: 'paused',
    batches: 1,
    indexedChunks: 4
  })
  deps.space = 'changed'
  expect(() => service.control('resume', run.runId!)).toThrow('changed')
})
it('stops on the first provider error without retry and marks interrupted persisted work without resuming it', async () => {
  deps.generate.mockRejectedValue(new Error('busy'))
  service.start()
  await service.waitForIdle()
  expect(deps.generate).toHaveBeenCalledTimes(1)
  expect(service.status()).toMatchObject({
    state: 'failed',
    error: 'busy',
    indexedChunks: 0
  })
  deps.db.run("UPDATE semantic_index_runs SET state='running'")
  expect(new SemanticIndexMaintenance().status().state).toBe('interrupted')
  expect(deps.generate).toHaveBeenCalledTimes(1)
})
it('refuses a privacy change during provider work and recovery mode before launch', async () => {
  deps.generate.mockImplementation(async () => {
    deps.eligible = false
  })
  service.start()
  await service.waitForIdle()
  expect(service.status()).toMatchObject({
    state: 'failed',
    activePartitionRows: 0
  })
  service.control('cancel', service.status().runId!)
  deps.recover = true
  expect(() => service.start()).toThrow('recovery')
})

it('rejects initiation with assistant disabled but permits cancelling persisted work', async () => {
  const run = service.start({ maxBatches: 1 })
  await service.waitForIdle()
  deps.feature = false
  expect(() => service.control('resume', run.runId!)).toThrow('Assistant feature is disabled')
  expect(service.control('cancel', run.runId!).state).toBe('cancelled')
  expect(() => service.start()).toThrow('Assistant feature is disabled')
})
