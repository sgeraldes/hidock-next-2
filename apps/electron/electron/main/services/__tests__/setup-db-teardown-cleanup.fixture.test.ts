import { expect, it } from 'vitest'
import Database from 'better-sqlite3'

const databasePath = process.env.HIDOCK_SETUP_DB_TEARDOWN_DATABASE

if (databasePath) {
  it('leaves the database open for setup-db teardown', () => {
    const db = new Database(databasePath)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES (\'open\')')

    expect(db.open).toBe(true)
  })
} else {
  it('only creates a database when invoked by the teardown cleanup test', () => {
    expect(databasePath).toBeUndefined()
  })
}
