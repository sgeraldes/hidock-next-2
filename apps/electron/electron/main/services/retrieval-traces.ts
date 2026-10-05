import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import { mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import Database from 'better-sqlite3'
import { DatabaseEngine } from '@hidock/database'

export const RETRIEVAL_POLICY_VERSION = '1'
export type TraceChannel = 'vector' | 'pinned' | 'graph' | 'actionables' | 'digests' | 'explore' | 'brain-row'
export interface TraceCandidate {
  channel: TraceChannel
  source_kind: 'recording' | 'capture' | 'actionable' | 'meeting' | 'graph-node' | 'artifact'
  source_id: string
  recording_id?: string
  recording_ids?: string[]
  capture_id?: string
  chunk_index?: number
  content_hash?: string
  rank_before?: number | null
  rank_after?: number | null
  raw_score?: number | null
  adjusted_score?: number | null
  kept: boolean
  drop_reason?: 'threshold' | 'diversity-cap' | 'eligibility' | 'budget' | 'empty' | 'recheck'
  sent_to_model: boolean
}
export interface TraceEvent {
  trace_id: string
  parent_id?: string
  consumer: 'chat' | 'explore' | 'brain'
  client?: string
  session_ref?: string
  route: string
  args?: { id?: string; ids?: string[]; since?: string; limit?: number }
  started_at: string
  duration_ms: number
  status: 'ok' | 'empty' | 'error' | 'cancelled'
  error?: string
  app_version?: string
  intent?: string
  temporal_range?: { start: string; end: string } | null
  top_k?: number
  policy_version?: string
  embedding_provider?: string | null
  embedding_model?: string | null
  embedding_dimensions?: number | null
  retrieval_issue?: 'provider-failure' | 'reindex-pending' | null
  pipeline_call_id?: string
  answer_message_id?: string
  candidate_count?: number
  truncated?: boolean
  query?: string
  candidates: TraceCandidate[]
}
interface EncryptionStorage {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}
export interface TraceSettings { recordQueries: boolean; keepQueryText: boolean }
export interface TraceStats {
  pending_erase: boolean
  consumers: { chat: number; explore: number; brain: number }
  dropped_events: number
  write_errors: number
  file_bytes: number
}
export interface StoredTrace extends Omit<TraceEvent, 'query'> {
  query_text: string | null
  query_hmac: string
  text_state: 'encrypted' | 'disabled' | 'unavailable' | 'expired'
  candidate_count: number
  truncated: boolean
}
interface QueuedTrace { event: TraceEvent; normalized: string; queryHmac?: string; nonce: Buffer; tag: Buffer; candidateCount: number; truncated: boolean; textAllowed: boolean; epoch: number }
type QueueItem = QueuedTrace | { link: string; message: string; epoch: number }
// open() puts the file in auto_vacuum INCREMENTAL mode, so eviction returns freed
// pages to the OS without a full VACUUM, which rewrites the whole file
// synchronously on the main process (seconds at the 1 GiB cap).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS traces (
    trace_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, consumer TEXT NOT NULL,
    event TEXT NOT NULL, query_text TEXT, query_hmac TEXT NOT NULL, text_state TEXT NOT NULL,
    answer_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS traces_started ON traces(started_at);
  CREATE TABLE IF NOT EXISTS candidates (
    trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, candidate TEXT NOT NULL, PRIMARY KEY(trace_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS counters (day TEXT PRIMARY KEY, dropped INTEGER NOT NULL, errors INTEGER NOT NULL);
`
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}
function cappedText(text: string, bytes: number): string {
  let value = Buffer.from(text).subarray(0, bytes).toString('utf8')
  while (Buffer.byteLength(value) > bytes) value = value.slice(0, -1)
  return value
}

function candidateArgs(args: TraceEvent['args'], candidates: TraceCandidate[]): TraceEvent['args'] {
  if (!args) return undefined
  const ids = new Set(candidates.map(candidate => candidate.source_id))
  return { ...args, id: args.id && ids.has(args.id) ? args.id : undefined,
    ids: args.ids?.filter(id => ids.has(id)) }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/.test(
    `${(error as Error & { code?: string }).code} ${error.message}`)
}

/** Independent telemetry database; no business migrations, backups or attachment. */
export class RetrievalTraceStore {
  readonly path: string
  private engine: DatabaseEngine
  private opening?: Promise<void>
  private queue: QueueItem[] = []
  private captured: QueueItem[] = []
  private memoryKey = randomBytes(32)
  private epoch = 0
  private pendingLinks = new Map<string, string>()
  private settings: TraceSettings = { recordQueries: true, keepQueryText: true }
  private timer?: NodeJS.Timeout
  private batchTimer?: NodeJS.Timeout
  private dailyTimer?: NodeJS.Timeout
  private flushing?: Promise<void>
  private key = randomBytes(32)
  private keyReady = false
  private counters = new Map<string, { dropped: number; errors: number }>()
  private lastLog = -Infinity
  private retryAfter = 0
  private closed = false
  private pendingErase = false
  writeErrors = 0

  constructor(private readonly options: {
    path: string
    storage: EncryptionStorage
    eligible: (candidate: TraceCandidate) => boolean | Promise<boolean>
    maxFileBytes?: number
  }) {
    this.path = options.path
    this.engine = new DatabaseEngine({ betterSqlite3: Database, dbPathProvider: () => this.path,
      schemaVersion: 1, schema: SCHEMA, migrations: {}, vacuumAfterMigration: false, busyTimeoutMs: 50,
      repairPhase: () => this.engine.run('INSERT OR IGNORE INTO schema_version VALUES (1)') })
  }
  get pendingCount(): number { return this.queue.length }
  get pendingBytes(): number { return this.queue.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) }

  private async open(): Promise<void> {
    if (Date.now() < this.retryAfter) throw new Error('Trace storage retry delayed')
    if (!this.opening) {
      this.opening = (async () => {
        mkdirSync(dirname(this.path), { recursive: true })
        await this.engine.initialize()
        this.engine.getDatabase().run('PRAGMA busy_timeout = 50')
        // The engine touches the file before the schema runs, so the schema's
        // auto_vacuum line is too late. Switching an existing file needs one VACUUM;
        // do it only while the store is empty, where it costs nothing.
        if (Number(this.engine.getDatabase().exec('PRAGMA auto_vacuum')[0].values[0][0]) !== 2 &&
            this.engine.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM traces')!.count === 0) {
          this.engine.getDatabase().run('PRAGMA auto_vacuum = INCREMENTAL')
          this.engine.getDatabase().run('VACUUM')
        }
        this.engine.getDatabase().run('PRAGMA secure_delete = ON')
        this.engine.run("INSERT OR IGNORE INTO meta VALUES ('schema_version', '1')")
        if (this.options.storage.isEncryptionAvailable()) {
          const saved = this.engine.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = 'hmac_key'")
          if (saved) this.key = Buffer.from(this.options.storage.decryptString(Buffer.from(saved.value, 'base64')), 'base64')
          else {
            const encrypted = this.options.storage.encryptString(this.key.toString('base64')).toString('base64')
            this.engine.run("INSERT OR IGNORE INTO meta VALUES ('hmac_key', ?)", [encrypted])
            const winner = this.engine.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = 'hmac_key'")!
            this.key = Buffer.from(this.options.storage.decryptString(Buffer.from(winner.value, 'base64')), 'base64')
          }
          if (this.key.length !== 32) throw new Error('Invalid trace HMAC key')
        }
        this.keyReady = true
        this.pendingErase ||= this.engine.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = 'pending_erase'")?.value === '1'
        this.erasePendingText()
        this.retention()
        this.dailyTimer = setInterval(() => { void this.retain() }, 86400000)
        this.dailyTimer.unref()
      })().catch(error => { this.opening = undefined; this.retryAfter = isBusy(error) ? 0 : Date.now() + 60000; throw error })
    }
    await this.opening
  }

  record(event: TraceEvent): void {
    try {
      if (this.closed || !this.settings.recordQueries) return
      if (this.queue.length >= 1000) { this.count('dropped'); return }
      const { candidates, query, ...fields } = event
      const normalized = (query ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
      const queryHmac = this.keyReady ? createHmac('sha256', this.key).update(normalized).digest('hex') : undefined
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.memoryKey, nonce)
      const sealed = Buffer.concat([cipher.update(queryHmac ? '' : normalized, 'utf8'), cipher.final()])
      const copy: TraceEvent = { ...fields, query: this.settings.keepQueryText && query ? cappedText(query, 8192) : undefined, candidates: [] }
      const item: QueuedTrace = { event: copy, normalized: sealed.toString('base64'), queryHmac, nonce, tag: cipher.getAuthTag(),
        candidateCount: event.candidate_count ?? candidates.length, truncated: event.truncated ?? false, textAllowed: this.settings.keepQueryText, epoch: this.epoch }
      let bytes = Buffer.byteLength(JSON.stringify(item)) + 2048
      if (bytes > 65536) { this.count('dropped'); return }
      const channels = new Map<TraceChannel, number>()
      for (const candidate of candidates) {
        const count = channels.get(candidate.channel) ?? 0
        if (count >= 100) { item.truncated = true; continue }
        const size = Buffer.byteLength(JSON.stringify(candidate)) + 2
        if (bytes + size > 65536) { item.truncated = true; continue }
        copy.candidates.push({ rank_before: null, rank_after: null, raw_score: null, adjusted_score: null, ...candidate })
        channels.set(candidate.channel, count + 1)
        bytes += size
      }
      copy.args = candidateArgs(copy.args, copy.candidates)
      this.queue.push(item)
      this.schedule()
    } catch { this.count('dropped') }
  }

  linkAnswer(traceId: string, messageId: string): void {
    try {
      if (this.closed || !this.settings.recordQueries) return
      if (this.queue.length >= 1000) { this.count('dropped'); return }
      this.queue.push({ link: traceId, message: messageId, epoch: this.epoch })
      this.schedule()
    } catch { this.count('dropped') }
  }

  private schedule(mode: 'normal' | 'retry' | 'next' = 'normal'): void {
    if (this.closed) return
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 2000)
      this.timer.unref()
    }
    if (mode !== 'retry' && (mode === 'next' || this.queue.length >= 50) && !this.batchTimer) {
      this.batchTimer = setTimeout(() => { this.batchTimer = undefined; void this.flush() }, 0)
      this.batchTimer.unref()
    }
  }
  private count(kind: 'dropped' | 'errors', amount = 1): void {
    const day = new Date().toISOString().slice(0, 10)
    const counter = this.counters.get(day) ?? { dropped: 0, errors: 0 }
    counter[kind] += amount
    this.counters.set(day, counter)
  }
  private failed(): void {
    this.writeErrors++
    this.count('errors')
    if (Date.now() - this.lastLog >= 60000) {
      this.lastLog = Date.now()
      console.warn('[Retrieval traces] write failed; request unaffected')
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.timer) clearTimeout(this.timer)
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.timer = this.batchTimer = undefined
    const batch = this.queue.splice(0, 100)
    this.captured = batch
    let busy = false
    let committed = false
    this.flushing = (async () => {
      try {
        await this.open()
        this.erasePendingText()
        this.engine.runInTransaction(() => {
          for (const event of batch) {
            if (!this.settings.recordQueries || event.epoch !== this.epoch) continue
            if ('link' in event) {
              this.engine.run('UPDATE traces SET answer_message_id = ? WHERE trace_id = ?', [event.message, event.link])
              this.pendingLinks.set(event.link, event.message)
              if (this.pendingLinks.size > 1000) this.pendingLinks.delete(this.pendingLinks.keys().next().value!)
              continue
            }
            this.insert(event)
          }
          for (const [day, counts] of this.counters) {
            this.engine.run(`INSERT INTO counters VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET
              dropped = dropped + excluded.dropped, errors = errors + excluded.errors`, [day, counts.dropped, counts.errors])
          }
        })
        committed = true
        this.counters.clear()
        this.evict()
      } catch (error) {
        busy = isBusy(error)
        if (!committed && busy) {
          const restored = [...batch.filter(item => item.epoch === this.epoch && this.settings.recordQueries), ...this.queue]
          this.count('dropped', Math.max(0, restored.length - 1000))
          this.queue = restored.slice(0, 1000)
        } else if (!committed) this.count('dropped', batch.length)
        this.failed()
      }
    })().finally(() => {
      this.flushing = undefined; this.captured = []
      if (busy && this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = undefined }
      if (this.queue.length || this.pendingErase) this.schedule(busy || this.pendingErase ? 'retry' : 'next')
    })
    return this.flushing
  }
  private insert(item: QueuedTrace): void {
    const input = item.event
    const { query, candidates, ...fields } = input
    const decipher = createDecipheriv('aes-256-gcm', this.memoryKey, item.nonce)
    decipher.setAuthTag(item.tag)
    const normalized = Buffer.concat([decipher.update(Buffer.from(item.normalized, 'base64')), decipher.final()]).toString('utf8')
    const queryHmac = item.queryHmac ?? createHmac('sha256', this.key).update(normalized).digest('hex')
    let text: string | null = null
    let textState: StoredTrace['text_state'] = !this.pendingErase && this.settings.keepQueryText && item.textAllowed ? 'unavailable' : 'disabled'
    if (query && !this.pendingErase && item.textAllowed && this.settings.keepQueryText && this.options.storage.isEncryptionAvailable()) {
      text = this.options.storage.encryptString(query).toString('base64')
      textState = 'encrypted'
    }
    const stored: TraceCandidate[] = []
    const channels = new Map<TraceChannel, number>()
    const envelope = { ...fields, policy_version: fields.policy_version ?? RETRIEVAL_POLICY_VERSION,
      candidate_count: item.candidateCount, truncated: item.truncated }
    let bytes = Buffer.byteLength(JSON.stringify(envelope)) + Buffer.byteLength(text ?? '') + 512
    for (const candidate of candidates) {
      const count = channels.get(candidate.channel) ?? 0
      const size = Buffer.byteLength(JSON.stringify(candidate)) + 2
      if (count >= 100 || bytes + size > 65536) { envelope.truncated = true; continue }
      stored.push(candidate)
      channels.set(candidate.channel, count + 1)
      bytes += size
    }
    envelope.args = candidateArgs(envelope.args, stored)
    if (bytes > 65536) { this.count('dropped'); return }
    this.engine.run(`INSERT INTO traces (trace_id, started_at, consumer, event, query_text, query_hmac, text_state, answer_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [input.trace_id, input.started_at, input.consumer, JSON.stringify(envelope), text,
      queryHmac, textState, input.answer_message_id ?? this.pendingLinks.get(input.trace_id) ?? null])
    this.pendingLinks.delete(input.trace_id)
    stored.forEach((candidate, ordinal) => this.engine.run('INSERT INTO candidates VALUES (?, ?, ?)',
      [input.trace_id, ordinal, JSON.stringify(candidate)]))
  }
  private retention(): void {
    const now = Date.now()
    this.engine.runInTransaction(() => {
      this.engine.run("UPDATE traces SET query_text = NULL, text_state = 'expired' WHERE started_at < ?",
        [new Date(now - 30 * 86400000).toISOString()])
      this.engine.run('DELETE FROM traces WHERE started_at < ?', [new Date(now - 90 * 86400000).toISOString()])
    })
    this.evict()
  }
  async retain(): Promise<void> {
    try { await this.open(); this.retention() } catch { this.failed() }
  }
  private fileBytes(): number {
    return ['', '-wal', '-shm'].reduce((total, suffix) => {
      try { return total + statSync(this.path + suffix).size } catch { return total }
    }, 0)
  }
  /** Test seam: observes the maintenance statements eviction runs. */
  onStatement?: (sql: string) => void
  private checkpoint(): boolean {
    this.onStatement?.('PRAGMA wal_checkpoint(TRUNCATE)')
    const result = this.engine.getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return Number(result[0].values[0][0]) === 0
  }
  private reclaim(): void {
    this.onStatement?.('PRAGMA incremental_vacuum(2000)')
    this.engine.incrementalVacuum(2000)
  }
  private evict(): void {
    const cap = this.options.maxFileBytes ?? 1024 ** 3
    if (!this.checkpoint()) return
    const pragma = (name: string) => Number(this.engine.getDatabase().exec(`PRAGMA ${name}`)[0].values[0][0])
    const logicalBytes = () => (pragma('page_count') - pragma('freelist_count')) * pragma('page_size')
    for (let batch = 0; batch < 5 && logicalBytes() > cap; batch++) {
      const count = this.engine.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM traces')!.count
      const batchSize = Math.max(1, Math.min(1000, Math.ceil(count / 2)))
      const oldest = this.engine.queryAll<{ trace_id: string }>('SELECT trace_id FROM traces ORDER BY started_at LIMIT ?', [batchSize])
      if (!oldest.length) break
      this.engine.runInTransaction(() => {
        for (const row of oldest) this.engine.run('DELETE FROM traces WHERE trace_id = ?', [row.trace_id])
      })
      if (!this.checkpoint()) return
    }
    if (pragma('freelist_count') > 0) this.reclaim()
    this.checkpoint()
  }
  applySettings(settings: TraceSettings): void {
    if (!settings.keepQueryText && this.settings.keepQueryText) this.pendingErase = true
    if (!settings.recordQueries && this.settings.recordQueries) this.epoch++
    this.settings = { ...settings }
    if (!settings.recordQueries) { this.queue = []; this.pendingLinks.clear() }
    if (!settings.keepQueryText) for (const item of [...this.queue, ...this.captured]) {
      if ('event' in item) { item.event.query = undefined; item.textAllowed = false }
    }
  }
  async setSettings(settings: TraceSettings): Promise<void> {
    this.applySettings(settings)
    if (!settings.keepQueryText) {
      try {
        await this.open()
        this.erasePendingText()
      } catch { this.failed() }
      if (this.pendingErase) this.schedule('retry')
    }
  }
  private erasePendingText(): void {
    if (!this.pendingErase) return
    // The in-memory obligation survives even when the lock also prevents meta writes.
    try { this.engine.run("INSERT OR REPLACE INTO meta VALUES ('pending_erase', '1')") } catch { /* retry next flush */ }
    try {
      this.engine.runInTransaction(() => {
        this.engine.run("UPDATE traces SET query_text = NULL, text_state = 'disabled'")
        this.engine.run("DELETE FROM meta WHERE key = 'pending_erase'")
      })
      this.pendingErase = false
    } catch { this.failed() }
  }
  async read(): Promise<StoredTrace[]> {
    await this.open()
    const rows = this.engine.queryAll<{ event: string; query_text: string | null; query_hmac: string; text_state: StoredTrace['text_state']; answer_message_id: string }>(
      'SELECT * FROM traces ORDER BY rowid')
    const result: StoredTrace[] = []
    for (const row of rows) {
      const fields = JSON.parse(row.event) as Omit<StoredTrace, 'candidates'>
      const candidates = this.engine.queryAll<{ candidate: string }>('SELECT candidate FROM candidates WHERE trace_id = ? ORDER BY ordinal', [fields.trace_id])
        .map(c => JSON.parse(c.candidate) as TraceCandidate)
      // Aggregate traces are hidden if any identity is no longer eligible.
      if (!await this.candidatesEligible(candidates)) continue
      result.push({ ...fields, candidates, query_text: this.pendingErase ? null : row.query_text, query_hmac: row.query_hmac,
        text_state: this.pendingErase ? 'disabled' : row.text_state, answer_message_id: row.answer_message_id })
    }
    return result
  }
  async stats(): Promise<TraceStats> {
    await this.open()
    // Counts expose no content, so they skip the per-candidate eligibility check
    // that read() applies; that check is a query per candidate on the main process.
    const consumers = { chat: 0, explore: 0, brain: 0 }
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const rows = this.engine.queryAll<{ consumer: TraceEvent['consumer']; count: number }>(
      'SELECT consumer, COUNT(*) AS count FROM traces WHERE started_at >= ? GROUP BY consumer', [since])
    for (const row of rows) if (row.consumer in consumers) consumers[row.consumer] = row.count
    const counts = this.engine.queryOne<{ dropped: number; errors: number }>('SELECT COALESCE(SUM(dropped), 0) AS dropped, COALESCE(SUM(errors), 0) AS errors FROM counters')!
    for (const c of this.counters.values()) { counts.dropped += c.dropped; counts.errors += c.errors }
    return { consumers, dropped_events: counts.dropped, write_errors: counts.errors, file_bytes: this.fileBytes(), pending_erase: this.pendingErase }
  }
  private async candidatesEligible(candidates: TraceCandidate[]): Promise<boolean> {
    for (const candidate of candidates) {
      try { if (!await this.options.eligible(candidate)) return false } catch { return false }
    }
    return true
  }
  async schemaVersion(): Promise<number> { await this.open(); return Number(this.engine.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")!.value) }
  async autoVacuumMode(): Promise<number> { await this.open(); return Number(this.engine.getDatabase().exec('PRAGMA auto_vacuum')[0].values[0][0]) }
  async journalMode(): Promise<string> { await this.open(); return String(this.engine.getDatabase().exec('PRAGMA journal_mode')[0].values[0][0]) }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flushing
    do {
      const before = this.queue.length
      await this.flush()
      if (this.queue.length >= before) break // a busy writer will be retried by the next process
      if (this.queue.length) await new Promise<void>(resolve => setImmediate(resolve))
    } while (this.queue.length)
    if (this.dailyTimer) clearInterval(this.dailyTimer)
    try { this.engine.closeDatabase() } catch { /* an unsuccessful lazy open has no handle */ }
  }
}
