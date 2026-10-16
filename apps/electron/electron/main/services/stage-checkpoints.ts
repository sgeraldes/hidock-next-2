import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { queryOne, run } from './database'
import { TranscriptionCancelledError } from '@hidock/transcription'

export const STAGE_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS stage_checkpoints (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
  completed_at TEXT NOT NULL, PRIMARY KEY(recording_id, stage, fingerprint)
)`
export function stageFingerprint(...inputs: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}
export async function audioFingerprint(path: string, shouldContinue: () => boolean): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (!shouldContinue()) throw new TranscriptionCancelledError('Local processing cancelled')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** Fresh transcription clears these checkpoints explicitly; a restart reuses completed stages. */
export async function checkpointStage<T>(recordingId: string, stage: string, fingerprint: string,
  action: () => Promise<T>, shouldContinue: () => boolean,
  db: { run: typeof run; queryOne: typeof queryOne } = { run, queryOne }): Promise<T> {
  if (!shouldContinue()) throw new TranscriptionCancelledError('Local processing cancelled')
  db.run(STAGE_CHECKPOINT_SCHEMA)
  const saved = db.queryOne<{ result_json: string }>(
    'SELECT result_json FROM stage_checkpoints WHERE recording_id = ? AND stage = ? AND fingerprint = ?',
    [recordingId, stage, fingerprint])
  if (saved) return JSON.parse(saved.result_json) as T
  const result = await action()
  if (!shouldContinue()) throw new TranscriptionCancelledError('Local processing cancelled')
  db.run('INSERT OR REPLACE INTO stage_checkpoints VALUES (?, ?, ?, ?, ?)',
    [recordingId, stage, fingerprint, JSON.stringify(result), new Date().toISOString()])
  return result
}

export function readStageCheckpoint<T>(recordingId: string, stage: string, fingerprint: string): T | undefined {
  run(STAGE_CHECKPOINT_SCHEMA)
  const row = queryOne<{ result_json: string }>(
    'SELECT result_json FROM stage_checkpoints WHERE recording_id=? AND stage=? AND fingerprint=?',
    [recordingId, stage, fingerprint])
  return row ? JSON.parse(row.result_json) as T : undefined
}
export function saveStageCheckpoint(recordingId: string, stage: string, fingerprint: string, result: unknown): void {
  run(STAGE_CHECKPOINT_SCHEMA)
  run('INSERT OR REPLACE INTO stage_checkpoints VALUES (?, ?, ?, ?, ?)',
    [recordingId, stage, fingerprint, JSON.stringify(result), new Date().toISOString()])
}
