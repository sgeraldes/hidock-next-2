# Incremental source-slice reindexing

Date: 4 October 2026. Status: proposed design; depends on adoption 1.

## Problem

`apps/electron/electron/main/services/note-intelligence.ts:145` serializes indexing per note.
Its `indexNoteOnce` at line 159 finds previous vector rows for that note.
It creates a new document before deleting old SQL rows at line 184.
This already replaces a note's persisted vector slice; it is not a global rebuild.
That path does not define a cross-index generation contract for FTS and vectors.
`apps/electron/electron/main/services/vector-store.ts:313` owns its lazy vector table.
Its cached index uses lazy text hydration (`vector-store.ts:395`).
SQL replacement alone must also update or invalidate the resident vector index.
The exact existing vector invalidation API is to verify before implementation.

`apps/electron/electron/main/services/notes.ts:107` computes content fingerprints.
`apps/electron/electron/main/services/database.ts:5946` removes recording vector rows.
Deletion and eligibility changes already affect derived content and need the same consistency contract.
The supplied corpus has about 2,100 recordings and 240,000 chunks.
Rebuilding that corpus after one note edit would be wasteful.
This spec extends existing per-source indexing with atomic publication and durable recovery.

## What the open-source project does

SilverBullet's `plugs/index/indexer.ts:217` defines `indexPage`.
At lines 233 and 241 it calls `index.indexObjects(name, objects)` for one page.
The page is the unit of replacement, including its extracted objects.
Take source ownership and replace-one-slice semantics.
HiDock's derived indexes include asynchronous embeddings and a SQLite FTS index.
Add revision checks, staging generations and a durable queue for that boundary.
Do not import SilverBullet's KV store, scripting runtime or full indexer set.

SilverBullet is MIT, Copyright 2022 Zef Hemel (`LICENSE.md`).
Copied or adapted implementation must preserve its copyright and permission notice.
Record the design inspiration for an independent TypeScript implementation.
No upstream runtime or dependency is added by this document.

## Goals and non-goals

- Reindex one changed recording or note without scanning unrelated chunk bodies.
- Publish internally complete lexical slices and version-compatible vector slices.
- Keep the previous usable generation when embedding or parsing fails.
- Supersede stale jobs when an edit arrives during indexing.
- Reconcile SQL and resident vector state after publication or crash.
- Index lexical text when embeddings are unavailable.
- Preserve provider/dimension partitions and eligibility gates.
- Exclude full-library startup rebuilds and automatic cloud re-embedding.
- Exclude changing chunk boundaries, embedding models or transcription validity logic.
- Keep canonical authored data authoritative; all search slices remain derived.

## Design

### Data model and migration

Use adoption 1's proposed `search_documents` source keys and generations.
The next migration adds `search_source_state` and `search_reindex_jobs`.
Source state uses `(source_kind, source_id)` as its primary key.
Store desired revision, active lexical generation and active vector generation per provider.
Also store context version, privacy revision, eligibility revision and last error.
The job table stores a unique source key, requested revision, reasons and priority.
Store state, lease owner, lease expiry, attempts, checkpoint and next retry time.
One pending row per source coalesces repeated changes into the latest revision.
Add staged canonical rows keyed by source, generation and chunk ordinal.
Use a proposed vector-generation mapping table to associate vector IDs with source revisions.
Migration must tolerate `vector_embeddings` being absent before vector initialization.
Create no foreign key or trigger requiring that lazy table during schema migration.
A runtime vector repository manages its generation mapping after initialization.
Staging is bounded and retained until publication or later explicit cleanup.
Schema installation performs no content or embedding backfill.

### Revision and event ownership

Revision hashes authored text, effective source title, source linkage and chunker version.
Context inputs from adoption 3 contribute their builder/input revision.
Privacy and eligibility revisions are checked independently at publication and retrieval.
Vector representation revision additionally includes provider, dimensions and embedding model.
A title-only change requests lexical/context replacement without body re-embedding.
A transcript edit requests both lexical and vector replacement for that source.
A note edit queues the existing note hook through this scheduler.
An empty source publishes an empty searchable slice.
Deletion or exclusion immediately suppresses reads and queues derived-state reconciliation.
The exact existing recording-change IPC hooks are to verify in the first integration PR.
Make each owner/transcript transaction enqueue its source event transactionally where possible.
For legacy callers, reconcile revision mismatches on demand and in an idle metadata pass.
Never rely solely on a volatile event emitter for durable indexing intent.

### Exact replacement flow

1. Coalesce a source event into its latest requested revision and reason mask.
2. After interactive readiness, lease one highest-priority eligible source job.
3. Read a consistent source snapshot and compute deterministic chunk keys.
4. Parse/chunk in bounded worker work; stage canonical rows outside the active generation.
5. Recheck source revision and lifecycle before lexical publication.
6. In one short transaction, replace that source's active `search_documents` slice.
7. FTS triggers remove OLD indexed text and insert NEW indexed text atomically.
8. Advance the lexical-generation marker in that same transaction.
9. Generate only changed embeddings permitted by provider and privacy policy.
10. Stage vector rows with canonical keys and actual provider/dimension labels.
11. Recheck source revision, eligibility and policy before vector publication.
12. Publish vector mapping and provider generation in one short transaction.
13. Invalidate or update the resident vector slice before making it servable.
14. Mark the job complete only after resident-state acknowledgement.
15. If a newer requested revision exists, retain the queue row and process it later.

Lexical publication does not wait for a cloud or unavailable embedding provider.
Vectors from an old body revision are suppressed after the new lexical body is active.
Title-only lexical changes may keep vectors when their representation revision remains valid.
Search can return lexical-only results while the new vector generation is pending.
RRF includes only vectors mapped to the current permitted body revision.
Reuse unchanged chunk embeddings by content hash within the same provider/model partition.
Do not reuse vectors across privacy-incompatible storage or provider changes.
An embedding failure retains the previous rows for recovery but never serves stale body evidence.
Show lexical-ready/vector-pending state; avoid a false fully indexed status.

### Crash and concurrency behavior

Source writes and publications use compare-and-swap revision checks.
Parsing or embedding never holds a DB transaction open across an await.
Expired leases become retryable during a small readiness check after UI startup.
The actual content job starts only when idle; startup checks read queue metadata only.
On crash after SQL commit but before resident acknowledgement, suppress that stale resident slice.
Reload only the affected vector generation on the next read or idle recovery.
Resume staging only if its source/model revisions still match.
Obsolete generations are unreachable through active markers.
Bound pending/staged bytes to 128 MiB; stop accepting additional heavy work at the bound.
Use retry delays of 30 seconds, 2 minutes and 10 minutes, then expose manual retry.
Coalesced foreground edits outrank historical backfill, without running more than one heavy job.

### Settings

Add proposed `search.incrementalReindexEnabled=false` during rollout.
Persist in `<userData>\config.json` (`services/config.ts:491`).
Expose source-level lexical/vector status, last error and manual retry in index diagnostics.
Keep batch sizes, retry schedule and lease duration internal.
Provide Pause background indexing; it does not make stale generations eligible.
When disabled, existing indexing stays available and adoption 1 detects stale sources conservatively.
Do not schedule a global rebuild as the disable fallback.

## Performance and leanness budget

Targets below are incremental over adoption 1; measure them on the full library.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=16 MiB steady; <=64 MiB active source peak | RSS/heap delta, largest recording and note |
| Startup overhead | <=5 ms p95 metadata only | 20 cold/warm starts with pending/expired jobs |
| Search regression | <=10 ms added p95 during replacement | 100 EN/ES queries on 240,000 chunks |
| Lexical publication | <=10 ms p95 transaction; <=50 ms worst | Adapter transaction timing on largest slice |
| Added disk | <=128 MiB staging; <=10 MiB queue/state | Page and WAL deltas under edit storms |
| Event-loop delay | <=5 ms p95 added; <=8 ms job slices | Monitor while editing, searching and downloading |

Atomic replacement of a very large source may exceed the transaction limit.
If measured above 50 ms, switch canonical reads to generation-pointer publication
and maintain staged FTS rows filtered by active generation before release.
Do not claim yielding between transaction statements provides atomic responsiveness.
Start with one replacement transaction and measure the largest and typical sources in the first PR.
Add generation-pointer publication only when the largest-source transaction exceeds 50 ms.
One low-priority heavy parsing/embedding job runs at a time, shared with index backfills.
Main writer batches stage at most 250 chunks or 4 MiB, then `setImmediate` yields.
Pause for USB work, transcription, foreground generation and high event-loop delay.
No full chunk scan, vector reload or heavy queue replay runs at startup.
Measure paid embedding tokens for changed chunks; full-library cloud backfill requires a separate estimate.

## Test plan

Write these failing tests first.

- `reindex.one-source-only`: one edit leaves unrelated row hashes unchanged.
- `reindex.edit-during-embed`: stale model output cannot publish over the latest revision.
- `reindex.empty-slice`: clearing a note removes its searchable derived slice.
- `reindex.lexical-without-vectors`: provider outage still publishes current lexical text.
- `reindex.no-stale-body-vectors`: old body evidence never enters fused retrieval.
- `reindex.title-only-reuse`: title refresh makes zero body embedding calls.
- `reindex.provider-boundary`: content reuse cannot cross provider/model partitions.
- `reindex.crash-after-sql`: resident slice stays suppressed until acknowledgement.
- `reindex.coalesced-lease`: duplicate edits create one latest-revision queue row.
- `reindex.policy-change`: privacy tightening during work prevents publication/egress.
- `reindex.lazy-vector-table`: migration succeeds before vector initialization.

Use actual better-sqlite3, FTS triggers and the real vector cache API.
Force failures before lexical commit, before vector commit and before resident acknowledgement.
Reopen the DB after each failure and verify active generations and MATCH results.
Exercise real note saves and transcript updates through Electron IPC on disposable sources.
Run vector search after replacement and inspect returned text and canonical keys.
Compare row hashes of every unrelated source and retain the evidence.
Stress the largest source and full-corpus search against all budgets.

## Rollout

1. PR 1: generation/queue schema and failing publication/recovery tests after adoption 1.
2. PR 2: note integration and resident-cache acknowledgement behind the setting.
3. PR 3: recording/context events, embedding reuse and durable recovery.
4. PR 4: measured full-size rollout and removal of duplicate legacy scheduling paths.

Backfill state mappings from existing source metadata one source at a time.
Do not re-embed unchanged existing vectors solely to populate a mapping.
Unknown legacy mappings stay suppressed until reconciled or explicitly reindexed.
Start with ten edited notes and 20 recordings before the idle metadata pass.
Rollback disables the new scheduler and keeps current canonical slices and markers.
Resume the prior per-source path only after its cache invalidation contract is verified.
Retain jobs and staged rows; no authored-content deletion or schema downgrade is needed.

## Risks

FTS and vectors have different readiness times; UI and RRF must expose that truthfully.
Legacy vector chunk boundaries and invalidation APIs are to verify.
Large atomic SQL deletes can block the main thread despite bounded staging.

## Decisions taken

Source: [decision matrix](../../decisions/decisions.json).

6.1 — Publish lexical text immediately and vectors when available. Lexical search can show current text even during an embedding-provider outage.

6.2 — Reuse unchanged embeddings by hash. This avoids provider time and cost on every edit; the implementation plan must test hash and version boundaries.

6.3 — Start with one replacement transaction; add generation-pointer publication only if it measures above 50 ms. A transaction keeps the initial implementation simple and the pointer can be added later without migrating data. Medium confidence: the first PR times the largest source and switches to the pointer only if the 50 ms limit is exceeded.

## Order and migration

Follow the rollout dependencies above. Schema migration numbers are assigned at merge time; other branches also add migrations. Main is at v72 as of 5 October 2026, and this spec reserves no migration number.
