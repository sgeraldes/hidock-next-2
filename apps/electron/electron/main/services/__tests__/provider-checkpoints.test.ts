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

  it('forgets a request the provider rejected, so a retry may send it again (27-oct-2026)', async () => {
    // A 429 is an answer: the provider refused and processed nothing. Keeping it
    // pending made every retry fail with "outcome unknown" (Rec14, Rec16).
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
      const store = providerCheckpoints('r', adapter(db))
      const quota = Object.assign(new Error('429 Rate limit exceeded for model gemini-3.5-transcribe. Please retry in 52s'), { status: 429 })
      const request = vi.fn().mockRejectedValueOnce(quota).mockResolvedValueOnce({ text: 'hola' })
      await expect(store.execute('span-2', request)).rejects.toThrow('429')
      expect(db.prepare('SELECT COUNT(*) AS n FROM provider_checkpoints').get()).toMatchObject({ n: 0 })
      expect(await store.execute('span-2', request)).toEqual({ text: 'hola' })
      expect(request).toHaveBeenCalledTimes(2)
    } finally { db.close() }
  })

  it('forgets a request Google refused because the model was overloaded (27-oct-2026)', async () => {
    // "[503 Service Unavailable] This model is currently experiencing high demand"
    // is a refusal at the door; keeping it pending blocked every later summary.
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
      const store = providerCheckpoints('r', adapter(db))
      const overloaded = new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.')
      const request = vi.fn().mockRejectedValueOnce(overloaded).mockResolvedValueOnce({ summary: 'ok' })
      await expect(store.execute('analysis', request)).rejects.toThrow('high demand')
      expect(await store.execute('analysis', request)).toEqual({ summary: 'ok' })
      expect(request).toHaveBeenCalledTimes(2)
    } finally { db.close() }
  })

  it('keeps a request pending when the outcome is unknown (network cut, server error)', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
      const store = providerCheckpoints('r', adapter(db))
      // 408 and 499 can arrive after the server ran (and billed) the request, and a
      // message that merely starts with a 4xx code proves nothing (review of #186).
      for (const failure of [
        new Error('fetch failed'),
        Object.assign(new Error('503 Service Unavailable'), { status: 503 }),
        Object.assign(new Error('408 Request Timeout'), { status: 408 }),
        Object.assign(new Error('499 Client Closed Request'), { status: 499 }),
        new Error('400 entries could not be parsed from the response'),
      ]) {
        const key = failure.message
        const request = vi.fn().mockRejectedValue(failure)
        await expect(store.execute(key, request)).rejects.toThrow(failure.message)
        await expect(store.execute(key, request)).rejects.toThrow('outcome unknown')
        expect(request).toHaveBeenCalledTimes(1)
      }
    } finally { db.close() }
  })
})
