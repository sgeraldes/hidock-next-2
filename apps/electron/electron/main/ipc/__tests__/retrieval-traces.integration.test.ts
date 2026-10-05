// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ directory: '', keepText: true, recording: true, handlers: {} as Record<string, (...args: any[]) => any> }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => { state.handlers[channel] = handler } },
  app: { getVersion: () => 'test' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable') }, decryptString: () => '' }
}))
vi.mock('../../services/config', () => ({ getDataPath: () => state.directory,
  getConfig: () => ({ chat: { recordQueries: state.recording, keepQueryText: state.keepText } }) }))
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => join(state.directory, 'business.db') }))
vi.mock('../../services/rag', () => ({ getRAGService: () => ({
  consumeAssistantAnswer: () => ({ kind: 'non-rag', content: 'main owned answer' }), clearSession: () => {}
}) }))
import { initializeDatabase, initializeDatabaseReadOnly, closeDatabase, run, queryOne } from '../../services/database'
import { recordRetrievalTrace, retrievalTraceStats, closeRetrievalTraces, syncTraceSettings } from '../../services/retrieval-trace-service'
import { registerAssistantHandlers } from '../assistant-handlers'
import Database from 'better-sqlite3'

beforeEach(async () => {
  state.directory = mkdtempSync(join(tmpdir(), 'hidock-trace-ipc-test-'))
  state.recording = state.keepText = true
  state.handlers = {}
  await initializeDatabase()
  run("INSERT INTO conversations (id, title) VALUES ('session', 'Test')")
  registerAssistantHandlers()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeRetrievalTraces()
  closeDatabase()
  rmSync(state.directory, { recursive: true })
})
describe('answer persistence and privacy at the SQLite/IPC boundary', () => {
  it('counts a meeting with an eligible recording even when its first recording is personal', async () => {
    run("INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('meeting', 'Meeting', '2026-10-01', '2026-10-02')")
    run("INSERT INTO recordings (id, filename, date_recorded, meeting_id, personal) VALUES ('first', 'first.wav', '2026-10-01', 'meeting', 1)")
    run("INSERT INTO recordings (id, filename, date_recorded, meeting_id) VALUES ('second', 'second.wav', '2026-10-01', 'meeting')")
    recordRetrievalTrace({ trace_id: 'meeting-trace', consumer: 'brain', route: '/meetings',
      started_at: new Date().toISOString(), duration_ms: 1, status: 'ok', candidates: [{
        channel: 'brain-row', source_kind: 'meeting', source_id: 'meeting', kept: true, sent_to_model: false
      }] })
    await closeRetrievalTraces()
    expect((await retrievalTraceStats()).consumers.brain).toBe(1)
    run("UPDATE recordings SET personal = 1 WHERE id = 'second'")
    expect((await retrievalTraceStats()).consumers.brain).toBe(0)
  })
  it('hides graph nodes when their current recording provenance becomes personal', async () => {
    const { getKnowledgeGraphStore } = await import('../../services/knowledge-graph-service')
    const graph = getKnowledgeGraphStore()
    run("INSERT INTO recordings (id, filename, date_recorded) VALUES ('graph-recording', 'temp.wav', '2026-10-01')")
    graph.db.run("INSERT INTO graph_nodes (id, type, label, norm_key, origin, source_recording_id) VALUES ('derived-node', 'topic', 'Topic', 'topic', 'derived', 'graph-recording')")
    recordRetrievalTrace({ trace_id: 'graph-trace', consumer: 'explore', route: 'globalSearch',
      started_at: new Date().toISOString(), duration_ms: 1, status: 'ok', candidates: [{
        channel: 'explore', source_kind: 'graph-node', source_id: 'derived-node', kept: true, sent_to_model: false
      }] })
    await closeRetrievalTraces()
    expect((await retrievalTraceStats()).consumers.explore).toBe(1)
    run("UPDATE recordings SET personal = 1 WHERE id = 'graph-recording'")
    closeDatabase()
    initializeDatabaseReadOnly()
    expect((await retrievalTraceStats()).consumers.explore).toBe(0)
  })
  it('resolves Explore graph identities without schema writes against a read-only business database', async () => {
    const { getKnowledgeGraphStore, resolveEntityToNodeId } = await import('../../services/knowledge-graph-service')
    const graph = getKnowledgeGraphStore()
    graph.db.run("INSERT INTO graph_nodes (id, type, label, norm_key, origin, props) VALUES ('person', 'person', 'Person', 'person', 'manual', ?)", [JSON.stringify({ contactId: 'contact' })])
    const initialize = vi.spyOn(graph, 'initSchema')
    closeDatabase()
    initializeDatabaseReadOnly()
    expect(resolveEntityToNodeId('contact', false)).toBe('person')
    expect(initialize).not.toHaveBeenCalled()
  })
  it('links the persisted answer message to its generation in a separate database', async () => {
    recordRetrievalTrace({ trace_id: 'generation', consumer: 'chat', session_ref: 'session', route: 'generateAnswer',
      started_at: new Date().toISOString(), duration_ms: 1, status: 'ok', query: 'question', candidates: [] })
    const answer = await state.handlers['assistant:addMessage']({}, 'session', 'assistant', 'ignored', undefined, 'generation')
    await closeRetrievalTraces()
    const db = new Database(join(state.directory, 'traces', 'retrieval-traces.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT answer_message_id FROM traces WHERE trace_id = ?').get('generation')).toEqual({ answer_message_id: answer.id })
      expect(queryOne<{ content: string }>('SELECT content FROM chat_messages WHERE id = ?', [answer.id])?.content).toBe('main owned answer')
      expect(queryOne("SELECT name FROM sqlite_master WHERE name = 'traces'")).toBeUndefined()
    } finally { db.close() }
  })
  it('counts eligible requests and hides a source made personal after the trace was recorded', async () => {
    run("INSERT INTO recordings (id, filename, date_recorded) VALUES ('recording', 'temp.wav', '2026-10-01')")
    recordRetrievalTrace({ trace_id: 'trace', consumer: 'brain', route: '/recordings/:id',
      started_at: new Date().toISOString(), duration_ms: 1, status: 'ok', candidates: [{
        channel: 'brain-row', source_kind: 'recording', source_id: 'recording', kept: true, sent_to_model: false
      }] })
    await closeRetrievalTraces()
    expect((await retrievalTraceStats()).consumers.brain).toBe(1)
    run("UPDATE recordings SET personal = 1 WHERE id = 'recording'")
    expect((await retrievalTraceStats()).consumers.brain).toBe(0)
    state.recording = false
    await syncTraceSettings()
    recordRetrievalTrace({ trace_id: 'disabled', consumer: 'explore', route: 'globalSearch', started_at: new Date().toISOString(), duration_ms: 1, status: 'empty', candidates: [] })
    await closeRetrievalTraces()
    const db = new Database(join(state.directory, 'traces', 'retrieval-traces.db'), { readonly: true })
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM traces').get()).toEqual({ count: 1 }) }
    finally { db.close() }
  })
})
