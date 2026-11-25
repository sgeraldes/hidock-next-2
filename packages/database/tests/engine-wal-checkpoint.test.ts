// @vitest-environment node

/**
 * WAL checkpoints off the caller's thread (config.walCheckpointer).
 *
 * On the owner's PC one checkpoint took 46 to 720 ms, and SQLite's automatic
 * checkpoint ran it inside a COMMIT on Electron's main thread. With a worker
 * checkpointer the worker copies and syncs the WAL, the app connection's
 * automatic checkpoint is only the backstop, SQLite's default comes back if
 * the worker dies, and nothing committed is lost either way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import {
  DatabaseEngine,
  createWorkerThreadWalCheckpointer,
  type WalCheckpointer,
  type WalCheckpointerEvents,
  type WalCheckpointerFactory,
  type WalCheckpointResult,
  type WalCheckpointTuning,
} from '../src/index.js'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const WORKER = fixture('wal-checkpoint-worker.mjs')
const DYING_WORKER = fixture('wal-checkpoint-worker-dies.mjs')
const CRASH_WRITER = fixture('wal-crash-writer.mjs')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, batch INTEGER NOT NULL, body TEXT);
`
const BODY = 'x'.repeat(4000)

const dirs: string[] = []
const engines: DatabaseEngine[] = []

function tempDir(name: string): string {
  const dir = join(tmpdir(), `hidock-wal-checkpoint-${name}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

function dbIn(name: string): string {
  const dir = tempDir(name)
  return join(dir, 'library.sqlite')
}

afterEach(() => {
  for (const engine of engines) {
    try { engine.closeDatabase() } catch { /* already closed */ }
  }
  engines.length = 0
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function workerFactory(
  workerPath: string,
  tuning: WalCheckpointTuning,
  seen: WalCheckpointResult[] = [],
  warnings: string[] = []
): WalCheckpointerFactory {
  return (dbPath, events) => createWorkerThreadWalCheckpointer({
    workerPath,
    dbPath,
    tuning,
    warn: (message) => warnings.push(message),
    events: { ...events, onCheckpoint: (result) => { seen.push(result); events.onCheckpoint?.(result) } },
  })
}

function makeEngine(dbPath: string, overrides: Partial<ConstructorParameters<typeof DatabaseEngine>[0]> = {}): DatabaseEngine {
  const engine = new DatabaseEngine({
    betterSqlite3: Database as never,
    dbPathProvider: () => dbPath,
    schemaVersion: 1,
    schema: SCHEMA,
    migrations: {},
    ...overrides,
  })
  engines.push(engine)
  return engine
}

function writeBatches(engine: DatabaseEngine, from: number, count: number, rows = 40): void {
  for (let batch = from; batch < from + count; batch++) {
    engine.runInTransaction(() => {
      for (let k = 0; k < rows; k++) engine.run('INSERT INTO items (id, batch, body) VALUES (?, ?, ?)', [`${batch}-${k}`, batch, BODY])
    })
  }
}

const autoCheckpoint = (engine: DatabaseEngine): number =>
  Number(engine.queryOne<{ wal_autocheckpoint: number }>('PRAGMA wal_autocheckpoint')?.wal_autocheckpoint)
const walBytes = (dbPath: string): number => (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)

/** A checkpointer the test drives by hand: it reports ready, never checkpoints. */
function manualCheckpointer(): { factory: WalCheckpointerFactory; events: () => WalCheckpointerEvents; requests: () => number; stops: () => number } {
  let events: WalCheckpointerEvents | null = null
  let requests = 0
  let stops = 0
  const checkpointer: WalCheckpointer = { request: () => { requests++ }, stop: () => { stops++; return true } }
  return {
    factory: (_path, e) => { events = e; return checkpointer },
    events: () => { if (!events) throw new Error('not started'); return events },
    requests: () => requests,
    stops: () => stops,
  }
}

describe('WAL checkpoints off the caller thread', () => {
  it('keeps the automatic checkpoint until the worker is ready, then the app connection checkpoints only at the backstop', async () => {
    const dbPath = dbIn('handover')
    const manual = manualCheckpointer()
    const engine = makeEngine(dbPath, { walCheckpointer: manual.factory, walJournalSizeLimitBytes: 1024 * 1024, walBackstopPages: 100_000 })
    await engine.initialize()
    expect(autoCheckpoint(engine)).toBe(1000)
    expect(engine.walCheckpointsOffMainThread()).toBe(false)

    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(100_000)
    expect(Number(engine.queryOne<{ journal_size_limit: number }>('PRAGMA journal_size_limit')?.journal_size_limit)).toBe(1024 * 1024)
    expect(engine.walCheckpointsOffMainThread()).toBe(true)

    // 4,000 pages of commits: the automatic checkpoint would have folded the
    // WAL back at 1,000 pages. Below the backstop nothing here checkpoints.
    writeBatches(engine, 0, 100)
    expect(walBytes(dbPath)).toBeGreaterThan(12 * 1024 * 1024)

    // saveDatabase asks the worker instead of checkpointing here.
    engine.saveDatabase()
    engine.flushNow()
    expect(manual.requests()).toBe(2)
    expect(walBytes(dbPath)).toBeGreaterThan(12 * 1024 * 1024)
  })

  it("uses SQLite's 1,000 pages as the default backstop", async () => {
    const dbPath = dbIn('default-backstop')
    const manual = manualCheckpointer()
    const engine = makeEngine(dbPath, { walCheckpointer: manual.factory })
    await engine.initialize()
    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(1000)
  })

  it('the backstop keeps the WAL bounded even when the worker never checkpoints', async () => {
    const dbPath = dbIn('backstop')
    const manual = manualCheckpointer()
    const engine = makeEngine(dbPath, { walCheckpointer: manual.factory, walJournalSizeLimitBytes: 1024 * 1024, walBackstopPages: 500 })
    await engine.initialize()
    manual.events().onReady()
    // 4,000 pages in commits of about 40: at 500 the commit copies the WAL
    // here and the next one starts it over, so the file never holds much more.
    writeBatches(engine, 0, 100)
    expect(walBytes(dbPath)).toBeLessThan(4 * 1024 * 1024)
  })

  it('under commits that never pause, the backstop keeps the WAL bounded while the real worker runs', async () => {
    const dbPath = dbIn('no-pause')
    const seen: WalCheckpointResult[] = []
    const engine = makeEngine(dbPath, {
      walCheckpointer: workerFactory(WORKER, {}, seen),
      walJournalSizeLimitBytes: 8 * 1024 * 1024,
    })
    await engine.initialize()
    await waitFor(() => engine.walCheckpointsOffMainThread())
    let peak = 0
    const until = Date.now() + 3000
    for (let batch = 0; Date.now() < until; batch++) {
      writeBatches(engine, batch, 1, 25)
      peak = Math.max(peak, walBytes(dbPath))
      await new Promise((resolve) => setImmediate(resolve))
    }
    // The worker's copy ends a few commits behind every time, so only the
    // backstop starts the WAL over. With the automatic checkpoint off
    // (wal_autocheckpoint 0) this loop grew the WAL past 300 MB (25-nov). The
    // bound is the backstop (4 MB) plus what arrives while a checkpoint runs.
    expect(peak).toBeLessThan(128 * 1024 * 1024)
    expect(seen.length).toBeGreaterThan(0)
    expect(autoCheckpoint(engine)).toBe(1000)
  })

  it('when commits pause, the worker catches up and the WAL starts over without a checkpoint here', async () => {
    const dbPath = dbIn('paused')
    const seen: WalCheckpointResult[] = []
    const engine = makeEngine(dbPath, {
      walCheckpointer: workerFactory(WORKER, {}, seen),
      walJournalSizeLimitBytes: 1024 * 1024,
    })
    await engine.initialize()
    await waitFor(() => engine.walCheckpointsOffMainThread())
    let peak = 0
    for (let batch = 0; batch < 12; batch++) {
      writeBatches(engine, batch, 1, 25) // about 250 pages, 1 MB
      peak = Math.max(peak, walBytes(dbPath))
      await waitFor(() => seen.some((r) => r.log > 0 && r.checkpointed === r.log && r.log >= 25))
      seen.length = 0
    }
    // Twelve 1 MB commits are 3,000 pages: had the WAL not started over at
    // each commit it would have held them all. It never held much more than one.
    expect(peak).toBeLessThan(3 * 1024 * 1024)
  })

  it('turns the automatic checkpoint back on when the worker fails', async () => {
    const dbPath = dbIn('failure')
    const manual = manualCheckpointer()
    const engine = makeEngine(dbPath, { walCheckpointer: manual.factory })
    await engine.initialize()
    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(1000)

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      manual.events().onFailure(new Error('worker died'))
    } finally { errors.mockRestore() }
    expect(autoCheckpoint(engine)).toBe(1000)
    expect(Number(engine.queryOne<{ journal_size_limit: number }>('PRAGMA journal_size_limit')?.journal_size_limit)).toBe(-1)
    expect(engine.walCheckpointsOffMainThread()).toBe(false)
    // A failed worker's late ready must not hand checkpoints over again.
    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(1000)
  })

  it('keeps checkpointing here when the host has no worker to offer', async () => {
    const dbPath = dbIn('no-worker')
    const engine = makeEngine(dbPath, { walCheckpointer: () => null })
    await engine.initialize()
    expect(autoCheckpoint(engine)).toBe(1000)
    expect(engine.walCheckpointsOffMainThread()).toBe(false)
  })

  it('never starts a checkpointer for a read-only connection', async () => {
    const dbPath = dbIn('read-only')
    const writer = makeEngine(dbPath)
    await writer.initialize()
    writer.closeDatabase()
    const started = vi.fn(() => null)
    const reader = makeEngine(dbPath, { walCheckpointer: started })
    reader.initializeReadOnly()
    expect(started).not.toHaveBeenCalled()
  })

  it('starts the checkpointer for an existing writable open too', async () => {
    const dbPath = dbIn('existing-writable')
    const first = makeEngine(dbPath)
    await first.initialize()
    first.closeDatabase()
    const manual = manualCheckpointer()
    const engine = makeEngine(dbPath, { walCheckpointer: manual.factory })
    engine.initializeExistingWritable()
    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(1000)
  })

  it('stops the worker before the closing TRUNCATE, and a re-initialize gets a new one', async () => {
    const dbPath = dbIn('close')
    const manual = manualCheckpointer()
    const factory = vi.fn(manual.factory)
    const engine = makeEngine(dbPath, { walCheckpointer: factory })
    await engine.initialize()
    const firstEvents = manual.events()
    firstEvents.onReady()
    await engine.initialize()
    expect(manual.stops()).toBe(1)
    expect(factory).toHaveBeenCalledTimes(2)
    // The first worker's events no longer reach the new connection.
    firstEvents.onFailure(new Error('late'))
    manual.events().onReady()
    expect(autoCheckpoint(engine)).toBe(1000)
    engine.closeDatabase()
    expect(manual.stops()).toBe(2)
    expect(walBytes(dbPath)).toBe(0)
  })

  it('a real worker thread checkpoints the WAL while the app keeps writing', async () => {
    const dbPath = dbIn('real-worker')
    const seen: WalCheckpointResult[] = []
    const engine = makeEngine(dbPath, {
      walCheckpointer: workerFactory(WORKER, { pollMs: 10, intervalMs: 50 }, seen),
      walJournalSizeLimitBytes: 1024 * 1024,
    })
    await engine.initialize()
    await waitFor(() => engine.walCheckpointsOffMainThread())
    expect(autoCheckpoint(engine)).toBe(1000)

    writeBatches(engine, 0, 50)
    await waitFor(() => seen.some((r) => r.reason === 'interval' || r.reason === 'growth'))
    // saveDatabase asks for one; it starts after the last commit above, so it
    // copies every frame.
    const before = seen.length
    engine.saveDatabase()
    await waitFor(() => seen.slice(before).some((r) => r.reason === 'requested' && r.log > 0 && r.checkpointed === r.log))
    // The next commit starts the WAL over and cuts it back to the journal size limit.
    writeBatches(engine, 50, 1, 1)
    expect(walBytes(dbPath)).toBeLessThanOrEqual(1024 * 1024)

    engine.closeDatabase()
    expect(walBytes(dbPath)).toBe(0)
    // The worker's handle is closed too: Windows would refuse to delete an open file.
    rmSync(dbPath)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('a reader that holds the WAL only delays the checkpoint; it finishes and the WAL is cut back once the reader ends', async () => {
    const dbPath = dbIn('pinned')
    const seen: WalCheckpointResult[] = []
    const warnings: string[] = []
    const engine = makeEngine(dbPath, {
      walCheckpointer: workerFactory(WORKER, { pollMs: 10, intervalMs: 50, pinnedWarnBytes: 2 * 1024 * 1024 }, seen, warnings),
      walJournalSizeLimitBytes: 1024 * 1024,
    })
    await engine.initialize()
    await waitFor(() => engine.walCheckpointsOffMainThread())
    writeBatches(engine, 0, 1)

    const reader = new Database(dbPath, { readonly: true })
    try {
      const rows = reader.prepare('SELECT id FROM items').iterate()
      rows.next() // an open read transaction on the snapshot before the writes below
      writeBatches(engine, 1, 40)
      await waitFor(() => seen.some((r) => r.log > 0 && r.checkpointed < r.log && r.walBytes >= 2 * 1024 * 1024))
      await waitFor(() => warnings.some((w) => w.includes('a reader holds the WAL')))
      rows.return?.()
    } finally { reader.close() }

    // No new writes and no request: the worker retries a checkpoint a reader cut short.
    const after = seen.length
    await waitFor(() => seen.slice(after).some((r) => r.log > 0 && r.checkpointed === r.log))
    writeBatches(engine, 41, 1, 1)
    expect(walBytes(dbPath)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('a worker thread that dies mid-checkpoint loses nothing and hands checkpoints back to the app connection', async () => {
    const dbPath = dbIn('worker-dies')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const engine = makeEngine(dbPath, { walCheckpointer: workerFactory(DYING_WORKER, { pollMs: 5, intervalMs: 0 }) })
      await engine.initialize()
      await waitFor(() => engine.walCheckpointsOffMainThread())
      let batch = 0
      // Keep committing until the worker has died in its second checkpoint.
      while (engine.walCheckpointsOffMainThread()) {
        writeBatches(engine, batch++, 1)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(autoCheckpoint(engine)).toBe(1000)
      writeBatches(engine, batch, 5)
      batch += 5
      engine.closeDatabase()

      const check = new Database(dbPath, { readonly: true })
      try {
        expect(check.pragma('integrity_check', { simple: true })).toBe('ok')
        expect((check.prepare('SELECT COUNT(*) AS c FROM items').get() as { c: number }).c).toBe(batch * 40)
      } finally { check.close() }
    } finally {
      errors.mockRestore()
      warns.mockRestore()
    }
  })

  it('a process killed in the middle of checkpoints loses no committed batch, and the pre-migration snapshot holds them all', async () => {
    for (const killAfterCheckpoints of [3, 25, 80]) {
      const dbPath = dbIn(`crash-${killAfterCheckpoints}`)
      const acked = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--no-warnings', CRASH_WRITER, dbPath, WORKER], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let lastAck = -1
        let checkpoints = 0
        let stderr = ''
        let buffered = ''
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.stdout.on('data', (chunk: Buffer) => {
          buffered += chunk.toString()
          const lines = buffered.split('\n')
          buffered = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('ACK ')) lastAck = Number(line.slice(4))
            else if (line === 'CKPT') checkpoints++
          }
          // Hard kill (TerminateProcess on Windows) while the worker is busy checkpointing.
          if (checkpoints >= killAfterCheckpoints && lastAck >= 5 && child.exitCode === null && !child.killed) child.kill('SIGKILL')
        })
        child.on('exit', (code, signal) => {
          if (signal === 'SIGKILL' || child.killed) resolve(lastAck)
          else reject(new Error(`writer exited on its own (${code}): ${stderr}`))
        })
        setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no progress: ${stderr}`)) }, 60_000)
      })

      const check = new Database(dbPath, { readonly: true })
      try {
        expect(check.pragma('integrity_check', { simple: true })).toBe('ok')
        const batches = check.prepare('SELECT batch, COUNT(*) AS c FROM items GROUP BY batch ORDER BY batch').all() as Array<{ batch: number; c: number }>
        for (let b = 0; b <= acked; b++) expect(batches[b], `batch ${b}`).toEqual({ batch: b, c: 40 })
      } finally { check.close() }

      // The next boot migrates: its snapshot must hold every acknowledged batch.
      const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        const upgrade = makeEngine(dbPath, { schemaVersion: 2, migrations: { 2: () => undefined }, walCheckpointer: () => null })
        await upgrade.initialize()
        upgrade.closeDatabase()
      } finally { logs.mockRestore() }
      const dir = join(dbPath, '..')
      const snapshots = readdirSync(dir).filter((name) => /^library\.sqlite\.bak-pre-v2-/.test(name))
      expect(snapshots).toHaveLength(1)
      const snapshot = new Database(join(dir, snapshots[0]), { readonly: true })
      try {
        const count = (snapshot.prepare('SELECT COUNT(*) AS c FROM items WHERE batch <= ?').get(acked) as { c: number }).c
        expect(count).toBe((acked + 1) * 40)
      } finally { snapshot.close() }
    }
  }, 180_000)
})
