// @vitest-environment node

/**
 * Safety nets on the shared DatabaseEngine:
 *  - the mass-delete tripwire (refuse a statement that would wipe >50% of a
 *    protected table holding >20 rows, unless explicitly overridden), and
 *  - the rotating on-boot backup (a dated file copy before migrations, keeping
 *    the newest N).
 *
 * Both run against real better-sqlite3 databases backed by temp files.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'fs'
import * as fs from 'fs'
import Database from 'better-sqlite3'
import { DatabaseEngine, MassDeleteError, parseDestructiveStatement } from '../src/index.js'

vi.mock('fs', { spy: true })

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
      .filter((f) => /\.bak-\d{4}-\d{2}-\d{2}$/.test(f))
      .map((f) => f.split(/[\\/]/).pop() as string)
      .sort()
    expect(baks).toHaveLength(2)
    // The two oldest were pruned; the newest pre-existing one + today's remain.
    expect(baks.some((f) => f.endsWith('.bak-2020-01-01'))).toBe(false)
    expect(baks.some((f) => f.endsWith('.bak-2020-01-02'))).toBe(false)
    expect(baks.some((f) => f.endsWith('.bak-2020-01-03'))).toBe(true)
    expect(fs.readFileSync(`${path}.bak-2020-01-04.partial`, 'utf8')).toBe('interrupted')
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
    const stateOf = (p: string) => {
      const st = statSync(p, { bigint: true })
      return { sourceMtimeNs: st.mtimeNs, sourceSize: Number(st.size) }
    }
    function v2Engine(path: string, externalBackups?: () => Array<{ path: string; sourceMtimeNs: bigint; sourceSize: number }>, migration = () => {}) {
      return new DatabaseEngine({
        betterSqlite3: Database,
        dbPathProvider: () => path,
        schemaVersion: 2,
        schema: SCHEMA,
        migrations: { 2: migration },
        backupOnBoot: { keep: 3 },
        deferBackupOnBoot: true,
        externalBackups,
      })
    }
    const todays = (path: string) => siblingFiles(path).filter((f) => /\.bak-pre-v2-(?:\d{8}T\d{9}Z-[\w-]+|[a-z0-9]+-[a-f0-9]{4})$/.test(f) && !/-wal$|-shm$/.test(f))

    it('ignores a stale same-day daily backup and verifies current contents before migration', async () => {
      const path = await v1File('backup-same-day')
      const daily = `${path}.bak-${new Date().toISOString().slice(0, 10)}`
      copyFileSync(path, daily)
      const writer = new Database(path)
      writer.prepare('INSERT INTO items VALUES (?, ?)').run('latest', 'current')
      writer.close()
      let checked = false
      const e = v2Engine(path, undefined, () => {
        const backups = todays(path)
        expect(backups).toHaveLength(1)
        const snapshot = new Database(backups[0], { readonly: true, fileMustExist: true })
        try {
          expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
          expect(snapshot.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 })
          expect(snapshot.prepare('SELECT name FROM items WHERE id = ?').get('latest')).toEqual({ name: 'current' })
          checked = true
        } finally { snapshot.close() }
      })
      try { await e.initialize() } finally { e.closeDatabase() }
      expect(checked).toBe(true)
      const stale = new Database(daily, { readonly: true })
      try { expect(stale.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 0 }) } finally { stale.close() }
    })

    it('rejects an external backup with a different schema despite matching recorded metadata and size', async () => {
      const path = await v1File('backup-wrong-schema')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const stale = new Database(external)
      stale.exec('UPDATE schema_version SET version = 0')
      stale.close()
      const seen: string[] = []
      const e = v2Engine(path, () => [{ path: external, ...stateOf(path) }])
      try { await e.initialize({ onProgress: p => seen.push(p.phase) }) } finally { e.closeDatabase() }
      expect(seen).not.toContain('backup-reused')
      expect(todays(path)).toHaveLength(1)
    })

    it('removes an interrupted owned partial before checking space and recovers without removing other files', async () => {
      const path = await v1File('backup-interrupted')
      const partial = `${path}.p`
      const unrelated = `${path}.bak-pre-v2-user.partial`
      const otherVersion = `${path}.bak-pre-v1.partial`
      writeFileSync(unrelated, 'user file')
      writeFileSync(otherVersion, 'interrupted older target')
      const backup = vi.spyOn(Database.prototype, 'backup').mockImplementationOnce(async destination => {
        writeFileSync(destination, 'interrupted copy')
        throw new Error('interrupted')
      })
      const first = v2Engine(path)
      try { await expect(first.initialize()).rejects.toThrow('interrupted') }
      finally { first.closeDatabase(); backup.mockRestore() }
      expect(existsSync(partial)).toBe(true)
      const space = vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
        expect(existsSync(partial)).toBe(false)
        expect(existsSync(otherVersion)).toBe(false)
        return { bavail: 1000000n, bsize: 4096n } as ReturnType<typeof fs.statfsSync>
      })
      const second = v2Engine(path)
      try { await second.initialize(); expect(space).toHaveBeenCalled() }
      finally { second.closeDatabase(); space.mockRestore() }
      expect(existsSync(partial)).toBe(false)
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('user file')
      expect(todays(path)).toHaveLength(1)
      const snapshot = new Database(todays(path)[0], { readonly: true })
      try { expect(snapshot.pragma('quick_check', { simple: true })).toBe('ok') }
      finally { snapshot.close() }
    })

    it('fails before copying or migrating when free space is smaller than the snapshot', async () => {
      const path = await v1File('backup-no-space')
      const space = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0n, bsize: 4096n } as ReturnType<typeof fs.statfsSync>)
      const backup = vi.spyOn(Database.prototype, 'backup')
      const migration = vi.fn()
      const e = v2Engine(path, undefined, migration)
      try {
        await expect(e.initialize()).rejects.toThrow(`Insufficient free space for pre-migration backup: need ${statSync(path).size} bytes, available 0 bytes`)
        expect(backup).not.toHaveBeenCalled()
      }
      finally { e.closeDatabase(); space.mockRestore(); backup.mockRestore() }
      expect(migration).not.toHaveBeenCalled()
    })

    it('preserves all existing daily backups when routine backups are disabled', async () => {
      const path = await v1File('backup-disabled-retention')
      const dailies = ['2020-01-01', '2020-01-02', '2020-01-03'].map(day => `${path}.bak-${day}`)
      for (const daily of dailies) copyFileSync(path, daily)
      const e = new DatabaseEngine({
        betterSqlite3: Database, dbPathProvider: () => path, schemaVersion: 2,
        schema: SCHEMA, migrations: { 2: () => {} }, backupOnBoot: { keep: 0 },
      })
      try { await e.initialize() } finally { e.closeDatabase() }
      for (const daily of dailies) expect(existsSync(daily)).toBe(true)
      expect(todays(path)).toHaveLength(1)
    })

    it('fails closed when the SQLite backup fails, before repair or migration', async () => {
      const path = await v1File('backup-failure')
      const backup = vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('backup disk failure'))
      const migration = vi.fn()
      const e = v2Engine(path, undefined, migration)
      try { await expect(e.initialize()).rejects.toThrow('backup disk failure') }
      finally { e.closeDatabase(); backup.mockRestore() }
      expect(migration).not.toHaveBeenCalled()
      const original = new Database(path, { readonly: true })
      try { expect(original.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 }) } finally { original.close() }
    })

    it('includes committed WAL contents instead of reusing the older main file', async () => {
      const path = await v1File('backup-wal-current')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const source = stateOf(path)
      const writer = new Database(path)
      writer.pragma('journal_mode = WAL')
      writer.pragma('wal_autocheckpoint = 0')
      writer.prepare('INSERT INTO items VALUES (?, ?)').run('wal', 'committed')
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
      const seen: string[] = []
      const e = v2Engine(path, () => [{ path: external, ...source }], () => {
        const snapshot = new Database(todays(path)[0], { readonly: true, fileMustExist: true })
        try {
          expect(snapshot.prepare('SELECT name FROM items WHERE id = ?').get('wal')).toEqual({ name: 'committed' })
          expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete')
        } finally { snapshot.close() }
      })
      try { await e.initialize({ onProgress: p => seen.push(p.phase) }) }
      finally { e.closeDatabase(); writer.close() }
      expect(seen).not.toContain('backup-reused')
    })

    it.each([undefined, { keep: 0 }])('requires a migration snapshot even with routine backup config %j', async backupOnBoot => {
      const path = await v1File(`backup-required-${backupOnBoot ? 'disabled' : 'absent'}`)
      const e = new DatabaseEngine({
        betterSqlite3: Database,
        dbPathProvider: () => path,
        schemaVersion: 2,
        schema: SCHEMA,
        migrations: { 2: () => { expect(todays(path)).toHaveLength(1) } },
        backupOnBoot,
      })
      try { await e.initialize() } finally { e.closeDatabase() }
      expect(todays(path)).toHaveLength(1)
    })

    it('fails closed when the backup API returns an invalid snapshot', async () => {
      const path = await v1File('backup-invalid-snapshot')
      const backup = vi.spyOn(Database.prototype, 'backup').mockImplementationOnce(async destination => {
        writeFileSync(destination, 'invalid SQLite file')
        return { totalPages: 1, remainingPages: 0 }
      })
      const migration = vi.fn()
      const e = v2Engine(path, undefined, migration)
      try { await expect(e.initialize()).rejects.toThrow() }
      finally { e.closeDatabase(); backup.mockRestore() }
      expect(migration).not.toHaveBeenCalled()
      expect(todays(path)).toHaveLength(0)
      const original = new Database(path, { readonly: true })
      try { expect(original.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 }) }
      finally { original.close() }
    })

    it('retains three migration backups separately from daily files and always keeps the new one', async () => {
      const path = await v1File('backup-pre-prune')
      for (const stamp of ['20990101T000000000Z', '20990102T000000000Z', '20990103T000000000Z']) {
        copyFileSync(path, `${path}.bak-pre-v99-${stamp}-old`)
      }
      const daily = `${path}.bak-${new Date().toISOString().slice(0, 10)}`
      copyFileSync(path, daily)
      const e = v2Engine(path)
      try { await e.initialize() } finally { e.closeDatabase() }
      expect(siblingFiles(path).filter(f => f.includes('.bak-pre-'))).toHaveLength(3)
      expect(todays(path)).toHaveLength(1)
      expect(existsSync(daily)).toBe(true)
      expect(existsSync(`${path}.bak-pre-v99-20990101T000000000Z-old`)).toBe(false)
    })

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

    it('reuses an external backup made from exactly this file, without copying', async () => {
      const path = await v1File('backup-reuse')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const snapshot = new Database(external)
      snapshot.pragma('journal_mode = DELETE')
      snapshot.close()
      const seen: string[] = []
      const source = stateOf(path)
      const e = v2Engine(path, () => [{ path: external, ...source }])
      await e.initialize({ onProgress: (p) => seen.push(p.phase) })
      e.closeDatabase()
      expect(seen).toEqual(['backup-reused', 'migrating'])
      // Hard-linked under an independently retained pre-migration name.
      expect(todays(path)).toHaveLength(1)
      expect(statSync(todays(path)[0]).size).toBe(statSync(external).size)
    })

    it('copies anyway when the file changed after that backup (a different modification time)', async () => {
      const path = await v1File('backup-stale')
      const external = `${path}.hourly`
      extra.push(external)
      copyFileSync(path, external)
      const seen: string[] = []
      const source = stateOf(path)
      const e = v2Engine(path, () => [{ path: external, ...source, sourceMtimeNs: source.sourceMtimeNs - 1n }])
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
      const e = v2Engine(path, () => [{ path: external, ...stateOf(path) }])
      await e.initialize({ onProgress: (p) => seen.push(p.phase) })
      e.closeDatabase()
      expect(seen).not.toContain('backup-reused')
    })
  })
})
