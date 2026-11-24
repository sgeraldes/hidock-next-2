/**
 * The attempt log of the engine chain (table transcription_attempts, v73).
 * One row per engine try, written as the try ends, so a crash in the middle of
 * a chain still leaves what was tried and why it failed.
 */

import { queryAll, run } from './database'
import type { EngineAttempt } from './transcription-engine-chain'

export interface StoredTranscriptionAttempt extends EngineAttempt {
  queueItemId: string | null
}

/** Longest provider message kept per attempt; the full text is in the app log. */
const MAX_MESSAGE_CHARS = 2000

export function recordTranscriptionAttempt(recordingId: string, queueItemId: string | null, attempt: EngineAttempt): void {
  run(
    `INSERT INTO transcription_attempts
       (recording_id, queue_item_id, engine, attempt, outcome, error_class, message, started_at, duration_ms, waited_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      recordingId,
      queueItemId,
      attempt.engine,
      attempt.attempt,
      attempt.outcome,
      attempt.errorClass ?? null,
      attempt.message ? attempt.message.slice(0, MAX_MESSAGE_CHARS) : null,
      attempt.startedAt,
      Math.max(0, Math.round(attempt.durationMs)),
      Math.max(0, Math.round(attempt.waitedSeconds)),
    ]
  )
}

/** Attempts for one recording, oldest first. `limit` keeps the most recent ones. */
export function getTranscriptionAttempts(recordingId: string, limit = 50): StoredTranscriptionAttempt[] {
  const rows = queryAll<{
    queue_item_id: string | null; engine: string; attempt: number; outcome: EngineAttempt['outcome']
    error_class: EngineAttempt['errorClass'] | null; message: string | null; started_at: string
    duration_ms: number; waited_seconds: number
  }>(
    `SELECT * FROM (
       SELECT queue_item_id, engine, attempt, outcome, error_class, message, started_at, duration_ms, waited_seconds, id
       FROM transcription_attempts WHERE recording_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
    [recordingId, Math.max(1, Math.min(500, Math.floor(limit)))]
  )
  return rows.map((row) => ({
    queueItemId: row.queue_item_id,
    engine: row.engine,
    attempt: row.attempt,
    outcome: row.outcome,
    ...(row.error_class ? { errorClass: row.error_class } : {}),
    ...(row.message ? { message: row.message } : {}),
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    waitedSeconds: row.waited_seconds,
  }))
}
