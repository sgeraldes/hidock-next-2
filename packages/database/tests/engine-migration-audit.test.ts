// @vitest-environment node

/**
 * The engine's own record of what it did to the schema, and the version number
 * that says which safety behaviours this build of the engine has.
 *
 * In November 2026 the app ran an engine dist that was older than its source.
 * The v72 migration ran on the owner's library without the pre-migration
 * snapshot, because the stale engine predated the snapshot, and nothing on disk
 * said so. Two things make that visible from now on:
 *  - ENGINE_SAFETY_VERSION, exported by the package, which the app compares
 *    with the version it was written against;
 *  - one schema_migration_audit row per migration run: from and to version,
 *    time, app version, engine safety version, and whether the pre-migration
 *    backup was made and where.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import { existsSync, readdirSync, rmSync } from 'fs'
import Database from 'better-sqlite3'
import { DatabaseEngine, ENGINE_SAFETY_VERSION } from '../src/index.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT);
`

type AuditRow = {
  from_version: number
  to_version: number
  migrated_at: string
  app_version: string | null
  engine_safety_version: number
  backup_made: number
  backup_path: string | null
  outcome: string
  error: string | null
}

const created: string[] = []

function tempDbPath(name: string): string {
  const p = join(tmpdir(), `hidock-db-audit-${name}-${process.pid}.sqlite`)
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${p}${suffix}`, { force: true })
  created.push(p)
  return p
}

afterEach(() => {
  // Only this file's own databases and their engine-named backups.
  for (const p of created) {
    const dir = dirname(p)
    const base = basename(p)
    for (const file of readdirSync(dir)) {
      if (file === base || file === `${base}-wal` || file === `${base}-shm` || file.startsWith(`${base}.bak-`)) {
        rmSync(join(dir, file), { force: true })
      }
    }
  }
  created.length = 0
})

function engineAt(path: string, version: number, migrations: Record<number, () => void> = {}, appVersion?: string) {
  return new DatabaseEngine({
    betterSqlite3: Database,
    dbPathProvider: () => path,
    schemaVersion: version,
    schema: SCHEMA,
    migrations,
    ...(appVersion === undefined ? {} : { appVersion: () => appVersion }),
  })
}

function auditRows(path: string): AuditRow[] {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration_audit'").get()
    if (!table) return []
    return db.prepare('SELECT * FROM schema_migration_audit ORDER BY id').all() as AuditRow[]
  } finally {
    db.close()
  }
}

describe('ENGINE_SAFETY_VERSION', () => {
  it('is exported as an integer that covers the migration audit (2 or later)', () => {
    expect(Number.isInteger(ENGINE_SAFETY_VERSION)).toBe(true)
    expect(ENGINE_SAFETY_VERSION).toBeGreaterThanOrEqual(2)
  })
})

describe('schema migration audit', () => {
  it('writes no row when a fresh database is created', async () => {
    const path = tempDbPath('fresh')
    const e = engineAt(path, 3, {}, '9.9.9')
    try { await e.initialize() } finally { e.closeDatabase() }
    expect(auditRows(path)).toEqual([])
  })

  it('writes no row on a boot that is already at the current schema', async () => {
    const path = tempDbPath('current')
    const first = engineAt(path, 1)
    try { await first.initialize() } finally { first.closeDatabase() }
    const again = engineAt(path, 1, {}, '9.9.9')
    try { await again.initialize() } finally { again.closeDatabase() }
    expect(auditRows(path)).toEqual([])
  })

  it('records one row per migration run with versions, time, app version and the verified backup', async () => {
    const path = tempDbPath('migrate')
    const v1 = engineAt(path, 1)
    try { await v1.initialize() } finally { v1.closeDatabase() }

    const ran: number[] = []
    const before = new Date().toISOString()
    const v3 = engineAt(path, 3, { 2: () => ran.push(2), 3: () => ran.push(3) }, '2.0.0-test')
    try { await v3.initialize() } finally { v3.closeDatabase() }
    const after = new Date().toISOString()

    expect(ran).toEqual([2, 3])
    const rows = auditRows(path)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      from_version: 1,
      to_version: 3,
      app_version: '2.0.0-test',
      engine_safety_version: ENGINE_SAFETY_VERSION,
      backup_made: 1,
      outcome: 'completed',
      error: null,
    })
    expect(row.migrated_at >= before && row.migrated_at <= after).toBe(true)
    expect(row.backup_path).toMatch(/\.bak-pre-v3-\d{8}T\d{9}Z-[\w-]+$/)
    expect(existsSync(row.backup_path!)).toBe(true)
  })

  it('leaves app_version NULL when the host does not supply one', async () => {
    const path = tempDbPath('no-app-version')
    const v1 = engineAt(path, 1)
    try { await v1.initialize() } finally { v1.closeDatabase() }
    const v2 = engineAt(path, 2, { 2: () => {} })
    try { await v2.initialize() } finally { v2.closeDatabase() }
    expect(auditRows(path)[0].app_version).toBeNull()
  })

  it('records a failed run with the version it reached and the error, then rethrows', async () => {
    const path = tempDbPath('failed')
    const v1 = engineAt(path, 1)
    try { await v1.initialize() } finally { v1.closeDatabase() }

    const v3 = engineAt(path, 3, { 2: () => {}, 3: () => { throw new Error('boom in v3') } }, '2.0.0-test')
    try {
      await expect(v3.initialize()).rejects.toThrow('boom in v3')
    } finally {
      v3.closeDatabase()
    }
    const rows = auditRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      from_version: 1,
      to_version: 2,
      outcome: 'failed',
      backup_made: 1,
      app_version: '2.0.0-test',
    })
    expect(rows[0].error).toContain('boom in v3')
  })

  it('appends a row for every later run and keeps the earlier ones', async () => {
    const path = tempDbPath('history')
    const v1 = engineAt(path, 1)
    try { await v1.initialize() } finally { v1.closeDatabase() }
    const v2 = engineAt(path, 2, { 2: () => {} }, 'a')
    try { await v2.initialize() } finally { v2.closeDatabase() }
    const v3 = engineAt(path, 3, { 2: () => {}, 3: () => {} }, 'b')
    try { await v3.initialize() } finally { v3.closeDatabase() }
    expect(auditRows(path).map((r) => [r.from_version, r.to_version, r.app_version])).toEqual([
      [1, 2, 'a'],
      [2, 3, 'b'],
    ])
  })
})
