// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('../database', () => ({ run: vi.fn(), queryOne: vi.fn() }))
import { providerCheckpoints, type CheckpointDatabase } from '../provider-checkpoints'

function adapter(db: DatabaseSync): CheckpointDatabase {
  return {
    run: (sql, params = []) => { db.prepare(sql).run(...params) },
    queryOne: <T>(sql: string, params: any[] = []) => db.prepare(sql).get(...params) as T | undefined
  }
}

describe('durable provider boundary', () => {
  it('does not persist the response when the recording becomes excluded during the request', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
      let allowed = true
      const store = providerCheckpoints('r', adapter(db), () => allowed)
      await expect(store.execute('analysis', async () => {
        allowed = false
        return { text: 'private response' }
      })).rejects.toThrow('discarded after exclusion')
      expect(db.prepare('SELECT state, response_json FROM provider_checkpoints').get()).toMatchObject({
        state: 'pending', response_json: null
      })
    } finally { db.close() }
  })
  it('reopens SQLite after downstream validation fails without calling the provider again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-checkpoint-'))
    let db = new DatabaseSync(join(dir, 'test.db'))
    try {
      db.exec('CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES (\'r\')')
      const paidCall = vi.fn(async () => ({ text: 'invalid timestamps', usage: 42 }))
      const first = providerCheckpoints('r', adapter(db))
      expect(await first.execute('audio/model/chunk', paidCall)).toEqual({ text: 'invalid timestamps', usage: 42 })
      db.close()
      db = new DatabaseSync(join(dir, 'test.db'))
      const resumed = providerCheckpoints('r', adapter(db))
      expect(await resumed.execute('audio/model/chunk', paidCall)).toEqual({ text: 'invalid timestamps', usage: 42 })
      expect(paidCall).toHaveBeenCalledTimes(1)
      db.exec("DELETE FROM recordings WHERE id = 'r'")
      expect(db.prepare('SELECT COUNT(*) AS n FROM provider_checkpoints').get()?.n).toBe(0)
    } finally { db.close(); rmSync(dir, { recursive: true }) }
  })

  it('holds uncertain failures instead of issuing a duplicate request', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
      const store = providerCheckpoints('r', adapter(db))
      const request = vi.fn(async () => { throw new Error('connection lost') })
      await expect(store.execute('key', request)).rejects.toThrow('connection lost')
      await expect(store.execute('key', request)).rejects.toThrow('outcome unknown')
      expect(request).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })
})
