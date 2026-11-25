import { join } from 'node:path'
import { createWorkerThreadWalCheckpointer, type WalCheckpointerFactory } from '@hidock/database'
import { getStartupState } from '../startup-state'

/** The bundled worker entry next to index.js, or null before startup set the runtime folder. */
export function resolveWalCheckpointWorkerPath(): string | null {
  const runtimeDir = getStartupState().runtimeDir
  return runtimeDir ? join(runtimeDir, 'wal-checkpoint-worker.js') : null
}

/**
 * Runs the library's WAL checkpoints on a worker thread (see
 * packages/database/src/wal-checkpointer.ts). Without a runtime folder (unit
 * tests that import the database module directly) there is no bundled worker
 * to start, and the engine keeps SQLite's automatic checkpoint.
 */
export const createWalCheckpointer: WalCheckpointerFactory = (dbPath, events) => {
  const workerPath = resolveWalCheckpointWorkerPath()
  if (!workerPath) return null
  return createWorkerThreadWalCheckpointer({ workerPath, dbPath, events })
}
