// A checkpoint worker whose thread exits as its second checkpoint starts.
// The engine test kills a whole process mid-checkpoint separately
// (wal-crash-writer.mjs); this one covers the thread dying on its own.
import process from 'node:process'
import Database from 'better-sqlite3'
import { runWalCheckpointWorker } from '../../src/wal-checkpointer.ts'

let checkpoints = 0
function DyingDatabase(path, options) {
  const db = new Database(path, options)
  const pragma = db.pragma.bind(db)
  db.pragma = (source, pragmaOptions) => {
    if (source.startsWith('wal_checkpoint') && ++checkpoints === 2) process.exit(7)
    return pragma(source, pragmaOptions)
  }
  return db
}

runWalCheckpointWorker(DyingDatabase)
