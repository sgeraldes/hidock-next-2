// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { request } from 'http'
import Database from 'better-sqlite3'
import { RetrievalTraceStore } from '../retrieval-traces'
import { startBrainServer, type RunningBrainServer } from '../brain-server'

const state = vi.hoisted(() => ({
  record: vi.fn(), link: vi.fn(), search: vi.fn(), generate: vi.fn(), excluded: new Set<string>(),
  enabled: true, pinned: true, graph: true, failSearch: false, entities: false
}))
vi.mock('../retrieval-trace-service', () => ({ recordRetrievalTrace: (e: unknown) => state.enabled && state.record(e), linkTraceAnswer: state.link }))
vi.mock('../database', () => ({
  getDatabase: () => ({ exec: (sql: string) => {
    if (state.entities && sql.includes('FROM contacts')) return [{ values: [['contact-id', 'Person', '', 'person', 1]] }]
    if (state.entities && sql.includes('FROM projects')) return [{ values: [['project-id', 'Project', '', 'active', 1]] }]
    if (sql.includes('conversation_context')) return state.pinned ? [{ values: [['pin']] }] : []
    if (sql.includes('SELECT title, source_recording_id')) return [{ values: [['Pinned', 'rp']] }]
    if (sql.includes('SELECT full_text')) return [{ values: [['pinned text']] }]
    if (sql.includes('knowledge_captures')) return [{ values: [['capture', 'Title', 'Summary', '2026-10-01', 2]] }]
    return []
  } }),
  queryOne: (_sql: string, params: unknown[]) => ({ id: params[0] }), queryAll: () => [], escapeLikePattern: (s: string) => s,
  getEligibleRecordingIds: (ids: Iterable<string>) => ({ eligible: new Set([...ids].filter(id => !state.excluded.has(id))), failClosed: false }),
  getExcludedRecordingIds: () => ({ ids: state.excluded, failClosed: false }),
  getExistingRecordingIds: (ids: Iterable<string>) => ({ ids: new Set(ids), failClosed: false }),
  getExistingCaptureIds: (ids: Iterable<string>) => ({ ids: new Set(ids), failClosed: false }),
  getCaptureEligibilityRows: () => ({ rows: [{ id: 'capture', source_recording_id: 'rv', deleted_at: null }], failClosed: false })
}))
vi.mock('../vector-store', () => ({ getVectorStore: () => ({ search: state.search, getChunkNeighbors: () => [], getEligibleDocumentCount: () => state.failSearch ? 10 : 0 }) }))
vi.mock('../chat-llm', () => ({ getChatLLMService: () => ({ generate: state.generate }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({ activeProviderId: async () => 'ollama', relevanceThreshold: async () => 0.3 }) }))
vi.mock('../knowledge-graph-service', () => ({
  getGroundingExclusionSet: () => ({ ids: state.excluded, failClosed: false }),
  resolveEntityToNodeId: (id: string) => id === 'contact-id' ? 'person-node' : null,
  findMentionedEntity: () => ({ id: 'node' }), queryListNodes: () => [],
  neighborhoodFacts: (_id: string, _hops: number, _limit: number, _exclusion: unknown, prov: { recordingIds: Set<string> }) => {
    if (!state.graph) return ''
    prov.recordingIds.add('rg')
    return 'graph facts'
  }
}))
vi.mock('../brains', () => ({ getBrainRouter: () => ({ resolvePrimaryChatBrainId: async () => 'ollama', getLastChatFailure: () => null }) }))
vi.mock('../event-bus', () => ({ getEventBus: () => ({ onDomainEvent: () => {} }) }))
import { getRAGService, resetRAGService } from '../rag'

let directory: string
let store: RetrievalTraceStore
let server: RunningBrainServer | undefined
beforeEach(() => {
  vi.clearAllMocks()
  resetRAGService()
  state.enabled = state.pinned = state.graph = true
  state.failSearch = false
  state.entities = false
  state.excluded.clear()
  directory = mkdtempSync(join(tmpdir(), 'hidock-trace-hooks-test-'))
  store = new RetrievalTraceStore({ path: join(directory, 'traces.db'), eligible: () => true,
    storage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable') }, decryptString: () => '' } })
  state.record.mockImplementation(e => store.record(e))
  state.generate.mockImplementation(async (_messages, options) => { options.onDispatch?.(); options.onCall?.('generation-call'); return 'answer' })
  state.search.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ score: 0.9 - i * 0.1,
    document: { id: `unstable-${Date.now()}-${i}`, content: `chunk ${i}`, embedding: [1, 2],
      metadata: { recordingId: 'rv', chunkIndex: i, embedProvider: 'ollama', embedDims: 2 } } })))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await store.close()
  rmSync(directory, { recursive: true })
})
describe('request hooks to real temporary trace SQLite', () => {
  it('keeps generation B cancellable when generation A throws for the same session', async () => {
    let rejectA!: (error: Error) => void
    let releaseB!: () => void
    const service = getRAGService()
    const internals = service as unknown as {
      generateAnswer(session: string, query: string): Promise<unknown>
      activeControllers: Map<string, AbortController>
    }
    state.search.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject }))
    state.search.mockImplementationOnce(() => new Promise(resolve => { releaseB = () => resolve([]) }))
    const a = internals.generateAnswer('shared', 'question A')
    const aFailure = expect(a).rejects.toThrow('A failed')
    await vi.waitFor(() => expect(rejectA).toBeTypeOf('function'))
    const controllerA = internals.activeControllers.get('shared')!
    const b = internals.generateAnswer('shared', 'question B')
    await vi.waitFor(() => expect(releaseB).toBeTypeOf('function'))
    const controllerB = internals.activeControllers.get('shared')!
    expect(controllerB).not.toBe(controllerA)
    rejectA(new Error('A failed'))
    await aFailure
    expect(internals.activeControllers.get('shared')).toBe(controllerB)
    expect(service.cancelRequest('shared')).toBe(true)
    expect(controllerB.signal.aborted).toBe(true)
    releaseB()
    await b
  })
  it('never exposes the 101st brain identity after it becomes personal', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `capture-${index + 1}`)
    await store.close()
    store = new RetrievalTraceStore({ path: join(directory, 'traces.db'), eligible: c => !state.excluded.has(c.source_id),
      storage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' } })
    server = await startBrainServer({ kind: 'app', token: 'test', instanceId: 'test', recordTrace: e => store.record(e), queries: {
      meetingsSince: () => [], pendingActionablesSince: () => [], actionableById: () => null,
      knowledgeByIds: () => ids.map(id => ({ id })), knowledgeById: () => null,
      meetingRecordings: () => [], transcriptForRecording: () => null, recordingById: () => null, recordingsByFilenamePrefix: () => []
    } })
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server!.port, path: `/knowledge?ids=${ids.join(',')}`,
        headers: { host: `127.0.0.1:${server!.port}`, authorization: 'Bearer test' } }, res => {
        res.resume(); res.on('end', resolve)
      })
      req.on('error', reject); req.end()
    })
    await store.flush()
    state.excluded.add(ids[100])
    const rows = await store.read()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ candidate_count: 101, truncated: true })
    expect(JSON.stringify(rows)).not.toContain('capture-101')
    expect(rows[0].args?.ids).toHaveLength(100)
  })
  it('persists only returned brain identifiers, never unresolved free text or invalid dates', async () => {
    server = await startBrainServer({ kind: 'app', token: 'test', instanceId: 'test', recordTrace: e => store.record(e), queries: {
      meetingsSince: () => [], pendingActionablesSince: () => [], actionableById: () => null,
      knowledgeByIds: () => [{ id: 'real-id' }], knowledgeById: () => null,
      meetingRecordings: () => [], transcriptForRecording: () => null, recordingById: () => null, recordingsByFilenamePrefix: () => []
    } })
    const read = (path: string) => new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server!.port, path,
        headers: { host: `127.0.0.1:${server!.port}`, authorization: 'Bearer test' } }, res => {
        res.resume(); res.on('end', resolve)
      })
      req.on('error', reject); req.end()
    })
    await read('/knowledge/private-medical-note')
    await read('/knowledge?ids=private-search-phrase,real-id')
    await read('/meetings?since=2026-99-99')
    await store.flush()
    const db = new Database(store.path, { readonly: true })
    try {
      for (const table of ['traces', 'candidates', 'meta', 'counters']) {
        const raw = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
        expect(raw).not.toContain('private-medical-note')
        expect(raw).not.toContain('private-search-phrase')
        expect(raw).not.toContain('2026-99-99')
      }
    } finally { db.close() }
    expect((await store.read())[1].args?.ids).toEqual(['real-id'])
  })
  it('uses real graph-node identities for Explore entities and marks unmapped results truncated', async () => {
    state.entities = true
    const response = await getRAGService().globalSearch('Title person')
    expect(response.success).toBe(true)
    await store.flush()
    const trace = (await store.read())[0]
    expect(trace).toMatchObject({ candidate_count: 3, truncated: true, status: 'ok' })
    expect(trace.candidates.map(c => c.source_id)).toEqual(['capture', 'person-node'])
    expect(trace.candidates[1]).toMatchObject({ source_kind: 'graph-node', raw_score: 1 })
  })
  it('records final vector ranks in the order sent after temporal adjustment', async () => {
    state.search.mockResolvedValue([
      { score: 0.7, document: { id: 'a', content: 'older', embedding: [1, 2], metadata: { recordingId: 'a', chunkIndex: 0, timestamp: '2020-01-01' } } },
      { score: 0.65, document: { id: 'b', content: 'recent', embedding: [1, 2], metadata: { recordingId: 'b', chunkIndex: 0, timestamp: new Date().toISOString() } } }
    ])
    await getRAGService().chat('session', 'what happened this week?')
    await store.flush()
    const candidates = (await store.read())[0].candidates.filter(c => c.channel === 'vector')
    expect(candidates.find(c => c.source_id === 'b')?.rank_after).toBe(1)
    expect(candidates.find(c => c.source_id === 'a')?.rank_after).toBe(2)
  })
  it('records the relevance-threshold drop and the adjusted score the ranking actually used', async () => {
    state.search.mockResolvedValue([
      { score: 0.6, document: { id: 'a', content: 'recent', embedding: [1, 2], metadata: { recordingId: 'a', chunkIndex: 0, timestamp: new Date().toISOString() } } },
      { score: 0.5, document: { id: 'b', content: 'older', embedding: [1, 2], metadata: { recordingId: 'b', chunkIndex: 0, timestamp: '2020-01-01' } } },
      { score: 0.1, document: { id: 'c', content: 'weak', embedding: [1, 2], metadata: { recordingId: 'c', chunkIndex: 0 } } }
    ])
    await getRAGService().chat('session', 'what happened this week?')
    await store.flush()
    const candidates = (await store.read())[0].candidates.filter(c => c.channel === 'vector' && c.rank_before !== null)
    expect(candidates.find(c => c.source_id === 'a')?.adjusted_score).toBeCloseTo(0.75)
    expect(candidates.find(c => c.source_id === 'b')?.adjusted_score).toBeCloseTo(0.5)
    expect(candidates.find(c => c.source_id === 'c')).toMatchObject({ kept: false, drop_reason: 'threshold', adjusted_score: null })
  })
  it('writes one chat trace with vector diversity drops, pinned and graph parts and generation identity', async () => {
    const answer = await getRAGService().chat('session', 'question')
    await store.flush()
    const rows = await store.read()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trace_id: answer.generationId, session_ref: 'session', status: 'ok', intent: 'general' })
    expect(rows[0].candidates.map(c => c.channel)).toEqual(expect.arrayContaining(['vector', 'pinned', 'graph']))
    expect(rows[0].candidates.filter(c => c.channel === 'vector')).toHaveLength(3)
    expect(rows[0].candidates.some(c => c.drop_reason === 'diversity-cap' && !c.kept)).toBe(true)
    expect(rows[0].candidates.some(c => c.sent_to_model && c.source_id === 'pin')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('unstable-')
  })
  it('records post-await recheck drops', async () => {
    state.excluded.add('rv')
    await getRAGService().chat('session', 'question')
    await store.flush()
    expect((await store.read())[0].candidates.some(c => c.source_id === 'rv' && c.drop_reason === 'recheck' && !c.sent_to_model)).toBe(true)
  })
  it.each(['empty', 'provider-failure', 'error', 'cancelled'] as const)('records %s outcome', async outcome => {
    state.pinned = state.graph = false
    if (outcome === 'empty' || outcome === 'provider-failure') state.search.mockResolvedValue([])
    state.failSearch = outcome === 'provider-failure'
    if (outcome === 'error') state.generate.mockRejectedValue(new Error('provider secret payload'))
    if (outcome === 'cancelled') state.generate.mockImplementation(async (_m, options) => {
      getRAGService().cancelRequest('session')
      expect(options.signal.aborted).toBe(true)
      return null
    })
    try { await getRAGService().chat('session', 'question') } catch { /* caller preserves provider failure */ }
    await store.flush()
    const row = (await store.read())[0]
    expect(row.status).toBe(outcome === 'provider-failure' ? 'error' : outcome)
    expect(JSON.stringify(row)).not.toContain('secret payload')
    if (outcome === 'provider-failure') expect(row.retrieval_issue).toBe(outcome)
  })
  it('records Explore results with order and scores', async () => {
    await getRAGService().globalSearch('Title Summary')
    await store.flush()
    const row = (await store.read())[0]
    expect(row.consumer).toBe('explore')
    expect(row.candidates[0]).toMatchObject({ source_id: 'capture', rank_before: 1, raw_score: 2, sent_to_model: false })
  })
  it('writes no chat or Explore trace when recording is off', async () => {
    state.enabled = false
    await getRAGService().chat('session', 'question')
    await getRAGService().globalSearch('Title')
    await store.flush()
    expect(await store.read()).toEqual([])
  })
  it('records an authenticated brain read and only the client header; skips health', async () => {
    const token = randomBytes(32).toString('hex')
    server = await startBrainServer({ kind: 'service', token, instanceId: 'test', recordTrace: e => store.record(e), queries: {
      meetingsSince: () => [{ id: 'm1' }, { id: 'm2' }], pendingActionablesSince: () => [], actionableById: () => null,
      knowledgeByIds: () => [], knowledgeById: () => null, meetingRecordings: () => [], transcriptForRecording: () => null,
      recordingById: () => null, recordingsByFilenamePrefix: () => []
    } })
    const read = (path: string) => new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server!.port, path,
        headers: { host: `127.0.0.1:${server!.port}`, authorization: `Bearer ${token}`, 'X-HiDock-Client': 'test-agent', 'X-Secret': token } }, res => {
        res.resume(); res.on('end', resolve)
      })
      req.on('error', reject); req.end()
    })
    await read('/health')
    await read('/meetings?since=2026-10-01')
    await read('/private-free-text/another-private-piece')
    await store.flush()
    const rows = await store.read()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ consumer: 'brain', client: 'test-agent', route: '/meetings', args: { since: '2026-10-01' }, status: 'ok' })
    expect(rows[0].candidates.map(c => c.source_id)).toEqual(['m1', 'm2'])
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows[1]).toMatchObject({ route: '/unknown' })
    expect(rows[1].args).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain('private-free-text')
    expect(JSON.stringify(rows)).not.toContain('another-private-piece')
  })
})
