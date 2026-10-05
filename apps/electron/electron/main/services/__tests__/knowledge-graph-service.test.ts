/**
 * Tests for knowledge-graph-service.ts
 *
 * Strategy: mock the Electron/config/ai-providers deps so we can test the service
 * logic without running a real LLM. The DB uses the real sql.js engine with a
 * unique in-memory-like temp file per test so each test is isolated.
 *
 * We avoid vi.resetModules() because it breaks top-level vi.mock() registrations.
 * Instead we reset the singleton via a dedicated export for test use.
 */

// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, mkdirSync, writeFileSync } from 'fs'

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' } }))

// Config mock with a known return value; tests can call (getConfig as Mock).mockReturnValue(...)
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    chat: { provider: 'gemini', geminiModel: 'gemini-2.0-flash', ollamaModel: '', maxContextChunks: 10 },
    transcription: { geminiApiKey: 'test-api-key', geminiModel: '' }, // pragma: allowlist secret
    storage: { dataPath: tmpdir(), maxRecordingsGB: 50 },
    calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15, lastSyncAt: null },
    embeddings: { provider: 'ollama', ollamaBaseUrl: '', ollamaModel: '', chunkSize: 500, chunkOverlap: 50 },
    device: { autoConnect: false, autoDownload: false },
    ui: { theme: 'system', defaultView: 'week', startOfWeek: 1, calendarView: 'week', hideEmptyMeetings: false, showListView: false },
    version: '1.0.0'
  }))
}))

// ai-providers — mock complete() so we never hit a real LLM
vi.mock('@hidock/ai-providers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@hidock/ai-providers')>()
  return { ...mod, complete: vi.fn() }
})

// file-storage — return a fresh temp path for every getDatabasePath() call
let _dbCounter = 0
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => join(tmpdir(), `hidock-kg-test-${Date.now()}-${++_dbCounter}.sqlite`))
}))

// ---------------------------------------------------------------------------
// Imports (after mocks so they pick up the mocked versions)
// ---------------------------------------------------------------------------

import { complete } from '@hidock/ai-providers'
import { getConfig } from '../config'
import { setCallSink, type CallRecord } from '../pipeline/call-store'
import { recordHarnessUsage } from '../brains/harness-usage'

// ---------------------------------------------------------------------------
// Fake extractor JSON
// ---------------------------------------------------------------------------

const FAKE_JSON = JSON.stringify({
  people: [
    { name: 'Alice', skills: ['TypeScript', 'AI'] },
    { name: 'Bob', skills: ['Python'] }
  ],
  topics: ['AI Strategy'],
  projects: ['Project Alpha'],
  decisions: ['Use TypeScript'],
  action_items: [{ text: 'Write docs', owner: 'Alice' }],
  risks: [{ text: 'Data breach', raised_by: 'Bob' }],
  next_steps: ['Schedule follow-up']
})

// ---------------------------------------------------------------------------
// Helper: spin up a fresh DB + reset the graph singleton for each test.
// We do this by importing the service after the test DB is initialised, so
// the GraphDb adapter picks up the fresh DB path.
//
// Because vi.mock() for file-storage returns a new path on each call,
// we re-initialize the database (which calls getDatabasePath()) at the start
// of each test, which forces a fresh SQLite file.
// ---------------------------------------------------------------------------

import { initializeDatabase, run as dbRun } from '../database'
import * as database from '../database'

// We expose a way to reset the singleton from the service module
// The service exports getKnowledgeGraphStore() which lazily creates _store.
// To reset between tests, we reimport the service after clearing module cache
// selectively — but since we can't use resetModules, instead we test via a
// single DB initialization (the store reads from the same db via run/queryAll).

beforeEach(async () => {
  vi.clearAllMocks()
  // Restore config to default (with a valid API key)
  ;(getConfig as any).mockReturnValue({
    chat: { provider: 'gemini', geminiModel: 'gemini-2.0-flash', ollamaModel: '', maxContextChunks: 10 },
    transcription: { geminiApiKey: 'test-api-key', geminiModel: '' }, // pragma: allowlist secret
  })
  ;(complete as any).mockResolvedValue(FAKE_JSON)
  // Initialize a fresh DB (getDatabasePath returns a new unique path each time)
  await initializeDatabase()
})

// ---------------------------------------------------------------------------
// Import the service ONCE (singleton is fine here because each test gets a
// fresh DB via the file-storage mock returning a new path, and initializeDatabase
// reinitialises the engine with that path).
// ---------------------------------------------------------------------------

import {
  ingestFromDbTranscripts,
  ingestFromFolder,
  getKnowledgeGraphStore,
  queryStats,
  queryListNodes,
  queryTopAttendees,
  queryTopSkill,
  queryPersonProfile,
  queryMeetingGraph,
} from '../knowledge-graph-service'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('knowledge-graph-service', () => {
  it('filters incremental candidates in SQL and reads text only for extraction', async () => {
    getKnowledgeGraphStore()
    dbRun('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', ['filtered', 'filtered.hda', '2025-10-10'])
    dbRun('INSERT INTO transcripts (id, recording_id, full_text) VALUES (?, ?, ?)', ['filtered-t', 'filtered', 'x'.repeat(40_000)])
    dbRun('INSERT INTO graph_ingested_transcripts (transcript_id, ingested_at) VALUES (?, ?)', ['filtered-t', new Date().toISOString()])
    const reads = vi.spyOn(database, 'queryOne')
    try {
      expect(database.getGraphIngestCandidates()).toEqual({ rows: [], skipped: 1 })
      expect((await ingestFromDbTranscripts()).skipped).toBe(1)
      const transcriptReads = reads.mock.calls.filter(([sql]) => /FROM transcripts t/i.test(sql))
      expect(transcriptReads.every(([sql]) => !sql.includes('t.full_text'))).toBe(true)
      expect(complete).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })
  it('bounds an incremental pass over 2,150 transcripts with 40 KB bodies', async () => {
    getKnowledgeGraphStore()
    database.runInTransaction(() => {
      for (let i = 0; i < 2150; i++) {
        dbRun('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', [`load-${i}`, `load-${i}.hda`, '2025-10-10'])
        dbRun('INSERT INTO transcripts (id, recording_id, full_text) VALUES (?, ?, ?)', [`load-t-${i}`, `load-${i}`, 'x'.repeat(40_000)])
        dbRun('INSERT INTO graph_ingested_transcripts (transcript_id, ingested_at) VALUES (?, ?)', [`load-t-${i}`, '2026-10-04'])
      }
    })
    const before = performance.now()
    // The previous hot path: eager bodies and one marker point-read per row.
    const legacy = database.queryAll<{ id: string; full_text: string }>('SELECT t.id, t.full_text FROM transcripts t JOIN recordings r ON r.id=t.recording_id WHERE COALESCE(r.personal,0)=0 AND r.deleted_at IS NULL')
    for (const row of legacy) database.queryOne('SELECT transcript_id FROM graph_ingested_transcripts WHERE transcript_id=?', [row.id])
    const legacyHold = performance.now() - before
    const after = performance.now()
    const result = await ingestFromDbTranscripts()
    const optimizedHold = performance.now() - after
    process.stdout.write(`GRAPH FIXTURE 2150 x 40000 bytes: legacy hold ${legacyHold.toFixed(1)}ms; filtered pass ${optimizedHold.toFixed(1)}ms\n`)
    expect(result).toEqual({ ingested: 0, skipped: 2150, errors: [] })
    expect(optimizedHold).toBeLessThan(100)
  })
  // =========================================================================
  // ingestFromDbTranscripts()
  // =========================================================================
  describe('ingestFromDbTranscripts()', () => {
    it('ingests a transcript and creates graph nodes', async () => {
      dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`,
        ['rec-1', 'test.hda', '2026-06-01', null])
      dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`,
        ['tx-1', 'rec-1', 'Alice discussed TypeScript.', 'en'])

      const result = await ingestFromDbTranscripts()

      expect(result.ingested).toBe(1)
      expect(result.skipped).toBe(0)
      expect(result.errors).toHaveLength(0)

      const store = getKnowledgeGraphStore()
      const people = store.findNodes({ type: 'person' })
      const names = people.map((n) => n.label)
      expect(names).toContain('Alice')
      expect(names).toContain('Bob')
    })

    it('skips already-ingested transcripts (incremental)', async () => {
      dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`,
        ['rec-2', 'test2.hda', '2026-06-01', null])
      dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`,
        ['tx-2', 'rec-2', 'Bob discussed Python ML.', 'en'])

      const r1 = await ingestFromDbTranscripts()
      expect(r1.ingested).toBe(1)
      expect(r1.skipped).toBe(0)

      // Second run — same transcript must be skipped
      const r2 = await ingestFromDbTranscripts()
      expect(r2.ingested).toBe(0)
      expect(r2.skipped).toBe(1)
    })

    it('throws "No AI provider configured" when no API key is set', async () => {
      ;(getConfig as any).mockReturnValue({
        chat: { provider: 'gemini', geminiModel: 'gemini-2.0-flash' },
        transcription: { geminiApiKey: '' },
      })

      await expect(ingestFromDbTranscripts()).rejects.toThrow('No AI provider configured')
    })

    it('collects per-transcript errors without crashing the whole run', async () => {
      dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`,
        ['rec-3', 'test3.hda', '2026-06-01', null])
      dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`,
        ['tx-3', 'rec-3', 'Some text', 'en'])

      ;(complete as any).mockRejectedValue(new Error('API rate limit'))

      const result = await ingestFromDbTranscripts()

      expect(result.ingested).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].error).toContain('API rate limit')
    })

    it('concurrent ingest runs do not double-ingest or inflate edge weights', async () => {
      dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`,
        ['rec-race', 'race.hda', '2026-06-01', null])
      dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`,
        ['tx-race', 'rec-race', 'Alice discussed TypeScript.', 'en'])

      // Hold BOTH extractions on one gate so both runs pass the
      // pre-extraction marker check before either can commit — the exact
      // race between debounced graph-sync and a manual graph:ingestAll.
      let release!: (v: string) => void
      const gate = new Promise<string>((r) => { release = r })
      ;(complete as any).mockImplementation(() => gate)

      const p1 = ingestFromDbTranscripts()
      const p2 = ingestFromDbTranscripts()
      // Let both runs reach the awaited extraction before releasing it.
      await new Promise((r) => setImmediate(r))
      release(FAKE_JSON)
      const [r1, r2] = await Promise.all([p1, p2])

      // Exactly one run ingests; the loser detects the committed marker
      // inside its transaction and skips cleanly — no error, no rollback.
      expect(r1.ingested + r2.ingested).toBe(1)
      expect(r1.skipped + r2.skipped).toBe(1)
      expect([...r1.errors, ...r2.errors]).toHaveLength(0)

      // Single ingest's worth of graph writes: no edge weight was
      // re-incremented by the losing run.
      const store = getKnowledgeGraphStore()
      const weights = store.db.queryAll<{ weight: number }>('SELECT weight FROM graph_edges')
      expect(weights.length).toBeGreaterThan(0)
      expect(Math.max(...weights.map((w) => w.weight))).toBe(1)
    })
  })

  // =========================================================================
  // ingestFromFolder()
  // =========================================================================
  describe('ingestFromFolder()', () => {
    it('ingests .txt and .md files, skips other extensions', async () => {
      const tempDir = join(tmpdir(), `hidock-kg-folder-${Date.now()}`)
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, 'meeting1.txt'), 'Alice discussed TypeScript.')
      writeFileSync(join(tempDir, 'notes.md'), 'Bob discussed Python.')
      writeFileSync(join(tempDir, 'config.json'), '{"ignored": true}')

      try {
        const result = await ingestFromFolder(tempDir)
        expect(result.ingested).toBe(2) // txt + md only
        expect(result.errors).toHaveLength(0)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('rejects path traversal (.. segments)', async () => {
      await expect(ingestFromFolder('/some/path/../../../etc')).rejects.toThrow('Path traversal not allowed')
    })

    it('rejects a path that does not exist', async () => {
      await expect(
        ingestFromFolder(join(tmpdir(), 'nonexistent-kg-folder-xyz-abc'))
      ).rejects.toThrow('does not exist')
    })
  })

  // =========================================================================
  // Query wrappers (run after seeding)
  // =========================================================================
  describe('query wrappers', () => {
    beforeEach(async () => {
      // Seed one transcript for all query tests
      dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)`,
        ['rec-q', 'query.hda', '2026-06-01'])
      dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`,
        ['tx-q', 'rec-q', 'Alice and Bob met to discuss Project Alpha.', 'en'])
      await ingestFromDbTranscripts()
    })

    it('queryStats returns node and edge counts > 0 after ingestion', () => {
      const stats = queryStats()
      expect(stats.nodes).toBeGreaterThan(0)
      expect(stats.edges).toBeGreaterThan(0)
      expect(stats.nodesByType).toHaveProperty('person')
    })

    it('queryListNodes returns all nodes; filtered by type returns correct subset', () => {
      const all = queryListNodes()
      const people = queryListNodes('person')
      expect(all.length).toBeGreaterThanOrEqual(people.length)
      expect(people.every((n) => n.type === 'person')).toBe(true)
    })

    it('queryTopAttendees returns ranked results for known project', () => {
      const results = queryTopAttendees('Project Alpha')
      expect(Array.isArray(results)).toBe(true)
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('person')
        expect(results[0]).toHaveProperty('meetings')
      }
    })

    it('queryTopSkill returns results for known skill', () => {
      const results = queryTopSkill('TypeScript')
      expect(Array.isArray(results)).toBe(true)
    })

    it('queryPersonProfile returns profile for known person', () => {
      const profile = queryPersonProfile('Alice')
      if (profile) {
        expect(profile.personLabel).toBe('Alice')
        expect(Array.isArray(profile.meetings)).toBe(true)
        expect(Array.isArray(profile.skills)).toBe(true)
        expect(Array.isArray(profile.actionItems)).toBe(true)
      }
    })

    it('queryMeetingGraph returns structure with nodes and edges arrays', () => {
      const graph = queryMeetingGraph('rec-q')
      expect(graph).toHaveProperty('nodes')
      expect(graph).toHaveProperty('edges')
      expect(Array.isArray(graph.nodes)).toBe(true)
      expect(Array.isArray(graph.edges)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Phase 2b: every extraction call leaves a ledger row
// ---------------------------------------------------------------------------

describe('graph extraction leaves a ledger row (phase 2b)', () => {
  let rows: CallRecord[]
  const graphRows = () => rows.filter((r) => r.step === 'graph-extract')

  beforeEach(() => {
    rows = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
  })

  afterEach(() => {
    setCallSink(null)
  })

  const seedTranscript = (recId: string, txId: string) => {
    dbRun(`INSERT OR IGNORE INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`, [recId, `${recId}.hda`, '2026-06-01', null])
    dbRun(`INSERT OR IGNORE INTO transcripts (id, recording_id, full_text, language) VALUES (?, ?, ?, ?)`, [txId, recId, 'Alice discussed TypeScript.', 'en'])
  }

  it('writes one completed row for each transcript sent to the model, naming its recording and the tokens reported', async () => {
    seedTranscript('rec-g1', 'tx-g1')
    seedTranscript('rec-g2', 'tx-g2')
    ;(complete as any).mockImplementation(async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-2.0-flash', inputTokens: 700, outputTokens: 90, durationMs: 400 })
      return FAKE_JSON
    })
    await ingestFromDbTranscripts()
    expect(graphRows()).toHaveLength(2)
    expect(graphRows().map((r) => r.recordingId).sort()).toEqual(['rec-g1', 'rec-g2'])
    expect(graphRows()[0]).toMatchObject({ route: 'direct:ai-sdk', provider: 'gemini-api', model: 'gemini-2.0-flash', status: 'completed' })
    expect(graphRows()[0].usage).toMatchObject({ calls: 1, tokens: { input: 700, output: 90 } })
  })

  it('writes a failed row for a transcript whose extraction throws, and the pass still records the error and goes on, as before', async () => {
    seedTranscript('rec-g3', 'tx-g3')
    ;(complete as any).mockRejectedValue(new Error('429 quota'))
    const result = await ingestFromDbTranscripts()
    expect(result.ingested).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(graphRows()).toHaveLength(1)
    expect(graphRows()[0]).toMatchObject({ status: 'failed', recordingId: 'rec-g3', errorMessage: expect.stringMatching(/429 quota/) })
  })

  it('writes no row for a transcript that was already ingested, because no call is made', async () => {
    seedTranscript('rec-g4', 'tx-g4')
    await ingestFromDbTranscripts()
    const callsAfterFirstPass = graphRows().length
    await ingestFromDbTranscripts()
    expect(graphRows()).toHaveLength(callsAfterFirstPass)
  })
})
