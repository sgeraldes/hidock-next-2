// @vitest-environment node
import { it, expect } from 'vitest'
import { tmpdir } from 'os'
import { join, toNamespacedPath } from 'path'
import { mkdirSync, readdirSync } from 'fs'
import Database from 'better-sqlite3'
import { DatabaseEngine } from '@hidock/database'

it('backs up and verifies a pending migration in a deep data folder', async () => {
  const root = join(tmpdir(), `deep-${process.pid}`)
  const dir = join(root, 'd'.repeat(Math.max(1, 230 - root.length)))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'hidock.db')
  const schema = 'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS items (id TEXT);'
  const first = new DatabaseEngine({ betterSqlite3: Database, dbPathProvider: () => path, schemaVersion: 1, schema, migrations: {} })
  await first.initialize(); first.run("INSERT INTO items VALUES ('preserved')"); first.closeDatabase()
  const next = new DatabaseEngine({ betterSqlite3: Database, dbPathProvider: () => path, schemaVersion: 2, schema, migrations: { 2: () => undefined } })
  try {
    await next.initialize()
    expect(next.queryAll('SELECT * FROM items')).toEqual([{ id: 'preserved' }])
    const backup = readdirSync(dir).find(name => name.startsWith('hidock.db.bak-pre-v2-') && !name.endsWith('.partial'))!
    expect(backup.length).toBeLessThan(50)
    const snapshot = new Database(toNamespacedPath(join(dir, backup)), { readonly: true, fileMustExist: true })
    expect(snapshot.prepare('SELECT * FROM items').all()).toEqual([{ id: 'preserved' }]); snapshot.close()
  } finally { next.closeDatabase() }
})
