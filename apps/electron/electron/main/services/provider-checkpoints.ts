import { clearCompletedRemoteCheckpoints } from './remote-job-checkpoints'
import { createHash } from 'crypto'
import { queryOne, run } from './database'
import { STAGE_CHECKPOINT_SCHEMA } from './stage-checkpoints'

/** Provider responses stay with their recording and are removed by its hard purge. */
export const PROVIDER_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS provider_checkpoints (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'received')),
  response_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(recording_id, request_key)
)`

export interface CheckpointDatabase {
  run: typeof run
  queryOne: typeof queryOne
}

/**
 * Commit the intent BEFORE calling a paid provider. A lost response is an
 * uncertain charge, never permission to resend. Received responses are replayed
 * through the parser without invoking the provider again.
 */
export function providerCheckpoints(recordingId: string, db: CheckpointDatabase = { run, queryOne },
  shouldPersist: () => boolean = () => true) {
  db.run(PROVIDER_CHECKPOINT_SCHEMA)
  return {
    async execute<T>(key: string, request: () => Promise<T>): Promise<T> {
      if (!shouldPersist()) throw new Error('Local processing cancelled: recording is no longer eligible')
      const requestKey = createHash('sha256').update(key).digest('hex')
      const previous = db.queryOne<{ state: string; response_json: string | null }>(
        'SELECT state, response_json FROM provider_checkpoints WHERE recording_id = ? AND request_key = ?',
        [recordingId, requestKey]
      )
      if (previous?.state === 'received' && previous.response_json !== null) {
        return JSON.parse(previous.response_json) as T
      }
      if (previous) throw new Error('Provider checkpoint pending: previous request outcome unknown; explicit new transcription required')
      db.run(
        "INSERT INTO provider_checkpoints VALUES (?, ?, 'pending', NULL, ?)",
        [recordingId, requestKey, new Date().toISOString()]
      )
      let response: T
      try {
        response = await request()
      } catch (error) {
        // A 4xx is the provider's answer that it processed nothing (a 429 rate
        // limit, a bad request): nothing was charged, so a retry may send it
        // again. Anything else (a cut connection, a 5xx) stays pending, because
        // the request may have run and been billed (27-oct-2026).
        if (providerRejected(error)) {
          db.run('DELETE FROM provider_checkpoints WHERE recording_id = ? AND request_key = ? AND state = \'pending\'',
            [recordingId, requestKey])
        }
        throw error
      }
      if (!shouldPersist()) throw new Error('Local processing cancelled: provider response discarded after exclusion')
      const payload = JSON.stringify(response)
      if (payload === undefined) throw new Error('Provider checkpoint: empty response cannot be persisted')
      db.run(
        "UPDATE provider_checkpoints SET state = 'received', response_json = ?, updated_at = ? WHERE recording_id = ? AND request_key = ?",
        [payload, new Date().toISOString(), recordingId, requestKey]
      )
      return response
    }
  }
}

/**
 * Status codes a provider returns before it runs a request: a rate limit (429)
 * and a refused request (bad request, key, permission, unknown model). 408 and
 * 499 are left out: they can come after the server ran and billed the request.
 */
const REJECTED_BEFORE_RUNNING = new Set([400, 401, 403, 404, 429])

/** The provider refused the request and processed nothing, so it may be sent again. */
export function providerRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return REJECTED_BEFORE_RUNNING.has(status)
  // Without a status, only an unmistakable rate limit counts; any other text
  // that starts with a number proves nothing (review of #186, 27-oct-2026).
  const message = error instanceof Error ? error.message : String(error)
  return /^\s*(?:\[[^\]]*\]:?\s*)?429\s+(?:Too Many Requests|Rate limit exceeded)/i.test(message) ||
    /\bRESOURCE_EXHAUSTED\b/.test(message)
}

/** Only call from an explicit fresh-transcription action, never an automatic retry. */
export function clearProviderCheckpoints(recordingId: string): void {
  clearCompletedRemoteCheckpoints(recordingId)
  run(PROVIDER_CHECKPOINT_SCHEMA)
  run('DELETE FROM provider_checkpoints WHERE recording_id = ?', [recordingId])
  // Remote ownership survives a fresh local attempt. The host may still be
  // executing after a network timeout; discarding its identity would duplicate it.
  run(STAGE_CHECKPOINT_SCHEMA)
  run('DELETE FROM stage_checkpoints WHERE recording_id = ?', [recordingId])
}
