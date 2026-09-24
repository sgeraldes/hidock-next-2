// @vitest-environment node

/**
 * Safety nets on the shared DatabaseEngine:
 *  - the mass-delete tripwire (refuse a statement that would wipe >50% of a
 *    protected table holding >20 rows, unless explicitly overridden), and
 *  - the rotating on-boot backup (a dated file copy before migrations, keeping
 *    the newest N).
 *
 * Both run against a real sql.js database backed by a temp file.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { DatabaseEngine, MassDeleteError, parseDestructiveStatement } from '../src/index.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY);
`

function tempDbPath(name: string): string {
  const p = join(tmpdir(), `hidock-db-safety-${name}.sqlite`)
  // Start from nothing. A run that dies mid-test leaves these fixed names
  // behind, and the next run then opened a database that already had rows
  // (23-sep: six stale files turned 7 passing tests red a day later).
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${p}${suffix}`, { force: true })
  return p
}

describe('mass-delete tripwire', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ['', '.tmp', '-wal', '-shm']) {
        if (existsSync(`${p}${suffix}`)) rmSync(`${p}${suffix}`, { force: true })
      }
    }
    paths.length = 0
  })

  async function makeEngine(name: string, protectedTables: string[] = ['items']) {
    const path = tempDbPath(name)
    paths.push(path)
    const engine = new DatabaseEngine({
      betterSqlite3: Database,
      dbPathProvider: () => path,
      schemaVersion: 1,
      schema: SCHEMA,
      migrations: {},
      protectedTables
    })
    await engine.initialize()
    return engine
  }

  function seedItems(engine: DatabaseEngine, n: number): void {
    for (let i = 0; i < n; i++) engine.run('INSERT INTO items (id, name) VALUES (?, ?)', [`i${i}`, `n${i % 3}`])
  }

  it('refuses a full-table DELETE on a protected table with >20 rows', async () => {
    const engine = await makeEngine('refuse-delete')
    seedItems(engine, 25)
    expect(() => engine.run('DELETE FROM items')).toThrow(MassDeleteError)
    expect(engine.queryAll('SELECT * FROM items')).toHaveLength(25) // nothing deleted
    engine.closeDatabase()
  })

  it('refuses a DROP TABLE on a protected table with >20 rows', async () => {
    const engine = await makeEngine('refuse-drop')
    seedItems(engine, 25)
    expect(() => engine.run('DROP TABLE items')).toThrow(MassDeleteError)
    expect(() => engine.run('DROP TABLE IF EXISTS items')).toThrow(MassDeleteError)
    expect(engine.queryAll('SELECT * FROM items')).toHaveLength(25)
    engine.closeDatabase()
  })

  it('allows a DELETE that removes ≤50% of the rows', async () => {
    const engine = await makeEngine('allow-partial')
    seedItems(engine, 30) // names cycle n0,n1,n2 → ~10 each
    expect(() => engine.run('DELETE FROM items WHERE name = ?', ['n0'])).not.toThrow()
    expect(engine.queryAll('SELECT * FROM items').length).toBeLessThan(30)
    expect(engine.queryAll('SELECT * FROM items').length).toBeGreaterThan(15)
    engine.closeDatabase()
  })

  it('allows a full DELETE when the table holds ≤20 rows (nothing precious yet)', async () => {
    const engine = await makeEngine('allow-small')
    seedItems(engine, 20)
    expect(() => engine.run('DELETE FROM items')).not.toThrow()
    expect(engine.queryAll('SELECT * FROM items')).toHaveLength(0)
    engine.closeDatabase()
  })

  it('does not guard non-protected tables', async () => {
    const engine = await makeEngine('non-protected')
    for (let i = 0; i < 25; i++) engine.run('INSERT INTO scratch (id) VALUES (?)', [`s${i}`])
    expect(() => engine.run('DELETE FROM scratch')).not.toThrow()
    expect(engine.queryAll('SELECT * FROM scratch')).toHaveLength(0)
    engine.closeDatabase()
  })

  it('bypasses the tripwire inside runWithMassDeleteAllowed()', async () => {
    const engine = await makeEngine('override')
    seedItems(engine, 25)
    engine.runWithMassDeleteAllowed(() => engine.run('DELETE FROM items'))
    expect(engine.queryAll('SELECT * FROM items')).toHaveLength(0)
    // Guard is restored afterwards.
    seedItems(engine, 25)
    expect(() => engine.run('DELETE FROM items')).toThrow(MassDeleteError)
    engine.closeDatabase()
  })

  it('rolls back a whole transaction when a mass delete is refused mid-transaction', async () => {
    const engine = await makeEngine('txn-rollback')
    seedItems(engine, 25)
    expect(() =>
      engine.runInTransaction(() => {
        engine.run('INSERT INTO items (id, name) VALUES (?, ?)', ['extra', 'x'])
        engine.run('DELETE FROM items') // tripwire throws → ROLLBACK
      })
    ).toThrow(MassDeleteError)
    // The INSERT was rolled back and the DELETE never ran.
    expect(engine.queryAll('SELECT * FROM items')).toHaveLength(25)
    engine.closeDatabase()
  })

  it('parseDestructiveStatement recognizes DELETE and DROP, ignores others', () => {
    expect(parseDestructiveStatement('DELETE FROM knowledge_captures WHERE x = 1')).toEqual({
      kind: 'delete',
      table: 'knowledge_captures'
    })
    expect(parseDestructiveStatement('  drop table if exists items')).toEqual({ kind: 'drop', table: 'items' })
    expect(parseDestructiveStatement('UPDATE items SET name = 1')).toBeNull()
    expect(parseDestructiveStatement('SELECT * FROM items')).toBeNull()
  })
})

describe('rotating on-boot backup', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const p of paths) {
      for (const f of siblingFiles(p)) rmSync(f, { force: true })
    }
    paths.length = 0
  })

  function siblingFiles(dbPath: string): string[] {
    const dir = tmpdir()
    const base = dbPath.split(/[\\/]/).pop() as string
    return readdirSync(dir)
      .filter((f) => f === base || f.startsWith(`${base}.`) || f.startsWith(`${base}-`))
      .map((f) => join(dir, f))
  }

  function makeEngine(path: string, keep: number, deferBackupOnBoot = false) {
    return new DatabaseEngine({
      betterSqlite3: Database,
      dbPathProvider: () => path,
      schemaVersion: 1,
      schema: SCHEMA,
      migrations: {},
      backupOnBoot: { keep },
      deferBackupOnBoot
    })
  }

  it('does not back up a fresh database (no file yet), then backs up on the next boot', async () => {
    const path = tempDbPath('backup-fresh')
    paths.push(path)

    const e1 = makeEngine(path, 3)
    await e1.initialize() // fresh — nothing to back up
    e1.closeDatabase()
    expect(siblingFiles(path).some((f) => f.includes('.bak-'))).toBe(false)

    const e2 = makeEngine(path, 3)
    await e2.initialize() // file now exists → today's backup is written
    e2.closeDatabase()
    expect(siblingFiles(path).filter((f) => f.includes('.bak-'))).toHaveLength(1)
  })

  it('prunes to the newest `keep` dated backups', async () => {
    const path = tempDbPath('backup-prune')
    paths.push(path)

    // First boot creates the db file (no backup yet).
    const e1 = makeEngine(path, 2)
    await e1.initialize()
    e1.closeDatabase()

    // Pre-existing older daily backups (dated names sort chronologically).
    for (const day of ['2020-01-01', '2020-01-02', '2020-01-03']) {
      writeFileSync(`${path}.bak-${day}`, 'old')
    }
    writeFileSync(`${path}.bak-2020-01-04.partial`, 'interrupted')

    // Second boot adds today's backup, then prunes to keep the newest 2.
    const e2 = makeEngine(path, 2)
    await e2.initialize()
    e2.closeDatabase()

    const baks = siblingFiles(path)
      .filter((f) => f.includes('.bak-'))
      .map((f) => f.split(/[\\/]/).pop() as string)
      .sort()
    expect(baks).toHaveLength(2)
    // The two oldest were pruned; the newest pre-existing one + today's remain.
    expect(baks.some((f) => f.endsWith('.bak-2020-01-01'))).toBe(false)
    expect(baks.some((f) => f.endsWith('.bak-2020-01-02'))).toBe(false)
    expect(baks.some((f) => f.endsWith('.bak-2020-01-03'))).toBe(true)
    expect(siblingFiles(path).some((f) => f.endsWith('.partial'))).toBe(false)
  })

  it('returns from a schema-current boot before a deferred routine backup', async () => {
    const path = tempDbPath('backup-deferred')
    paths.push(path)
    const first = makeEngine(path, 3)
    await first.initialize()
    first.closeDatabase()

    const second = makeEngine(path, 3, true)
    await second.initialize()
    expect(siblingFiles(path).some((file) => file.includes('.bak-'))).toBe(false)

    await second.runDeferredBackup()
    expect(siblingFiles(path).filter((file) => /\.bak-\d{4}-\d{2}-\d{2}$/.test(file))).toHaveLength(1)
    second.closeDatabase()
  })

  describe('before a migration', () => {
    const extra: string[] = []
    afterEach(() => {
      for (const f of extra) rmSync(f, { force: true })
      extra.length = 0
    })

    // A v1 file on disk, then an engine that wants v2: the boot must back up first.
    async function v1File(name: string): Promise<string> {
      const path = tempDbPath(name)
      paths.push(path)
      const e = makeEngine(path, 3)
      await e.initialize()
      e.closeDatabase()
      return path
    }
    function v2Engine(path: string, externalBackups?: () => Array<{ path: string; startedAtMs: number }>) {
      return new DatabaseEngine({
        betterSqlite3: Database,
        dbPathProvider: () => path,
        schemaVersion: 2,
        schema: SCHEMA,
        migrations: { 2: () => {} },
        backupOnBoot: { keep: 3 },
        deferBackupOnBoot: true,
        externalBackups,
      })
    }
    const todays = (path: string) => siblingFiles(path).filter((f) => /\.bak-\d{4}-\d{2}-\d{2}$/.test(f))

    it('reports the copy as it goes, then the migration', async () => {
      const path = await v1File('backup-progress')
      const seen: string[] = []
      let last = { copiedBytes: 0, totalBytes: -1 }
      const e = v2Engine(path)
      await e.initialize({
        onProgress: (p) => {
          seen.push(p.phase)
          if (p.phase === 'backup') last = p
        },
      })
      e.closeDatabase()
      expect(seen[0]).toBe('backup')
      expect(seen.at(-1)).toBe('migrating')
      expect(last.totalBytes).toBeGreaterThan(0)
      expect(last.copiedBytes).toBe(last.totalBytes)
      expect(todays(path)).toHaveLength(1)
    })

    it('reuses an external backup that started after the last write, without copying', async () => {
      const path = await v1File('backup-reuse')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const seen: string[] = []
      const e = v2Engine(path, () => [{ path: external, startedAtMs: statSync(path).mtimeMs + 1000 }])
      await e.initialize({ onProgress: (p) => seen.push(p.phase) })
      e.closeDatabase()
      expect(seen).toEqual(['backup-reused', 'migrating'])
      // Hard-linked under the dated name, so the routine backup is not repeated today.
      expect(todays(path)).toHaveLength(1)
      expect(statSync(todays(path)[0]).size).toBe(statSync(external).size)
    })

    it('copies anyway when the external backup is older than the last write', async () => {
      const path = await v1File('backup-stale')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const seen: string[] = []
      const e = v2Engine(path, () => [{ path: external, startedAtMs: statSync(path).mtimeMs - 60_000 }])
      await e.initialize({ onProgress: (p) => seen.push(p.phase) })
      e.closeDatabase()
      expect(seen[0]).toBe('backup')
      expect(seen).not.toContain('backup-reused')
    })

    it('copies anyway when the external backup is not the same size', async () => {
      const path = await v1File('backup-size')
      const external = `${path}.hourly`
      extra.push(external)
      writeFileSync(external, 'truncated')
      const seen: string[] = []
      const e = v2Engine(path, () => [{ path: external, startedAtMs: Date.now() + 1000 }])
      await e.initialize({ onProgress: (p) => seen.push(p.phase) })
      e.closeDatabase()
      expect(seen).not.toContain('backup-reused')
    })
  })
})
