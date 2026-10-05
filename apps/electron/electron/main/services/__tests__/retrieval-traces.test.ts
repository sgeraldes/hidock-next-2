// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import Database from 'better-sqlite3'
import { DatabaseEngine } from '@hidock/database'
import { RetrievalTraceStore, contentHash, type TraceEvent } from '../retrieval-traces'

const directories: string[] = []
const stores: RetrievalTraceStore[] = []
const secret = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(Buffer.from(s).map((b, i) => b ^ secret[i % secret.length])),
  decryptString: (b: Buffer) => b.map((v, i) => v ^ secret[i % secret.length]).toString()
}
function store(options: Partial<ConstructorParameters<typeof RetrievalTraceStore>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hidock-traces-test-'))
  directories.push(directory)
  const s = new RetrievalTraceStore({ path: join(directory, 'retrieval-traces.db'), storage, eligible: () => true, ...options })
  stores.push(s)
  return s
}
function event(id = 't1', query = ' Question  ONE '): TraceEvent {
  return { trace_id: id, consumer: 'chat', route: 'generateAnswer', started_at: new Date().toISOString(), duration_ms: 12,
    status: 'ok', query, candidates: [{ channel: 'vector', source_kind: 'recording', source_id: 'r1', chunk_index: 0,
      content_hash: contentHash('chunk'), rank_before: 1, rank_after: 1, raw_score: 0.8, adjusted_score: 1,
      kept: true, sent_to_model: true }] }
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true })
  vi.useRealTimers()
})

describe('retrieval trace store (real SQLite)', () => {
  it('retries a pending erase on the timer even when no events are queued', async () => {
    vi.useFakeTimers()
    const s = store()
    s.record(event())
    await s.flush()
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      await s.setSettings({ recordQueries: true, keepQueryText: false })
      expect((await s.stats()).pending_erase).toBe(true)
      writer.exec('ROLLBACK')
      await vi.advanceTimersByTimeAsync(2000)
      expect((await s.stats()).pending_erase).toBe(false)
      expect((await s.read())[0].query_text).toBeNull()
    } finally { writer.close() }
  })
  it('masks text and retries pending erasure at flush after a busy writer releases', async () => {
    const s = store()
    s.record(event())
    await s.flush()
    const engine = (s as unknown as { engine: DatabaseEngine }).engine
    engine.getDatabase().run('PRAGMA busy_timeout = 50')
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      await s.setSettings({ recordQueries: true, keepQueryText: false })
      expect((await s.stats()).pending_erase).toBe(true)
      expect((await s.read())[0]).toMatchObject({ query_text: null, text_state: 'disabled' })
      await s.setSettings({ recordQueries: true, keepQueryText: true })
      expect((await s.read())[0].query_text).toBeNull()
      writer.exec('ROLLBACK')
      await s.flush()
      expect((await s.stats()).pending_erase).toBe(false)
      expect(writer.prepare('SELECT query_text, text_state FROM traces').get()).toEqual({ query_text: null, text_state: 'disabled' })
    } finally { writer.close() }
  })
  it('persists an erase obligation on UPDATE error and retries on reopen', async () => {
    const s = store()
    s.record(event())
    await s.flush()
    const engine = (s as unknown as { engine: DatabaseEngine }).engine
    const run = engine.run.bind(engine)
    const spy = vi.spyOn(engine, 'run').mockImplementation((sql, params) => {
      if (sql.startsWith('UPDATE traces SET query_text')) throw new Error('disk error')
      return run(sql, params)
    })
    await s.setSettings({ recordQueries: true, keepQueryText: false })
    expect((await s.stats()).pending_erase).toBe(true)
    const db = new Database(s.path, { readonly: true })
    try { expect(db.prepare("SELECT value FROM meta WHERE key = 'pending_erase'").get()).toEqual({ value: '1' }) }
    finally { db.close() }
    await s.close()
    spy.mockRestore()
    const reopened = store({ path: s.path })
    expect((await reopened.read())[0]).toMatchObject({ query_text: null, text_state: 'disabled' })
    expect((await reopened.stats()).pending_erase).toBe(false)
  })
  it('stops eviction for a pinned reader, bounds delete batches, and reclaims after release', async () => {
    const s = store({ maxFileBytes: 128 * 1024 })
    await s.schemaVersion()
    s.record(event('initial'))
    await s.flush()
    const reader = new Database(s.path)
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM traces').all()
    const engine = (s as unknown as { engine: DatabaseEngine }).engine
    engine.getDatabase().run('PRAGMA busy_timeout = 50')
    const transactions = vi.spyOn(engine, 'runInTransaction')
    try {
      for (let i = 0; i < 40; i++) s.record(event(String(i), randomBytes(3000).toString('hex')))
      await s.flush()
      expect(transactions.mock.calls.length).toBeLessThanOrEqual(6) // insert + at most five delete batches
      expect((await s.read()).length).toBeGreaterThan(0)
      reader.exec('ROLLBACK')
      for (let i = 0; i < 30; i++) await s.flush()
      expect((await s.stats()).file_bytes).toBeLessThanOrEqual(128 * 1024)
      expect((await s.read()).length).toBeGreaterThan(0)
    } finally { reader.close() }
  })
  it('keeps full HMAC identity for long queries without retaining their full text in an initialized queue', async () => {
    const s = store()
    await s.schemaVersion()
    const prefix = 'question '.repeat(20000)
    s.record(event('long-a', prefix + 'a'))
    s.record(event('long-b', prefix + 'b'))
    expect(s.pendingCount).toBe(2)
    expect(s.pendingBytes).toBeLessThan(2 * 65536)
    await s.flush()
    const rows = await s.read()
    expect(rows).toHaveLength(2)
    expect(rows[0].query_hmac).not.toBe(rows[1].query_hmac)
    expect(Buffer.byteLength(storage.decryptString(Buffer.from(rows[0].query_text!, 'base64')))).toBeLessThanOrEqual(8192)
  })
  it('HMACs the whole query, not just the retained prefix', async () => {
    const s = store()
    s.record(event('a', 'a'.repeat(9000) + 'one'))
    s.record(event('b', 'a'.repeat(9000) + 'two'))
    await s.flush()
    const rows = await s.read()
    expect(rows[0].query_hmac).not.toBe(rows[1].query_hmac)
  })
  it('never restores erased queued text after re-enabling retention', async () => {
    const s = store()
    s.record(event())
    await s.setSettings({ recordQueries: true, keepQueryText: false })
    await s.setSettings({ recordQueries: true, keepQueryText: true })
    await s.flush()
    expect((await s.read())[0].query_text).toBeNull()
  })
  it('cancels a captured flush batch when recording is disabled during open', async () => {
    const s = store()
    s.record(event())
    const flushing = s.flush()
    await s.setSettings({ recordQueries: false, keepQueryText: true })
    await flushing
    expect(await s.read()).toEqual([])
  })
  it('bounds queued candidate data before flushing', () => {
    const s = store()
    const e = event()
    e.candidates = Array.from({ length: 10000 }, () => e.candidates[0])
    s.record(e)
    expect(s.pendingBytes).toBeLessThanOrEqual(65536)
  })
  it('preserves an answer link that arrived before the event', async () => {
    const s = store()
    s.linkAnswer('t1', 'm1')
    s.record(event())
    await s.flush()
    expect((await s.read())[0].answer_message_id).toBe('m1')
  })
  it('creates an independent WAL schema, commits and reads identities without content', async () => {
    const s = store()
    s.record(event())
    await s.flush()
    const trace = (await s.read())[0]
    expect(trace.trace_id).toBe('t1')
    expect(trace.candidates[0]).toMatchObject({ source_id: 'r1', content_hash: contentHash('chunk'), sent_to_model: true })
    expect(trace.query_text).not.toBeNull()
    expect(JSON.stringify(trace)).not.toContain('Question')
    expect(await s.schemaVersion()).toBe(1)
    expect(await s.journalMode()).toBe('wal')
  })
  it('groups normalized questions using a persisted encrypted random HMAC key', async () => {
    const s = store()
    s.record(event('a'))
    s.record(event('b', 'question one'))
    s.record(event('c', 'different'))
    await s.flush()
    const rows = await s.read()
    expect(rows[0].query_hmac).toBe(rows[1].query_hmac)
    expect(rows[0].query_hmac).not.toBe(rows[2].query_hmac)
    await s.close()
    const reopened = store({ path: s.path })
    reopened.record(event('d'))
    await reopened.flush()
    expect((await reopened.read())[3].query_hmac).toBe(rows[0].query_hmac)
  })
  it('omits text when encryption is unavailable and respects the 8 KiB UTF-8 cap', async () => {
    const unavailable = store({ storage: { ...storage, isEncryptionAvailable: () => false } })
    unavailable.record(event())
    await unavailable.flush()
    expect((await unavailable.read())[0]).toMatchObject({ query_text: null, text_state: 'unavailable' })
    const s = store()
    s.record(event('long', 'é'.repeat(10000)))
    await s.flush()
    expect(Buffer.byteLength(storage.decryptString(Buffer.from((await s.read())[0].query_text!, 'base64')))).toBeLessThanOrEqual(8192)
  })
  it('caps each channel at 100 and the serialized event at 64 KiB', async () => {
    const s = store()
    const e = event()
    e.candidates = Array.from({ length: 160 }, (_, i) => ({ ...e.candidates[0], source_id: `r${i}` }))
    s.record(e)
    await s.flush()
    expect((await s.read())[0]).toMatchObject({ truncated: true, candidate_count: 160 })
    expect((await s.read())[0].candidates).toHaveLength(100)
    e.trace_id = 'large'
    e.candidates = Array.from({ length: 100 }, () => ({ ...e.candidates[0], source_id: 'r'.repeat(2000) }))
    s.record(e)
    await s.flush()
    const large = (await s.read())[1]
    expect(large.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(65536)
  })
  it('erases 30-day text, deletes 90-day traces and revalidates eligibility on read', async () => {
    const s = store({ eligible: c => c.source_id !== 'excluded' })
    for (const [id, days] of [['old', 91], ['text', 31], ['recent', 1]] as const) {
      const e = event(id)
      e.started_at = new Date(Date.now() - days * 86400000).toISOString()
      s.record(e)
    }
    const excluded = event('excluded')
    excluded.candidates[0].source_id = 'excluded'
    s.record(excluded)
    await s.flush()
    await s.retain()
    const rows = await s.read()
    expect(rows.map(r => r.trace_id)).toEqual(['text', 'recent'])
    expect(rows[0].query_text).toBeNull()
    expect(rows[0].query_hmac).toBeTruthy()
    // Counts carry no content: 'recent' and 'excluded' are both inside the last 7 days.
    expect((await s.stats()).consumers.chat).toBe(2)
  })
  it('erases stored and queued text when text retention is disabled; recording off drops everything', async () => {
    const s = store()
    s.record(event('stored'))
    await s.flush()
    s.record(event('queued'))
    await s.setSettings({ recordQueries: true, keepQueryText: false })
    await s.flush()
    expect((await s.read()).every(r => r.query_text === null)).toBe(true)
    await s.setSettings({ recordQueries: false, keepQueryText: false })
    s.record(event('disabled'))
    await s.flush()
    expect(await s.read()).toHaveLength(2)
  })
  it('evicts oldest traces to reclaim a bounded SQLite file', async () => {
    const s = store({ maxFileBytes: 128 * 1024 })
    for (let i = 0; i < 80; i++) {
      const e = event(String(i), randomBytes(3000).toString('hex'))
      e.started_at = new Date(Date.now() - (80 - i) * 1000).toISOString()
      s.record(e)
    }
    await s.flush()
    const rows = await s.read()
    expect(rows.length).toBeLessThan(80)
    expect(rows.at(-1)?.trace_id).toBe('79')
    expect((await s.stats()).file_bytes).toBeLessThanOrEqual(128 * 1024)
  })
  it('reclaims space with incremental vacuum, never a full VACUUM on the main process', async () => {
    const s = store({ maxFileBytes: 128 * 1024 })
    expect(await s.autoVacuumMode()).toBe(2) // INCREMENTAL
    const statements: string[] = []
    for (let i = 0; i < 80; i++) {
      const e = event(String(i), randomBytes(3000).toString('hex'))
      e.started_at = new Date(Date.now() - (80 - i) * 1000).toISOString()
      s.record(e)
    }
    s.onStatement = sql => statements.push(sql)
    await s.flush()
    expect(statements.some(sql => /^\s*VACUUM\b/i.test(sql))).toBe(false)
    expect(statements.some(sql => /incremental_vacuum/i.test(sql))).toBe(true)
    expect((await s.stats()).file_bytes).toBeLessThanOrEqual(128 * 1024)
  })
  it('counts traces for the stats line without revalidating every candidate', async () => {
    const eligible = vi.fn(() => true)
    const s = store({ eligible })
    s.record(event('a'))
    s.record({ ...event('b'), consumer: 'brain' })
    await s.flush()
    expect((await s.stats()).consumers).toEqual({ chat: 1, explore: 0, brain: 1 })
    expect(eligible).not.toHaveBeenCalled()
  })
  it('links an answer before or after its queued trace commits', async () => {
    const s = store()
    s.record(event())
    s.linkAnswer('t1', 'm1')
    await s.flush()
    expect((await s.read())[0].answer_message_id).toBe('m1')
    s.linkAnswer('t1', 'm2')
    await s.flush()
    expect((await s.read())[0].answer_message_id).toBe('m2')
  })
})

describe('bounded non-throwing queue', () => {
  it('drains all batches when close races an already captured flush', async () => {
    const s = store()
    for (let i = 0; i < 250; i++) s.record(event(String(i)))
    const flushing = s.flush()
    await s.close()
    await flushing
    const reopened = store({ path: s.path })
    expect(await reopened.read()).toHaveLength(250)
  })
  it('waits for the next timer after busy even if newer events scheduled an immediate batch', async () => {
    vi.useFakeTimers()
    const s = store()
    await s.schemaVersion()
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      s.record(event('first'))
      const flushing = s.flush()
      for (let i = 0; i < 50; i++) s.record(event(`later-${i}`))
      await flushing
      const errors = s.writeErrors
      await vi.advanceTimersByTimeAsync(0)
      expect(s.writeErrors).toBe(errors)
      writer.exec('ROLLBACK')
      await vi.advanceTimersByTimeAsync(2000)
      expect(await s.read()).toHaveLength(51)
    } finally { writer.close() }
  })
  it('also retries a busy lazy open quickly without dropping queued events', async () => {
    const initial = store()
    await initial.schemaVersion()
    await initial.close()
    const s = store({ path: initial.path })
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      s.record(event('cold-busy'))
      const started = performance.now()
      await s.flush()
      expect(performance.now() - started).toBeLessThan(500)
      expect(s.pendingCount).toBe(1)
      writer.exec('ROLLBACK')
      await s.flush()
      expect((await s.read())[0].trace_id).toBe('cold-busy')
    } finally { writer.close() }
  })
  it('requeues a busy batch before newer events and counts drops at the 1000 cap', async () => {
    const s = store()
    await s.schemaVersion()
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      for (let i = 0; i < 100; i++) s.record(event(`old-${i}`))
      const flushing = s.flush()
      for (let i = 0; i < 1000; i++) s.record(event(`new-${i}`))
      await flushing
      expect(s.pendingCount).toBe(1000)
      writer.exec('ROLLBACK')
      await s.flush()
      expect((await s.read()).map(row => row.trace_id)).toEqual(Array.from({ length: 100 }, (_, i) => `old-${i}`))
      expect((await s.stats()).dropped_events).toBe(100)
      await s.close()
      const reopened = store({ path: s.path })
      expect(await reopened.read()).toHaveLength(1000)
    } finally { writer.close() }
  })
  it('returns quickly under a writer lock, keeps the batch queued, and writes on a later flush', async () => {
    const s = store()
    await s.schemaVersion()
    const writer = new Database(s.path)
    writer.exec('BEGIN IMMEDIATE')
    try {
      s.record(event('busy'))
      const started = performance.now()
      await s.flush()
      expect(performance.now() - started).toBeLessThan(500)
      expect(s.pendingCount).toBe(1)
      expect(await s.read()).toHaveLength(0)
      writer.exec('ROLLBACK')
      await s.flush()
      expect(s.pendingCount).toBe(0)
      expect((await s.read())[0].trace_id).toBe('busy')
      expect((await s.stats()).dropped_events).toBe(0)
    } finally { writer.close() }
  })
  it('writes at most 100 events per transaction and schedules the remainder on the next tick', async () => {
    vi.useFakeTimers()
    const s = store()
    await s.schemaVersion()
    for (let i = 0; i < 250; i++) s.record(event(String(i)))
    await s.flush()
    expect(await s.read()).toHaveLength(100)
    expect(s.pendingCount).toBe(150)
    await vi.advanceTimersByTimeAsync(0)
    expect((await s.read()).length).toBeGreaterThan(100)
    await s.flush()
    expect(await s.read()).toHaveLength(250)
  })
  it('writes off the caller path in batches of 50 or after 2 seconds', async () => {
    vi.useFakeTimers()
    const s = store()
    s.record(event())
    expect(s.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(s.pendingCount).toBe(0)
    expect(await s.read()).toHaveLength(1)
    for (let i = 0; i < 50; i++) s.record(event(`b${i}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.pendingCount).toBe(0)
    expect(await s.read()).toHaveLength(51)
  })
  it('counts overflow and never throws when writing fails', async () => {
    const s = store()
    for (let i = 0; i < 1005; i++) expect(() => s.record(event(String(i)))).not.toThrow()
    expect(s.pendingCount).toBe(1000)
    await s.flush()
    expect((await s.stats()).dropped_events).toBe(5)
    const broken = store({ path: directories[0] })
    expect(() => broken.record(event())).not.toThrow()
    await expect(broken.flush()).resolves.toBeUndefined()
    expect(broken.writeErrors).toBeGreaterThan(0)
  })
})
