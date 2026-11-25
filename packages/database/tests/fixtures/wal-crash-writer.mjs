// A process that writes through the engine while the checkpoint worker runs
// as often as it can, so the parent can kill it in the middle of a checkpoint.
// Prints READY once the worker runs, ACK <n> after each committed batch and
// CKPT after each checkpoint. Node loads the engine source with type stripping.
import process from 'node:process'
import { setImmediate, setTimeout } from 'node:timers'
import Database from 'better-sqlite3'
import { DatabaseEngine } from '../../src/engine.ts'
import { createWorkerThreadWalCheckpointer } from '../../src/wal-checkpointer.ts'

const [dbPath, workerPath] = process.argv.slice(2)
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, batch INTEGER NOT NULL, body TEXT);
`
const say = (line) => process.stdout.write(`${line}\n`)
const engine = new DatabaseEngine({
  betterSqlite3: Database,
  dbPathProvider: () => dbPath,
  schemaVersion: 1,
  schema: SCHEMA,
  migrations: {},
  walCheckpointer: (path, events) => createWorkerThreadWalCheckpointer({
    workerPath,
    dbPath: path,
    tuning: { pollMs: 2, intervalMs: 0, growthBytes: 0 },
    events: { ...events, onCheckpoint: (result) => { events.onCheckpoint?.(result); say('CKPT') } },
  }),
})
await engine.initialize()
while (!engine.walCheckpointsOffMainThread()) await new Promise((resolve) => setTimeout(resolve, 5))
say('READY')
const body = 'x'.repeat(2000)
for (let batch = 0; ; batch++) {
  engine.runInTransaction(() => {
    for (let k = 0; k < 40; k++) engine.run('INSERT INTO items (id, batch, body) VALUES (?, ?, ?)', [`${batch}-${k}`, batch, body])
  })
  say(`ACK ${batch}`)
  await new Promise((resolve) => setImmediate(resolve))
}
