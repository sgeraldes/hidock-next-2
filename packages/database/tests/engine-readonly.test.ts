// @vitest-environment node

/**
 * DatabaseEngine.initializeReadOnly — a second process reading a database the
 * app may have open at the same time.
 *
 * The headless brain service answers questions about the owner's data while the
 * app that owns the file might be running. SQLite's WAL mode allows that as long
 * as the reader never writes; these tests hold the parts of that promise the
 * engine controls.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync, statSync } from 'fs'
import Database from 'better-sqlite3'
import { DatabaseEngine, SchemaBehindError } from '../src/index.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT);
`

const paths: string[] = []

afterEach(() => {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${p}${suffix}`)) rmSync(`${p}${suffix}`, { force: true })
    }
  }
  paths.length = 0
})

function pathFor(name: string): string {
  const path = join(tmpdir(), `hidock-db-readonly-test-${name}.sqlite`)
  paths.push(path)
  return path
}

function engineFor(path: string, schemaVersion = 1): DatabaseEngine {
  return new DatabaseEngine({
    betterSqlite3: Database,
    dbPathProvider: () => path,
    schemaVersion,
    schema: SCHEMA,
    migrations: {},
  })
}

/** The owning process: creates the file, writes a row, and stays open. */
async function writerWith(path: string, rows: Array<[string, string]>): Promise<DatabaseEngine> {
  const writer = engineFor(path)
  await writer.initialize()
  for (const [id, name] of rows) writer.run('INSERT INTO items (id, name) VALUES (?, ?)', [id, name])
  return writer
}

describe('DatabaseEngine.initializeReadOnly', () => {
  it('reads what the owning process wrote, while it is still open', async () => {
    const path = pathFor('concurrent')
    const writer = await writerWith(path, [['a', 'Alpha']])

    const reader = engineFor(path)
    reader.initializeReadOnly()
    expect(reader.queryOne<{ name: string }>('SELECT name FROM items WHERE id = ?', ['a'])?.name).toBe('Alpha')

    // A write the owner makes afterwards is visible to the reader's next query.
    writer.run('INSERT INTO items (id, name) VALUES (?, ?)', ['b', 'Beta'])
    expect(reader.queryAll('SELECT id FROM items ORDER BY id')).toHaveLength(2)

    reader.closeDatabase()
    writer.closeDatabase()
  })

  it('refuses to write', async () => {
    const path = pathFor('refuses-write')
    const writer = await writerWith(path, [])
    writer.closeDatabase()

    const reader = engineFor(path)
    reader.initializeReadOnly()
    expect(() => reader.run('INSERT INTO items (id, name) VALUES (?, ?)', ['x', 'X'])).toThrow(/readonly/i)
    reader.closeDatabase()
  })

  it('leaves the file exactly as it found it', async () => {
    // The ordinary initialize() switches the journal mode, takes a backup,
    // creates tables and runs migrations. None of that may happen here.
    const path = pathFor('untouched')
    const writer = await writerWith(path, [['a', 'Alpha']])
    writer.closeDatabase()
    const before = statSync(path).mtimeMs

    const reader = engineFor(path)
    reader.initializeReadOnly()
    reader.queryAll('SELECT * FROM items')
    reader.closeDatabase()

    expect(statSync(path).mtimeMs).toBe(before)
    expect(existsSync(`${path}.bak-${new Date().toISOString().slice(0, 10)}`)).toBe(false)
  })

  it('will not create a database that does not exist', () => {
    const path = pathFor('missing')
    const reader = engineFor(path)
    expect(() => reader.initializeReadOnly()).toThrow(/Open the app once/)
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a file on an older schema than the code expects', async () => {
    // The queries name columns a migration adds, and a reader cannot migrate.
    const path = pathFor('old-schema')
    const writer = await writerWith(path, [])
    writer.closeDatabase()

    const reader = engineFor(path, 5)
    expect(() => reader.initializeReadOnly()).toThrow(/schema v1 and this code needs v5/)
    // Typed, with both versions, so the headless brain can tell this failure
    // from every other one and upgrade the file when it is alone.
    let caught: unknown
    try {
      reader.initializeReadOnly()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SchemaBehindError)
    expect(caught).toMatchObject({ onDisk: 1, needed: 5 })
  })
})
