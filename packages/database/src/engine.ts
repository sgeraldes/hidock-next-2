/**
 * @hidock/database — reusable SQLite engine (better-sqlite3 + WAL).
 *
 * Encapsulates the generic database machinery shared across the HiDock Electron
 * apps: the SQLite connection lifecycle, a version-tracked idempotent migration
 * runner, the 4-phase boot sequence, and the query helpers. The per-app SCHEMA,
 * SCHEMA_VERSION, MIGRATIONS map, and structural-repair logic are supplied via
 * configuration — the engine itself is schema-agnostic.
 *
 * ── Storage: better-sqlite3 + WAL (journaled, incremental) ───────────────────
 * The engine previously used sql.js, which has no incremental writer: every
 * persist meant `db.export()` (a full in-memory copy of the ENTIRE database)
 * followed by writing that whole buffer to disk. For a large database (the P0
 * incident hit 2.0 GB) that model collapses — the export buffer allocation
 * fails against the wasm ~4 GB heap ceiling ("Array buffer allocation failed"),
 * multi-second synchronous exports freeze the main thread, and the deferred
 * async flush races open transactions ("cannot commit transaction - SQL
 * statements in progress", "database is locked").
 *
 * better-sqlite3 in WAL mode eliminates that entire class of failure:
 *   - Writes are incremental and journaled — no full-DB export, ever.
 *   - Transactions are synchronous — no async flush to collide with them.
 *   - The file stays a standard SQLite database (better-sqlite3 opens the old
 *     sql.js files directly — same on-disk format), so migration is a one-time
 *     `PRAGMA journal_mode=WAL` (+ optional VACUUM after a size-reducing
 *     migration). A timestamped SQLite online backup is taken before pending
 *     migrations, or deferred until post-paint on an ordinary schema-current
 *     boot via {@link DatabaseEngineConfig.backupOnBoot}.
 *
 * ── Source compatibility ─────────────────────────────────────────────────────
 * {@link DatabaseEngine.getDatabase} returns a sql.js-API-compatible facade over
 * the better-sqlite3 connection ({@link SqlJsCompatDatabaseApi}). Every consumer
 * that used the raw sql.js Database surface — `run`, `exec` (returning
 * `[{columns, values}]`), `prepare().bind()/step()/getAsObject()/get()/free()/
 * reset()`, `export()`, `getRowsModified()` — keeps working unchanged. The
 * engine's own helpers (queryAll/queryOne/run/runMany/runInTransaction) use
 * better-sqlite3 directly.
 *
 * 4-phase boot (identical semantics to the original implementation):
 *   1. Core Tables       — run every `CREATE TABLE` from the schema
 *   2. Structural Repair — app callback force-adds missing columns (idempotent)
 *   3. Migrations        — version-gated transforms via the migrations map
 *   4. Full Schema       — re-run all statements to apply indexes/constraints
 */

import { existsSync, linkSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, basename, join } from 'path'

/* -------------------------------------------------------------------------- */
/*  better-sqlite3 minimal structural types (kept independent of the exact    */
/*  @types/better-sqlite3 version the consumer resolves).                      */
/* -------------------------------------------------------------------------- */

/** A prepared statement as exposed by better-sqlite3 (subset used here). */
export interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  raw(toggle?: boolean): BetterSqlite3Statement
  pluck(toggle?: boolean): BetterSqlite3Statement
  columns(): Array<{ name: string; column: string | null; table: string | null; type: string | null }>
  readonly reader: boolean
  readonly busy: boolean
}

/** A better-sqlite3 Database (subset used here). */
export interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement
  exec(sql: string): BetterSqlite3Database
  pragma(source: string, options?: { simple?: boolean }): unknown
  serialize(): Buffer
  backup(
    destinationFile: string,
    options?: { progress?: (info: { totalPages: number; remainingPages: number }) => number }
  ): Promise<{ totalPages: number; remainingPages: number }>
  close(): void
  readonly open: boolean
  readonly inTransaction: boolean
  readonly name: string
}

/**
 * A complete backup made by something else, with the exact state of the source
 * file it copied: modification time in nanoseconds and size, recorded before
 * and after the copy and found unchanged, with an empty WAL. Equality with the
 * current file is the proof; no clock is compared, so neither a clock change nor
 * daylight saving can make an older copy look current.
 */
export interface ExternalBackup {
  path: string
  sourceMtimeNs: bigint
  sourceSize: number
}

/** What the engine reports while it opens the database, for a splash screen. */
export type BootProgress =
  | { phase: 'backup'; copiedBytes: number; totalBytes: number }
  | { phase: 'backup-reused'; path: string }
  | { phase: 'migrating'; fromVersion: number; toVersion: number }

/** The better-sqlite3 default export (the Database constructor). */
export type BetterSqlite3Constructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
) => BetterSqlite3Database

/* -------------------------------------------------------------------------- */
/*  sql.js-compatible facade types (the public getDatabase() surface).        */
/* -------------------------------------------------------------------------- */

/** One result group in the sql.js `exec()` return shape. */
export interface SqlJsExecResult {
  columns: string[]
  values: unknown[][]
}

/** The sql.js Statement surface consumers rely on. */
export interface SqlJsCompatStatementApi {
  bind(params?: unknown): boolean
  step(): boolean
  get(params?: unknown): unknown[]
  getAsObject(params?: unknown): Record<string, unknown>
  getColumnNames(): string[]
  reset(): void
  free(): boolean
  run(params?: unknown): void
}

/** The sql.js Database surface consumers rely on (returned by getDatabase()). */
export interface SqlJsCompatDatabaseApi {
  run(sql: string, params?: unknown): void
  exec(sql: string, params?: unknown): SqlJsExecResult[]
  prepare(sql: string, params?: unknown): SqlJsCompatStatementApi
  getRowsModified(): number
  export(): Uint8Array
  close(): void
}

/**
 * Back-compat alias. Consumers import `type SqlJsDatabase` and pass it around;
 * it now denotes the sql.js-compatible facade over better-sqlite3.
 */
export type SqlJsDatabase = SqlJsCompatDatabaseApi

/* -------------------------------------------------------------------------- */
/*  Errors + destructive-statement guarding (unchanged behavior).             */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by the mass-delete tripwire when a single DELETE/DROP would remove more
 * than {@link MASS_DELETE_FRACTION} of a protected table's rows (table must hold
 * more than {@link MASS_DELETE_MIN_ROWS}). Wrap the intentional bulk operation in
 * {@link DatabaseEngine.runWithMassDeleteAllowed} to bypass.
 */
export class MassDeleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MassDeleteError'
  }
}

/** A protected table is only guarded once it holds more than this many rows. */
const MASS_DELETE_MIN_ROWS = 20
/** Refuse a single statement that would remove more than this fraction of rows. */
const MASS_DELETE_FRACTION = 0.5

/** Parse a leading DELETE/DROP TABLE statement's target table (null otherwise). */
export function parseDestructiveStatement(sql: string): { kind: 'delete' | 'drop'; table: string } | null {
  const del = /^\s*DELETE\s+FROM\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i.exec(sql)
  if (del) return { kind: 'delete', table: del[1] }
  const drop = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i.exec(sql)
  if (drop) return { kind: 'drop', table: drop[1] }
  return null
}

/** Strip leading `--` comment lines so a statement's leading keyword can be read. */
export function stripLeadingSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim()
}

/**
 * Split a schema script into statements, ignoring semicolons that are not
 * statement terminators.
 *
 * A plain `.split(';')` was what this did, and on 2026-09-22 a semicolon
 * written inside a `--` comment in a CREATE TABLE cut that statement in two.
 * SQLite then reported a syntax error on the second half, the table was never
 * created, and the only trace was one warning line in a boot log full of them
 * — every later migration failed with "no such table". The cost is not the bug,
 * it is that the failure points nowhere near the cause.
 *
 * Semicolons inside line comments, block comments and quoted identifiers or
 * strings are therefore text, not terminators. Doubled quotes (SQLite's escape,
 * `'it''s'`) close and immediately reopen the literal, which lands on the same
 * answer without a special case.
 */
export function splitSqlStatements(schema: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote: string | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < schema.length; i++) {
    const ch = schema[i]
    const next = schema[i + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }

    if (ch === '-' && next === '-') {
      lineComment = true
      i++
    } else if (ch === '/' && next === '*') {
      blockComment = true
      i++
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === ';') {
      const statement = schema.slice(start, i).trim()
      if (statement.length > 0) statements.push(statement)
      start = i + 1
    }
  }

  const tail = schema.slice(start).trim()
  if (tail.length > 0) statements.push(tail)
  return statements
}

/* -------------------------------------------------------------------------- */
/*  Parameter normalization (sql.js accepted looser inputs than               */
/*  better-sqlite3; normalize so consumer call sites are unchanged).          */
/* -------------------------------------------------------------------------- */

/** A single bind value acceptable to better-sqlite3 after normalization. */
type BoundValue = number | string | bigint | Buffer | null

function normalizeValue(v: unknown): BoundValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  // Fall back to JSON for accidental objects/arrays (sql.js would have thrown
  // too; keep the failure local and legible rather than passing an opaque type).
  return JSON.stringify(v)
}

/**
 * Normalize the sql.js-style params argument into the variadic form
 * better-sqlite3 expects. Accepts: undefined, a positional array, or a named
 * object. Named-parameter object keys may carry a sql.js prefix (`$`, `:`, `@`),
 * which is stripped for better-sqlite3.
 */
function normalizeParams(params: unknown): BoundValue[] {
  if (params === undefined || params === null) return []
  if (Array.isArray(params)) return params.map(normalizeValue)
  if (typeof params === 'object' && !Buffer.isBuffer(params) && !(params instanceof Uint8Array)) {
    const out: Record<string, BoundValue> = {}
    for (const [k, val] of Object.entries(params as Record<string, unknown>)) {
      out[k.replace(/^[$:@]/, '')] = normalizeValue(val)
    }
    return [out as unknown as BoundValue]
  }
  return [normalizeValue(params)]
}

/** True when a prepare() failure is because the SQL holds multiple statements. */
function isMultiStatementError(e: unknown): boolean {
  const m = (e as Error)?.message ?? ''
  return /more than one statement|multiple statements/i.test(m)
}

/* -------------------------------------------------------------------------- */
/*  Statement facade: sql.js Statement API over a better-sqlite3 Statement.    */
/* -------------------------------------------------------------------------- */

class SqlJsCompatStatement implements SqlJsCompatStatementApi {
  private boundParams: BoundValue[] = []
  private rows: unknown[][] | null = null
  private cols: string[] | null = null
  private idx = 0
  private readonly reader: boolean

  constructor(
    private readonly stmt: BetterSqlite3Statement,
    private readonly onWrite: (changes: number) => void
  ) {
    this.reader = stmt.reader
  }

  bind(params?: unknown): boolean {
    this.boundParams = normalizeParams(params)
    this.rows = null
    this.cols = null
    this.idx = 0
    return true
  }

  private ensureExecuted(): void {
    if (this.rows !== null) return
    if (this.reader) {
      this.cols = this.stmt.columns().map((c) => c.name)
      this.rows = this.stmt.raw(true).all(...this.boundParams) as unknown[][]
    } else {
      const info = this.stmt.run(...this.boundParams)
      this.onWrite(info.changes)
      this.rows = []
      this.cols = []
    }
    this.idx = 0
  }

  step(): boolean {
    this.ensureExecuted()
    if (this.idx < (this.rows as unknown[][]).length) {
      this.idx++
      return true
    }
    return false
  }

  private currentRow(): unknown[] | undefined {
    if (this.rows === null) return undefined
    if (this.idx > 0 && this.idx <= this.rows.length) return this.rows[this.idx - 1]
    if (this.idx === 0 && this.rows.length > 0) return this.rows[0]
    return undefined
  }

  get(params?: unknown): unknown[] {
    if (params !== undefined) this.bind(params)
    this.ensureExecuted()
    return (this.currentRow() as unknown[]) ?? []
  }

  getAsObject(params?: unknown): Record<string, unknown> {
    if (params !== undefined) this.bind(params)
    this.ensureExecuted()
    const row = this.currentRow()
    const cols = this.cols ?? []
    const obj: Record<string, unknown> = {}
    if (row) for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
    return obj
  }

  getColumnNames(): string[] {
    if (this.cols === null && this.reader) this.cols = this.stmt.columns().map((c) => c.name)
    return this.cols ?? []
  }

  reset(): void {
    this.rows = null
    this.idx = 0
  }

  free(): boolean {
    this.rows = null
    this.cols = null
    this.idx = 0
    return true
  }

  run(params?: unknown): void {
    const p = params !== undefined ? normalizeParams(params) : this.boundParams
    const info = this.stmt.run(...p)
    this.onWrite(info.changes)
  }
}

/* -------------------------------------------------------------------------- */
/*  Database facade: sql.js Database API over a better-sqlite3 Database.        */
/* -------------------------------------------------------------------------- */

class SqlJsCompatDatabase implements SqlJsCompatDatabaseApi {
  constructor(
    private readonly bdb: BetterSqlite3Database,
    private readonly onWrite: (changes: number) => void,
    private readonly rowsModified: () => number
  ) {}

  run(sql: string, params?: unknown): void {
    const norm = normalizeParams(params)
    try {
      const info = this.bdb.prepare(sql).run(...norm)
      this.onWrite(info.changes)
    } catch (e) {
      if (norm.length === 0 && isMultiStatementError(e)) {
        this.bdb.exec(sql)
        this.onWrite(0)
        return
      }
      throw e
    }
  }

  exec(sql: string, params?: unknown): SqlJsExecResult[] {
    const norm = normalizeParams(params)
    let stmt: BetterSqlite3Statement
    try {
      stmt = this.bdb.prepare(sql)
    } catch (e) {
      if (norm.length === 0 && isMultiStatementError(e)) {
        this.bdb.exec(sql)
        this.onWrite(0)
        return []
      }
      throw e
    }
    if (stmt.reader) {
      const columns = stmt.columns().map((c) => c.name)
      const values = stmt.raw(true).all(...norm) as unknown[][]
      return values.length > 0 ? [{ columns, values }] : []
    }
    const info = stmt.run(...norm)
    this.onWrite(info.changes)
    return []
  }

  prepare(sql: string, params?: unknown): SqlJsCompatStatementApi {
    const stmt = new SqlJsCompatStatement(this.bdb.prepare(sql), this.onWrite)
    if (params !== undefined) stmt.bind(params)
    return stmt
  }

  getRowsModified(): number {
    return this.rowsModified()
  }

  export(): Uint8Array {
    try {
      this.bdb.pragma('wal_checkpoint(PASSIVE)')
    } catch {
      /* best-effort checkpoint before serialize */
    }
    return new Uint8Array(this.bdb.serialize())
  }

  close(): void {
    /* Lifecycle is owned by the engine; consumers closing the facade is a no-op. */
  }
}

/** Column names for a table (empty if the table does not exist). */
export function getTableColumns(database: SqlJsCompatDatabaseApi, tableName: string): string[] {
  const tableInfo = database.exec(`PRAGMA table_info(${tableName})`)
  if (tableInfo.length === 0 || !tableInfo[0].values) return []
  return tableInfo[0].values.map((row) => String(row[1]))
}

/* -------------------------------------------------------------------------- */
/*  Engine configuration.                                                      */
/* -------------------------------------------------------------------------- */

/** @deprecated retained only so old imports keep type-checking; unused. */
export interface AdaptiveFlushConfig {
  smallMb?: number
  largeMb?: number
  mediumIntervalMs?: number
  largeIntervalMs?: number
}

export interface DatabaseEngineConfig {
  /**
   * The better-sqlite3 default export (the Database constructor). Injected so
   * the consuming app owns the single native-module instance (and so it can be
   * rebuilt for Electron independently). Consumers pass `Database` from
   * `import Database from 'better-sqlite3'`.
   */
  betterSqlite3: BetterSqlite3Constructor
  /** @deprecated ignored — retained for source-compat with the sql.js engine. */
  initSqlJs?: unknown
  /** Returns the absolute path to the .sqlite file (resolved at init time). */
  dbPathProvider: () => string
  /** Target schema version the app expects. */
  schemaVersion: number
  /** Full DDL: CREATE TABLE … and CREATE INDEX … statements separated by `;`. */
  schema: string
  /** Version-keyed migration functions. Each is run once, in ascending order. */
  migrations: Record<number, () => void>
  /**
   * Phase-2 structural repair. Runs on every boot, after core tables and before
   * migrations. The app force-adds any columns the code requires (idempotent).
   */
  repairPhase?: () => void
  /**
   * Tables guarded by the mass-delete tripwire. A DELETE/DROP that would remove
   * >50% of one of these tables' rows (when it holds >20 rows) is refused with a
   * {@link MassDeleteError} unless wrapped in runWithMassDeleteAllowed().
   */
  protectedTables?: string[]
  /**
   * When set, creates a SQLite online backup at `<dbPath>.bak-<YYYY-MM-DD>` and
   * keeps the newest `keep` complete daily backups. Pending migrations await a
   * successful snapshot before schema mutation; routine snapshots may be
   * deferred by {@link deferBackupOnBoot}. Omit to disable.
   */
  backupOnBoot?: { keep: number }
  /**
   * Complete backups made by something else (the hourly backup task), newest
   * first. Before a migration the engine reuses the newest one when the
   * database has not changed since that backup started, instead of copying
   * the whole file again: on 24-sep that copy held the splash for 3.5 minutes
   * on a USB disk while an identical 1-hour-old backup sat next to it.
   */
  externalBackups?: () => Array<ExternalBackup>
  /**
   * When true, a routine daily backup runs asynchronously after schema setup so
   * a multi-gigabyte copy does not hold the application splash for minutes.
   * A boot with pending migrations still awaits the backup before any schema
   * mutation. Defaults to false for callers that require initialize() to imply
   * backup completion.
   */
  deferBackupOnBoot?: boolean
  /**
   * When true (default), the engine considers a VACUUM after any boot that
   * applied a new migration, to reclaim free pages left by a size-reducing
   * migration (e.g. the embeddings JSON→BLOB conversion). Set false to skip.
   */
  vacuumAfterMigration?: boolean
  /**
   * The post-migration VACUUM runs only when the free pages it would reclaim
   * reach this many bytes. VACUUM rewrites the whole file on the startup path:
   * on a 2.8 GB library it held the splash for 17 s to reclaim 0.9 MB after a
   * migration that only added columns. Default: the larger of 64 MiB and 5% of
   * the file. Set 0 to vacuum after every migration.
   */
  vacuumMinReclaimBytes?: number
  /** @deprecated no-op — better-sqlite3 writes incrementally (WAL). */
  saveDebounceMs?: number
  /** @deprecated no-op — better-sqlite3 writes incrementally (WAL). */
  saveMaxWaitMs?: number
  /** @deprecated no-op — the sql.js adaptive-flush policy no longer exists. */
  adaptiveFlush?: AdaptiveFlushConfig
}

const BYTES_PER_MB = 1024 * 1024

/** The database file as it was before this boot opened it. */
type BeforeOpen = { mtimeNs: bigint; size: number; walBytes: number }

/* -------------------------------------------------------------------------- */
/*  Engine.                                                                     */
/* -------------------------------------------------------------------------- */

export class DatabaseEngine {
  private bdb: BetterSqlite3Database | null = null
  private shim: SqlJsCompatDatabase | null = null
  private dbPath = ''
  private inTransaction = false
  private lastChanges = 0
  private appliedMigration = false
  /** What the last boot decided about the post-migration VACUUM (for logs and tests). */
  lastPostMigrationVacuum: { considered: boolean; ran: boolean; reclaimableBytes: number; thresholdBytes: number } = {
    considered: false,
    ran: false,
    reclaimableBytes: 0,
    thresholdBytes: 0,
  }
  private checkpointCount = 0
  private deferredBackupPending = false

  private readonly protectedTables: Set<string>
  private massDeleteAllowed = false

  constructor(private readonly config: DatabaseEngineConfig) {
    this.protectedTables = new Set((config.protectedTables ?? []).map((t) => t.toLowerCase()))
  }

  /** Record the rows-changed count of the most recent write (sql.js parity). */
  private recordChanges = (changes: number): void => {
    this.lastChanges = changes
  }

  /* --- Backup + destructive guard (unchanged semantics) ------------------- */

  /**
   * The newest external backup that holds exactly what the database holds:
   * it started after the main file was last written, and the WAL is empty (a
   * non-empty WAL means commits the main file does not show yet). Measured
   * before this boot opened the file, so the open itself cannot count as a change.
   */
  private reusableExternalBackup(before: BeforeOpen | null): string | null {
    if (!before || before.walBytes > 0 || !this.config.externalBackups) return null
    let candidates: ExternalBackup[]
    try {
      candidates = this.config.externalBackups()
    } catch {
      return null
    }
    for (const c of candidates) {
      if (c.sourceMtimeNs !== before.mtimeNs || c.sourceSize !== before.size) continue
      // The copy itself must be whole: a truncated file is never the snapshot.
      if (!existsSync(c.path) || this.fileSize(c.path) !== before.size) continue
      return c.path
    }
    return null
  }

  private async backupOnBoot(
    failClosed = false,
    onProgress?: (p: BootProgress) => void,
    before: BeforeOpen | null = null
  ): Promise<void> {
    const cfg = this.config.backupOnBoot
    if (!cfg || cfg.keep <= 0) return
    try {
      if (!existsSync(this.dbPath)) return
      const dir = dirname(this.dbPath)
      const base = basename(this.dbPath)
      const prefix = `${base}.bak-`
      const day = new Date().toISOString().slice(0, 10)
      const bak = join(dir, `${prefix}${day}`)
      let reused = false
      const reusable = !existsSync(bak) && failClosed ? this.reusableExternalBackup(before) : null
      if (reusable) {
        // A hard link gives the dated name without copying a byte, and it keeps
        // the snapshot alive when the hourly rotation deletes its own name. A
        // disk without hard links (exFAT) gets the full copy below instead:
        // the snapshot must not depend on a file another program rotates.
        try {
          linkSync(reusable, bak)
          reused = true
          onProgress?.({ phase: 'backup-reused', path: reusable })
          console.log(`[Database] Pre-migration backup: linked ${reusable} (identical to the database)`)
        } catch (e) {
          console.warn(`[Database] Could not link ${reusable} (${(e as Error).message}); copying instead`)
        }
      }
      if (!reused && !existsSync(bak)) {
        // SQLite's online backup API runs incrementally without blocking the
        // Node event loop and includes committed WAL pages. A raw copyFileSync
        // of the 2.79 GB main file blocked Electron startup for ~153 seconds and
        // could omit WAL state.
        const partial = `${bak}.partial`
        rmSync(partial, { force: true })
        const source = new this.config.betterSqlite3(this.dbPath, { readonly: true, fileMustExist: true })
        try {
          const pageSize = Number(source.pragma('page_size', { simple: true })) || 4096
          let lastReport = 0
          await source.backup(partial, {
            progress: ({ totalPages, remainingPages }) => {
              const now = Date.now()
              if (onProgress && (now - lastReport > 250 || remainingPages === 0)) {
                lastReport = now
                onProgress({
                  phase: 'backup',
                  copiedBytes: (totalPages - remainingPages) * pageSize,
                  totalBytes: totalPages * pageSize,
                })
              }
              // Pages per step: 8 MB at 4 KB pages. The default (100) spends
              // most of a multi-gigabyte copy on per-step overhead.
              return 2048
            },
          })
          // SQLite does not call back after the last step: report the finish.
          if (onProgress) {
            const total = statSync(partial).size
            onProgress({ phase: 'backup', copiedBytes: total, totalBytes: total })
          }
        } finally {
          source.close()
        }
        // Only the final dated name denotes a complete backup. A crash leaves a
        // .partial file that the next boot removes and retries instead of
        // accepting a permanently truncated snapshot.
        renameSync(partial, bak)
        console.log(`[Database] Boot backup written: ${bak}`)
      }
      const directoryEntries = readdirSync(dir)
      for (const stalePartial of directoryEntries.filter(
        (file) => file.startsWith(prefix) && file.endsWith('.partial')
      )) {
        try {
          rmSync(join(dir, stalePartial), { force: true })
        } catch {
          /* best-effort partial cleanup */
        }
      }
      const existing = directoryEntries
        .filter((file) => file.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(file.slice(prefix.length)))
        .sort()
      for (const stale of existing.slice(0, Math.max(0, existing.length - cfg.keep))) {
        try {
          rmSync(join(dir, stale), { force: true })
        } catch {
          /* best-effort prune */
        }
      }
    } catch (e) {
      console.warn(
        failClosed ? '[Database] Required pre-migration backup failed:' : '[Database] Boot backup failed (non-fatal):',
        (e as Error).message
      )
      if (failClosed) throw e
    }
  }

  /** Run the routine backup explicitly from an application's post-paint scheduler. */
  async runDeferredBackup(): Promise<void> {
    if (!this.deferredBackupPending) return
    this.deferredBackupPending = false
    await this.backupOnBoot(false)
  }

  runWithMassDeleteAllowed<T>(fn: () => T): T {
    const prev = this.massDeleteAllowed
    this.massDeleteAllowed = true
    try {
      return fn()
    } finally {
      this.massDeleteAllowed = prev
    }
  }

  private guardDestructive(sql: string, params: unknown[]): void {
    if (this.massDeleteAllowed || this.protectedTables.size === 0) return
    const parsed = parseDestructiveStatement(sql)
    if (!parsed || !this.protectedTables.has(parsed.table.toLowerCase())) return

    const bdb = this.getBdb()
    const countRows = (countSql: string, countParams: BoundValue[] = []): number => {
      try {
        const row = bdb.prepare(countSql).get(...countParams) as { c?: number } | undefined
        return Number(row?.c ?? 0)
      } catch {
        return -1
      }
    }

    const total = countRows(`SELECT COUNT(*) AS c FROM ${parsed.table}`)
    if (total < 0) return // table unreadable/absent — let the statement surface the error
    if (total <= MASS_DELETE_MIN_ROWS) return

    let would = total
    if (parsed.kind === 'delete') {
      const countSql = sql.replace(
        /^\s*DELETE\s+FROM\s+["'`[]?[A-Za-z_][A-Za-z0-9_]*["'`\]]?/i,
        `SELECT COUNT(*) AS c FROM ${parsed.table}`
      )
      const measured = countRows(countSql, normalizeParams(params))
      would = measured < 0 ? total : measured
    }

    if (would > total * MASS_DELETE_FRACTION) {
      const pct = Math.round(MASS_DELETE_FRACTION * 100)
      const msg =
        `[Database] MASS-DELETE TRIPWIRE: refused ${parsed.kind.toUpperCase()} on protected table ` +
        `"${parsed.table}" — would remove ${would}/${total} rows (>${pct}%). ` +
        `Wrap the intended bulk operation in runWithMassDeleteAllowed() to override.`
      console.error(msg)
      console.error(new Error('mass-delete tripwire — call site').stack)
      throw new MassDeleteError(msg)
    }
  }

  /* --- Initialization / 4-phase boot -------------------------------------- */

  /**
   * Open an existing database for reading only, without touching it.
   *
   * For a second process that answers questions about the data while the app
   * that owns it may be running too — the headless brain service. SQLite in WAL
   * mode lets any number of readers work alongside one writer, but only if the
   * reader never tries to write, and the ordinary {@link initialize} writes a
   * great deal: it switches the journal mode, takes a backup, creates tables,
   * repairs columns and runs migrations. None of that is the reader's business.
   *
   * So this opens with `readonly` and `fileMustExist`, sets only per-connection
   * settings, and refuses outright when the file is on an older schema than
   * this code expects: the queries name columns a migration adds, and a reader
   * cannot run the migration. Open the app once to upgrade the file.
   */
  initializeReadOnly(): void {
    if (this.bdb) this.closeDatabase()
    this.appliedMigration = false
    this.lastPostMigrationVacuum = { considered: false, ran: false, reclaimableBytes: 0, thresholdBytes: 0 }
    this.deferredBackupPending = false
    this.dbPath = this.config.dbPathProvider()

    const Ctor = this.config.betterSqlite3
    if (typeof Ctor !== 'function') {
      throw new Error(
        'DatabaseEngineConfig.betterSqlite3 is required (pass the default export of better-sqlite3).'
      )
    }
    if (!existsSync(this.dbPath)) {
      throw new Error(`No database at ${this.dbPath}. Open the app once to create it.`)
    }

    const bdb = new Ctor(this.dbPath, { readonly: true, fileMustExist: true })
    try {
      // Connection settings only. journal_mode is a property of the file and a
      // read-only connection must not try to change it.
      bdb.pragma('busy_timeout = 5000')
      bdb.pragma('foreign_keys = ON')
      this.bdb = bdb
      const onDisk = this.readSchemaVersion()
      if (onDisk < this.config.schemaVersion) {
        throw new Error(
          `The database is on schema v${onDisk} and this code needs v${this.config.schemaVersion}. ` +
            'Open the app once so it can upgrade the file; a read-only reader cannot.'
        )
      }
      this.shim = new SqlJsCompatDatabase(this.bdb, this.recordChanges, () => this.lastChanges)
    } catch (error) {
      this.bdb = null
      this.shim = null
      bdb.close()
      throw error
    }
  }

  async initialize(options: { onProgress?: (p: BootProgress) => void } = {}): Promise<void> {
    // Re-initialization: release any previous connection before opening a new
    // one — better-sqlite3 handles are never GC-closed, so overwriting this.bdb
    // below would strand the old native file handle (open until process exit,
    // which on Windows also keeps the old .sqlite file undeletable).
    if (this.bdb) this.closeDatabase()
    // Per-boot flag (drives the one-time post-migration VACUUM); must not leak
    // a previous boot's value into this one.
    this.appliedMigration = false
    this.lastPostMigrationVacuum = { considered: false, ran: false, reclaimableBytes: 0, thresholdBytes: 0 }
    this.deferredBackupPending = false

    this.dbPath = this.config.dbPathProvider()

    const hadExistingFile = existsSync(this.dbPath)
    const sizeBefore = hadExistingFile ? this.fileSize(this.dbPath) : 0
    // Before opening: the open itself writes the -shm and may touch the WAL.
    let beforeOpen: BeforeOpen | null = null
    if (hadExistingFile) {
      try {
        const walPath = `${this.dbPath}-wal`
        const st = statSync(this.dbPath, { bigint: true })
        beforeOpen = {
          mtimeNs: st.mtimeNs,
          size: Number(st.size),
          walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
        }
      } catch {
        beforeOpen = null
      }
    }

    try {
      const Ctor = this.config.betterSqlite3
      if (typeof Ctor !== 'function') {
        throw new Error(
          'DatabaseEngineConfig.betterSqlite3 is required (pass the default export of better-sqlite3).'
        )
      }
      this.bdb = new Ctor(this.dbPath)
      // One-time conversion from a legacy sql.js (rollback-journal) file is just
      // switching the journaling mode — the on-disk format is identical.
      this.bdb.pragma('journal_mode = WAL')
      this.bdb.pragma('synchronous = NORMAL')
      this.bdb.pragma('busy_timeout = 5000')
      // Foreign keys, stated rather than inherited.
      //
      // This comment used to say enforcement was deliberately left OFF to match
      // the previous sql.js engine. That stopped being true without anyone
      // changing a line: the better-sqlite3 this app installs is built with
      // SQLITE_DEFAULT_FOREIGN_KEYS, so the default here is already ON and the
      // cascades have been live all along. Measured, not assumed:
      // `pragma('foreign_keys')` reads 1 on a fresh connection and
      // `compile_options` lists DEFAULT_FOREIGN_KEYS.
      //
      // Setting it explicitly changes nothing today and stops the app's
      // behaviour from depending on how a native module happened to be
      // compiled. A rebuild without that flag would otherwise have silently
      // turned every ON DELETE CASCADE in this schema into a no-op.
      this.bdb.pragma('foreign_keys = ON')

      this.shim = new SqlJsCompatDatabase(this.bdb, this.recordChanges, () => this.lastChanges)

      // Preserve the pre-migration safety contract, but do not make every
      // ordinary boot wait for a multi-gigabyte daily snapshot. If migrations
      // are pending, the online backup is awaited before phase 1/repair. When
      // schema is current, Electron may opt into a deferred best-effort backup.
      const versionBeforeBoot = hadExistingFile ? this.readSchemaVersion() : this.config.schemaVersion
      const migrationPending = hadExistingFile && versionBeforeBoot < this.config.schemaVersion
      const deferRoutineBackup = this.config.deferBackupOnBoot === true && !migrationPending
      if (hadExistingFile && !deferRoutineBackup) {
        await this.backupOnBoot(migrationPending, options.onProgress, beforeOpen)
      }
      if (migrationPending) {
        options.onProgress?.({ phase: 'migrating', fromVersion: versionBeforeBoot, toVersion: this.config.schemaVersion })
      }

      const statements = splitSqlStatements(this.config.schema)

      // --- PHASE 1: CORE TABLES ---
      console.log('[Database] Phase 1: Ensuring core tables exist...')
      for (const sql of statements) {
        if (stripLeadingSqlComments(sql).toUpperCase().startsWith('CREATE TABLE')) {
          try {
            this.bdb.exec(sql)
          } catch (e) {
            console.warn(`[Database] Table creation warning: ${(e as Error).message}`)
          }
        }
      }

      // --- PHASE 2: MANDATORY STRUCTURAL REPAIR ---
      if (this.config.repairPhase) {
        console.log('[Database] Phase 2: Aligning table structures...')
        this.config.repairPhase()
      }

      // --- PHASE 3: VERSIONED MIGRATIONS ---
      const currentVersion = this.readSchemaVersion()
      if (currentVersion < this.config.schemaVersion) {
        console.log(`[Database] Phase 3: Migrating v${currentVersion} -> v${this.config.schemaVersion}`)
        this.runMigrations(currentVersion)
      } else if (currentVersion === 0) {
        this.bdb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(this.config.schemaVersion)
      }

      // --- PHASE 4: FULL SCHEMA (INDEXES & CONSTRAINTS) ---
      console.log('[Database] Phase 4: Finalizing schema and indexes...')
      for (const sql of statements) {
        try {
          this.bdb.exec(sql)
        } catch (e) {
          const msg = (e as Error).message
          if (!msg.includes('already exists') && !msg.includes('duplicate column name')) {
            console.warn(`[Database] Schema statement warning: ${msg}`)
          }
        }
      }

      // One-time space reclamation after a size-reducing migration (VACUUM must
      // run outside any transaction). Reports before/after size.
      if (this.appliedMigration && this.config.vacuumAfterMigration !== false && this.worthVacuuming(sizeBefore)) {
        this.lastPostMigrationVacuum.ran = this.vacuum(sizeBefore)
      } else {
        this.checkpoint()
      }

      if (hadExistingFile && deferRoutineBackup) {
        this.deferredBackupPending = true
      }

      console.log(`[Database] Initialization complete (schema v${this.config.schemaVersion})`)
    } catch (error) {
      console.error('[Database] FATAL initialization error:', error)
      throw error
    }
  }

  /**
   * Whether a post-migration VACUUM would reclaim enough to be worth rewriting
   * the file on the startup path. Records the decision either way.
   */
  private worthVacuuming(fileSize: number): boolean {
    const bdb = this.getBdb()
    const threshold = this.config.vacuumMinReclaimBytes ?? Math.max(64 * 1024 * 1024, Math.floor(fileSize * 0.05))
    let reclaimable: number
    try {
      const freePages = Number(bdb.pragma('freelist_count', { simple: true }))
      const pageSize = Number(bdb.pragma('page_size', { simple: true }))
      reclaimable = freePages * pageSize
    } catch (e) {
      // Unknown is not "nothing to reclaim": keep the old behaviour and vacuum.
      console.warn(
        '[Database] Could not measure free pages after migration; vacuuming as before:',
        (e as Error).message
      )
      this.lastPostMigrationVacuum = { considered: true, ran: false, reclaimableBytes: -1, thresholdBytes: threshold }
      return true
    }
    this.lastPostMigrationVacuum = { considered: true, ran: false, reclaimableBytes: reclaimable, thresholdBytes: threshold }
    const worth = reclaimable >= threshold
    if (!worth) {
      console.log(
        `[Database] VACUUM skipped after migration: ${(reclaimable / BYTES_PER_MB).toFixed(1)}MB reclaimable, ` +
          `below ${(threshold / BYTES_PER_MB).toFixed(1)}MB`
      )
    }
    return worth
  }

  private fileSize(p: string): number {
    try {
      return existsSync(p) ? statSync(p).size : 0
    } catch {
      return 0
    }
  }

  private readSchemaVersion(): number {
    try {
      const row = this.getBdb()
        .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
        .get() as { version?: number } | undefined
      return row?.version ?? 0
    } catch {
      return 0
    }
  }

  private runMigrations(currentVersion: number): void {
    const bdb = this.getBdb()
    for (let v = currentVersion + 1; v <= this.config.schemaVersion; v++) {
      const migration = this.config.migrations[v]
      if (migration) {
        console.log(`Running migration to v${v}...`)
        migration()
        this.appliedMigration = true
      }
      bdb.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v)
    }
  }

  /**
   * Run VACUUM to reclaim free pages; logs before/after on-disk size. Returns
   * whether it completed: a failure is logged and not fatal.
   */
  vacuum(sizeBefore = this.fileSize(this.dbPath)): boolean {
    const bdb = this.getBdb()
    const t0 = Date.now()
    try {
      bdb.pragma('wal_checkpoint(TRUNCATE)')
      bdb.exec('VACUUM')
      bdb.pragma('wal_checkpoint(TRUNCATE)')
      const after = this.fileSize(this.dbPath)
      const fmt = (n: number) => `${(n / BYTES_PER_MB).toFixed(1)}MB`
      console.log(
        `[Database] VACUUM complete in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
          `${fmt(sizeBefore)} -> ${fmt(after)}`
      )
      return true
    } catch (e) {
      console.warn('[Database] VACUUM failed (non-fatal):', (e as Error).message)
      return false
    }
  }

  /* --- Persistence (WAL — no export/flush model) -------------------------- */

  /** Checkpoint the WAL into the main database file (best-effort). */
  private checkpoint(): void {
    try {
      this.getBdb().pragma('wal_checkpoint(PASSIVE)')
      this.checkpointCount++
    } catch {
      /* best-effort */
    }
  }

  /**
   * Durability is automatic under WAL (every write is journaled synchronously).
   * saveDatabase()/flushNow() remain for API compatibility and simply checkpoint
   * the WAL — there is no full-DB export to perform.
   */
  saveDatabase(): void {
    this.checkpoint()
  }

  flushNow(): void {
    this.checkpoint()
  }

  getDatabase(): SqlJsCompatDatabaseApi {
    if (!this.shim) throw new Error('Database not initialized')
    return this.shim
  }

  private getBdb(): BetterSqlite3Database {
    if (!this.bdb) throw new Error('Database not initialized')
    return this.bdb
  }

  closeDatabase(): void {
    if (this.bdb) {
      try {
        this.bdb.pragma('wal_checkpoint(TRUNCATE)')
      } catch {
        /* best-effort */
      }
      this.bdb.close()
      this.bdb = null
      this.shim = null
    }
  }

  /* --- Generic query helpers (better-sqlite3 directly) -------------------- */

  queryAll<T>(sql: string, params: unknown[] = []): T[] {
    return this.getBdb().prepare(sql).all(...normalizeParams(params)) as T[]
  }

  queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.getBdb().prepare(sql).get(...normalizeParams(params)) as T | undefined
  }

  private execWrite(sql: string, params: unknown[]): void {
    const norm = normalizeParams(params)
    try {
      const info = this.getBdb().prepare(sql).run(...norm)
      this.lastChanges = info.changes
    } catch (e) {
      if (norm.length === 0 && isMultiStatementError(e)) {
        this.getBdb().exec(sql)
        this.lastChanges = 0
        return
      }
      throw e
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.guardDestructive(sql, params)
    this.execWrite(sql, params)
  }

  /** run() variant kept for API parity; identical under WAL (no deferred save). */
  runNoSave(sql: string, params: unknown[] = []): void {
    this.guardDestructive(sql, params)
    this.execWrite(sql, params)
  }

  runInTransaction<T>(fn: () => T): T {
    const bdb = this.getBdb()
    if (this.inTransaction) {
      return fn()
    }
    this.inTransaction = true
    bdb.exec('BEGIN')
    try {
      const result = fn()
      bdb.exec('COMMIT')
      return result
    } catch (error) {
      try {
        bdb.exec('ROLLBACK')
      } catch {
        /* no active transaction to roll back */
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  runMany(sql: string, items: unknown[][]): void {
    const stmt = this.getBdb().prepare(sql)
    for (const item of items) {
      const info = stmt.run(...normalizeParams(item))
      this.lastChanges = info.changes
    }
  }

  /** Rows modified by the most recent write (sql.js `getRowsModified` parity). */
  getRowsModified(): number {
    return this.lastChanges
  }

  /** Test/diagnostic: number of WAL checkpoints performed so far. */
  getPhysicalSaveCount(): number {
    return this.checkpointCount
  }
}
