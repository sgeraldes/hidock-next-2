// Checkpoint worker entry for tests: the same body the app's bundled entry
// runs, loaded from source (Node strips the types).
import Database from 'better-sqlite3'
import { runWalCheckpointWorker } from '../../src/wal-checkpointer.ts'

runWalCheckpointWorker(Database)
