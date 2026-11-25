// Worker thread entry: runs the library's WAL checkpoints on its own
// connection so a checkpoint's file sync never holds the main thread.
// Started by services/wal-checkpoint-host.ts; built as its own entry
// (electron.vite.config.ts) next to index.js.
import Database from 'better-sqlite3'
import { runWalCheckpointWorker } from '@hidock/database'

runWalCheckpointWorker(Database)
