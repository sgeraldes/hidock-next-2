# The database in its own process

Date: 27-nov-2026. Status: design; PR 1 in progress on `feat/db-utility-process`. Approved by the owner as an architecture change.

## The request

Move the SQLite database out of the Electron main process into an Electron `utilityProcess`, so the window never waits on disk. The process owns the one better-sqlite3 connection; main talks to it over a message port with a typed request and response API; transactions run inside the process as named operations.

## Why the cheaper fixes were dropped

Every write runs on the main thread. When a COMMIT crosses the WAL's automatic checkpoint threshold, the same call copies the WAL into the database file and syncs both, and the window waits for it. Measured on the 2,150-transcript fixture with synchronous NORMAL (how the app opens the library), the worst main-thread hold reached 378.3 ms on origin/main (G:\Code\_briefing\dod\2026-11-26-hidock-write-batching\fixture-rounds.md).

| Fix tried | Result | Record |
|---|---|---|
| Checkpoints on a worker thread with its own connection | Back to back, the worst 1 MB commit on F: was 1,093.8 / 510.3 / 207.7 ms against 37.1 / 192.2 / 404.4 ms on main. Dropped. | `G:\Code\_briefing\dod\2026-11-25-hidock-wal\freeze-numbers.md`, PR #197 |
| wal_autocheckpoint 0 plus the worker | The WAL never starts over under continuous commits: past 300 MB in 8 s | same |
| Committing the background passes a slice at a time | Halves the passes' total time, does not lower the worst hold (rounds 13-15: 41, 68, 22 holds of 50 ms or more on main against 75, 52, 43) | `G:\Code\_briefing\dod\2026-11-26-hidock-write-batching\numbers.md`, PR #199 |
| Checkpoint tuning (64, 128, 1000 pages; journal_size_limit; checkpoint in its own turn) | None lowered the worst case | same |

The cost that matters is the checkpoint's file sync, and a synchronous call on the main thread waits for it however the work is cut. The checkpoint worker of #197 moved only the checkpoint: commits stayed on main, and a commit still waited for the worker's sync or ran the backstop checkpoint itself. The window stops waiting only when every call that can sync runs elsewhere and main waits on a message. A utility process gives that plus crash isolation (a native fault in SQLite cannot take the window down) and its own scheduling priority.

## What the code does now (origin/main 199a0650)

### Database access, counted

Counted by `coord\tmp\feat-db-utility-process\map-calls.mjs` over `apps/electron/electron/main`, test files excluded.

| What | Count |
|---|---|
| `services/database.ts` | 14,946 lines, 372 exports, 285 exported functions (10 async) |
| Files outside `database.ts` that import it | 101 (plus 3 dynamic imports) |
| Synchronous call sites into `database.ts` from those files | 1,633 |
| Distinct `database.ts` functions called from outside | 236 |
| Raw SQL helpers among those calls | `run` 231, `queryOne` 219, `queryAll` 212, `runNoSave` 68, `getDatabase()` 37, `saveDatabase` 21, `getRowsModified` 4, `runMany` 1 |
| Transactions inside `database.ts` (`runInTransaction`, `runDurableTransaction`) | 47 |
| Transactions with a callback outside `database.ts` | 80 in 29 files (org-reconciler 18, knowledge-graph-service 10, retrieval-traces 4 on its own file, knowledge-capture-backfill 4, download-service 4, assistant-handlers 4, ...) |
| Comments that rely on main-thread atomicity ("nothing can interleave", "race-free") | 25 |
| `ipcMain.handle` / `ipcMain.on` registrations | 508 |
| Files with the most call sites | transcription.ts 260, org-reconciler.ts 130, knowledge-graph-service.ts 128, integrity-service.ts 68, recording-handlers.ts 44, download-service.ts 36, projects-handlers.ts 35 |

Other SQLite users: `retrieval-traces.ts` has its own `DatabaseEngine` on its own file (traces); `sqlite-backup-worker.ts` already runs the backup copy in a utility process; `brain-host.ts` opens the library read-only in the headless brain.

### The engine (packages/database, bundled from source)

`DatabaseEngine` holds one better-sqlite3 connection: WAL, synchronous NORMAL, foreign keys ON, busy_timeout 5000. Its boot runs in four phases (core tables, repair, migrations, full schema) after the pre-migration snapshot. Every call is synchronous.

### Module state that lives next to the connection

| State | Where | Who reads it |
|---|---|---|
| `ownedProcessingRuns`, `ownedPipelineRuns` | database.ts | queue UI, `getOwnedPipelineRecordings` |
| `registerProcessingRun` (AsyncLocalStorage scope) | processing-run-scope.ts | transcription pipeline |
| `_graphProvenanceCleanup` callback | database.ts, set by knowledge-graph-service | deletion cascade |
| `organizationCheckpointUsers` (wal_autocheckpoint 128 while passes run) | database.ts | org reconciler, passes |
| Domain events (`getEventBus().emitDomainEvent`) | event-bus.ts | renderer, graph sync, queue |
| config, quality rules | config.ts, quality-rules.ts | value thresholds, eligibility |
| `backfillTail`, `reconciliationRunning`, wiki session state | pass modules | the passes themselves |

## Design

### The process

- New entry `electron/main/database-process.ts`, bundled by electron-vite next to `sqlite-backup-worker`. Main forks it with `utilityProcess.fork(path, [], { serviceName: 'HiDock Database' })` and talks over `child.postMessage` and `process.parentPort` (a MessagePortMain; structured clone, so Map, Set, Date, Uint8Array and Error fields pass).
- The process imports the same `services/database.ts` and the pass modules. One code base, no second implementation of any rule.
- What the process cannot do itself it asks main for: the backup copy (main still forks `sqlite-backup-worker`, so a multi-gigabyte copy never blocks database requests), and nothing else in PR 1 and 2. It never reads secrets: config arrives as a snapshot without credentials.
- `electron` in a utility process has no `app` or `safeStorage`. The modules the process loads touch them only through `config.ts` and `brain-credential-store.ts`; the process seeds config from the snapshot before anything reads it, and never calls the credential store.

### The protocol

```ts
// main -> process
{ type: 'init', config: ConfigSnapshot, appVersion: string, mode: DatabaseProcessMode }
{ type: 'call', id: number, op: OperationName, args: unknown[] }
{ type: 'config', config: ConfigSnapshot }
{ type: 'backup-result', id: number, ok: boolean, error?: string }
{ type: 'close' }
// process -> main
{ type: 'ready', schemaVersion: number }
{ type: 'boot-progress', progress: BootProgress }
{ type: 'result', id: number, ok: true, value: unknown }
{ type: 'result', id: number, ok: false, error: { name: string; message: string; stack?: string } }
{ type: 'event', event: DomainEvent }
{ type: 'backup-request', id: number, request: SqliteBackupRequest }
{ type: 'backup-progress', id: number, progress: SqliteBackupProgress }
{ type: 'closed' }
```

Errors keep their name. The client rebuilds the app's error classes that callers test with `instanceof` (`MassDeleteError`, `SchemaBehindError`, `DismissDiscoveredError`, `MergeOrderConflictError`, `EntityVisibilityUnavailableError`); any other error comes back as an `Error` with the same name and message.

### The typed client

```ts
const value = await databaseClient.call('getRecordingById', id)   // Promise<Recording | undefined>
```

`OperationName` and the argument and result types come from the operation registry (`database-operations.ts`), so a renamed function or a changed signature fails the typecheck on both sides. The registry exports every `database.ts` function whose arguments and result can be cloned, plus named operations. Functions that take a callback (`runInTransaction`, `runDurableTransaction`, `runWithMassDeleteAllowed`, `setGraphProvenanceCleanup`, `ambiguousBucketBatches`) are not operations and the type filter refuses them.

The client has two modes behind one API. In-process mode calls the registry function directly and returns its result in a resolved promise; process mode sends the request. Code converted to `await databaseClient.call(...)` works in both, so each PR converts callers without changing behaviour, and the flag decides where they run.

### Transactions are named operations

A callback transaction outside `database.ts` (80 sites) never crosses the boundary. Each becomes one function in the module that owns the logic, registered as an operation, and runs whole inside the process: BEGIN, every statement and COMMIT in one request. The same rule covers the 25 places that rely on main-thread atomicity: a read and the write that depends on it are one operation. A reviewer rejects an `await` between a read and its dependent write across two calls.

### The background passes run inside the process

The passes are where commits arrive back to back and checkpoints fire. In the process they keep `mainThreadBudget`'s 20 ms slices; between slices the process's event loop answers requests, so a UI request waits at most one slice plus one commit, and the window waits for nothing. Main asks for a pass as one operation (`runPass('transcript-validity')`) and receives its result; progress and domain events come back as messages.

Passes that call AI providers or the embedder (evaluation catch-up, kind fallback, sampling, summary heal, RAG ingest) stay in main and call operations for their reads and writes: their time goes to the network, and they need secrets the process does not have.

### Hot UI reads

The renderer already waits on `ipcMain.handle` promises, so a handler that awaits an operation changes nothing the renderer sees. Main's cost per request is one message and the clone of the result. The plan for reads on hot paths:

1. Loops that read one row per id (getRecordingById has 58 call sites) become one batched call (`getRecordingsByIds`, `getTranscriptsByRecordingIds`, `getMeetingsByIds` exist already).
2. The Library list and other large lists are measured as messages (clone time on main for 2,150 rows). If one costs main more than 10 ms, it gets a renderer port: main creates a `MessageChannelMain`, hands one end to the process and one to the renderer, and a fixed list of read-only list operations goes from the renderer to the process without passing through main.
3. A small read cache in main only where a value is read many times per second and changes rarely (processing revision, eligibility exclusions), invalidated by a `db:changed` message the process sends after each committed write that touches the cached tables.

### Guarantees that must survive

| Guarantee | How it survives |
|---|---|
| Pre-migration snapshot and audit row (#173, #194) | The process runs `initializeDatabase` with the same engine; the snapshot is still made before any schema change. The copy runs in the backup worker that main forks on the process's request; progress goes to the splash. |
| ENGINE_SAFETY_VERSION | `checkEngineSafety` runs in the process inside `initializeDatabase`, unchanged. The process refuses to start on an old engine and main shows the same failure. |
| Durable tables synced FULL (#199) | Same engine configuration; deletion operations run whole in the process with `runDurableTransaction`. |
| Deletion origin (#194, v74) | `assertDeletionRequest` stays inside the deletion functions; they run whole as operations. |
| Migration on start | Exactly one runner: the process boots the schema first. While main still has a connection (PR 1 to 3), main opens after the process is ready with `initializeExistingWritable()`, which refuses any version other than the exact one and runs no DDL. |
| Process crash | SQLite commits are atomic: a crash loses no committed transaction (the WAL is in the OS cache; a power cut loses at most what synchronous NORMAL already allows, and nothing durable). Main sees the exit, rejects in-flight requests with `DatabaseProcessExitedError` (a write's outcome is unknown, so callers re-read), restarts the process (1 s, 2 s, 5 s; more than five exits in a minute is fatal and says so), and queues new requests while it restarts. A test kills the process in the middle of a pass and checks every acknowledged write and `integrity_check`. |
| Shutdown with a TRUNCATE checkpoint | Quit sends `close`; the process runs `closeDatabase()` (TRUNCATE checkpoint) and answers `closed`, then exits. Main waits up to 15 s, then kills it; the WAL is then recovered on the next open, nothing lost. |
| One instance | The single-instance lock stays in main and is taken before the process is forked. |
| Headless brain | brain-host keeps opening read-only in its own process; unchanged. |

### Checkpoints while two connections exist (PR 2 and 3)

Until PR 4, main keeps its connection for code not converted yet. Both connections write the same WAL file. Main's connection runs with `wal_autocheckpoint = 0`, so a main commit never checkpoints; the process's connection keeps the automatic checkpoint, which also starts the WAL over, since it is the connection that writes back to back. When main writes and the process is idle, the process runs a PASSIVE checkpoint once the WAL passes 1,000 pages (a timer in the process; PASSIVE takes no writer lock). A main write that meets a process transaction waits for that transaction's lock (busy_timeout); passes commit one unit at a time (3 to 13 ms measured), so the wait is bounded by one unit, and this wait is measured in PR 2.

### The flag

`HIDOCK_DATABASE_PROCESS` (environment) and `database.process` (config): `off` (every call in main, today's behaviour), `passes` (process owns the boot and the background passes; main keeps a connection for the rest), `all` (process owns every call; main has no connection). PR 4 removes `off` and `passes`.

## Acceptance numbers

The 2,150-transcript background fixture (`background-pass-responsiveness.test.ts`) with checkpoints on (`HIDOCK_FIXTURE_SYNC=normal`, synchronous NORMAL as the app opens the library), temp folder on each disk, three runs per disk, one run at a time under lowrun:

- worst main-thread hold under 50 ms in every run, on C: (Crucial T700), G: (Samsung 980) and F:\wal-bench (the library's disk);
- no committed write lost when the process is killed mid-pass; integrity_check ok;
- the full suite, typecheck and eslint green; CI `validate` green.

Numbers before and after each PR go to `G:\Code\_briefing\dod\2026-11-27-hidock-db-process\`.

## PRs

Each PR ships working code, runs the whole suite, CI, a claude2kiro review and CodeRabbit, and merges squashed.

1. The process, the protocol, the host (fork, restart, close), the typed client with both modes, the operation registry (every cloneable `database.ts` function), the backup request path, event forwarding, the fixture's measurement knobs. Flag default `off`: nothing in the app changes. Tests: protocol and error names over a real child process, crash during writes, restart, close with TRUNCATE, migration in the process with snapshot and audit row, ENGINE_SAFETY refusal. An Electron runtime check (no window) that the bundled entry loads better-sqlite3 in a real `utilityProcess`.
2. Mode `passes`: the process boots the schema; main opens with `initializeExistingWritable` and `wal_autocheckpoint = 0`; the background passes (integrity, validity, knowledge captures, evaluation warnings, meeting wiki, stale auto-link repair, organization reconciliation with its validity follow-up) run in the process from boot tasks and from the Settings and Library buttons that start them. Fixture measured in this mode on the three disks.
3. Mode `all`, area by area (3a recordings and Library, 3b transcription pipeline and queue, 3c people, projects and graph, 3d the rest): callers converted to `await databaseClient.call`, callback transactions turned into named operations, batched reads, the renderer port for the lists that need it, processing-run state and the graph cleanup callback moved into the process.
4. Default `all`; main's connection, the flag and the in-process mode removed.

## Risks

- A converted caller that kept a read and its dependent write as two calls can interleave with another request. Mitigation: the transaction rule above, reviewed per PR; the 25 atomicity comments are a checklist.
- Structured clone cost on main for large results. Mitigation: measured per list; renderer port where needed.
- Module caches in main that the process's writes make stale while two connections exist. Mitigation: only passes move in PR 2, and they write tables main does not cache; PR 3 inventories caches with the `db:changed` message.
- A crash mid-request leaves a write's outcome unknown. Mitigation: callers re-read; operations that must not run twice check their own state first (the passes already do: each re-reads what is stale).
