// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('../database', () => ({ run: vi.fn(), queryOne: vi.fn() }))
import { checkpointStage, audioFingerprint } from '../stage-checkpoints'
const adapt = (db: DatabaseSync) => ({
  run: (sql: string, params: any[] = []) => { db.prepare(sql).run(...params) },
  queryOne: <T>(sql: string, params: any[] = []) => db.prepare(sql).get(...params) as T | undefined
})
it('resumes completed local ASR and analysis after a database reopen, and invalidates changed input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hidock-stage-checkpoint-'))
  let db = new DatabaseSync(join(directory, 'test.sqlite'))
  try {
    db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
    const audio = join(directory, 'sample.wav')
    writeFileSync(audio, 'first input')
    const firstHash = await audioFingerprint(audio, () => true)
    const worker = vi.fn(async () => ({ text: 'saved text', speakers: [] }))
    await checkpointStage('r', 'transcription', firstHash, worker, () => true, adapt(db))
    db.close(); db = new DatabaseSync(join(directory, 'test.sqlite'))
    expect(await checkpointStage('r', 'transcription', firstHash, worker, () => true, adapt(db))).toEqual({ text: 'saved text', speakers: [] })
    expect(worker).toHaveBeenCalledOnce()
    writeFileSync(audio, 'new input')
    const secondHash = await audioFingerprint(audio, () => true)
    expect(secondHash).not.toBe(firstHash)
    await checkpointStage('r', 'transcription', secondHash, worker, () => true, adapt(db))
    expect(worker).toHaveBeenCalledTimes(2)
    db.exec("DELETE FROM recordings WHERE id='r'")
    expect(db.prepare('SELECT COUNT(*) AS n FROM stage_checkpoints').get()?.n).toBe(0)
  } finally { db.close(); rmSync(directory, { recursive: true }) }
})
it('does not resurrect a checkpoint after exclusion during inference', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES ('r')")
    let allowed = true
    await expect(checkpointStage('r', 'transcription', 'hash', async () => { allowed = false; return 'text' },
      () => allowed, adapt(db))).rejects.toThrow('cancelled')
    expect(db.prepare('SELECT COUNT(*) AS n FROM stage_checkpoints').get()?.n).toBe(0)
  } finally { db.close() }
})
