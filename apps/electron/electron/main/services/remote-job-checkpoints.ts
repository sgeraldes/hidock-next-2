import { queryAll, queryOne, run } from './database'
import type { RemoteJobIdentity, RemoteJobStore } from './remote-worker-jobs'

export const REMOTE_JOB_SCHEMA = `CREATE TABLE IF NOT EXISTS remote_job_checkpoints (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL, identity_json TEXT NOT NULL,
  PRIMARY KEY(recording_id, request_key)
)`
export const REMOTE_RESULT_SCHEMA = `CREATE TABLE IF NOT EXISTS remote_job_results (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(recording_id, request_key)
)`
export function remoteJobCheckpoints(recordingId: string): RemoteJobStore {
  run(REMOTE_JOB_SCHEMA)
  run(REMOTE_RESULT_SCHEMA)
  return {
    loadResult(key) {
      const row = queryOne<{ result_json: string }>('SELECT result_json FROM remote_job_results WHERE recording_id=? AND request_key=?', [recordingId, key])
      return row ? JSON.parse(row.result_json) : undefined
    },
    saveResult(key, result) {
      run('INSERT OR REPLACE INTO remote_job_results VALUES (?, ?, ?)', [recordingId, key, JSON.stringify(result)])
    },
    load(key) {
      const row = queryOne<{ identity_json: string }>(
        'SELECT identity_json FROM remote_job_checkpoints WHERE recording_id = ? AND request_key = ?', [recordingId, key])
      return row ? JSON.parse(row.identity_json) as RemoteJobIdentity : undefined
    },
    save(key, identity) {
      run('INSERT OR REPLACE INTO remote_job_checkpoints VALUES (?, ?, ?)', [recordingId, key, JSON.stringify(identity)])
    }
  }
}

/** User intent only; the client must still confirm terminal state with the host. */
export function requestRemoteJobRestart(recordingId: string): void {
  run(REMOTE_JOB_SCHEMA)
  for (const row of queryAll<{ request_key: string; identity_json: string }>(
    'SELECT request_key, identity_json FROM remote_job_checkpoints WHERE recording_id = ?', [recordingId])) {
    const identity = JSON.parse(row.identity_json) as RemoteJobIdentity
    run('UPDATE remote_job_checkpoints SET identity_json = ? WHERE recording_id = ? AND request_key = ?',
      [JSON.stringify({ ...identity, restartTerminal: true }), recordingId, row.request_key])
  }
}

export function hasRemoteJobIdentity(recordingId: string): boolean {
  run(REMOTE_JOB_SCHEMA)
  return Boolean(queryOne('SELECT 1 FROM remote_job_checkpoints WHERE recording_id = ? LIMIT 1', [recordingId]))
}

export function listRecoverableRemoteJobs(): { recordingId: string; key: string; identity: RemoteJobIdentity }[] {
  run(REMOTE_JOB_SCHEMA)
  return queryAll<{ recording_id: string; request_key: string; identity_json: string }>(
    'SELECT recording_id, request_key, identity_json FROM remote_job_checkpoints').flatMap(row => {
      try {
        const identity = JSON.parse(row.identity_json) as RemoteJobIdentity
        return identity.id && identity.request && !['completed', 'failed', 'cancelled', 'interrupted'].includes(identity.observedStatus || '')
          ? [{ recordingId: row.recording_id, key: row.request_key, identity }] : []
      } catch { return [] }
    })
}

/** A fresh-transcription action can discard only proven completed remote work. */
export function clearCompletedRemoteCheckpoints(recordingId: string): void {
  run(REMOTE_JOB_SCHEMA)
  run(REMOTE_RESULT_SCHEMA)
  for (const row of queryAll<{ request_key: string; identity_json: string }>(
    'SELECT request_key, identity_json FROM remote_job_checkpoints WHERE recording_id=?', [recordingId])) {
    const identity = JSON.parse(row.identity_json) as RemoteJobIdentity
    if (identity.observedStatus !== 'completed') continue
    run('DELETE FROM remote_job_results WHERE recording_id=? AND request_key=?', [recordingId, row.request_key])
    run('DELETE FROM remote_job_checkpoints WHERE recording_id=? AND request_key=?', [recordingId, row.request_key])
  }
}
