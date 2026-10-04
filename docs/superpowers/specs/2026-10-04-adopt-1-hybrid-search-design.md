# Hybrid search with FTS5 and Reciprocal Rank Fusion

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/rag.ts:1500` describes multi-term LIKE ranking.
`apps/electron/electron/main/services/rag.ts:1587` counts matching terms with CASE expressions.
`apps/electron/electron/main/services/rag.ts:1529` searches capture titles and summaries only.
The comment at line 1501 says FTS5 is unavailable in sql.js WASM.
The current connection is configured with better-sqlite3 at
`apps/electron/electron/main/services/database.ts:4267`.
The `SqlJsDatabase` name at `database.ts:4345` is a compatibility interface.
`packages/database/src/engine.ts:31` documents the facade over better-sqlite3.
`packages/database/src/engine.ts:435` implements parameterized exec through native prepare.
The installed binding's FTS5 availability was verified in the supplied research.
Repeat that probe through the app adapter in the implementation PR.

`apps/electron/electron/main/services/retrieval-orchestrator.ts:47` routes by intent.
Its `buildDigestsContext` at line 251 supplies structured meeting context.
Hybrid retrieval must preserve this routing and its source eligibility.
`apps/electron/electron/main/services/vector-store.ts:35` documents 237,920 chunks.
The acceptance corpus is about 2,100 recordings and 240,000 chunks, supplied by the owner.
Its current exact count, size and hardware performance are to verify on a consented snapshot.

## What the open-source project does

Laya uses `engine/laya/db/fts.py` for FTS tables and safe MATCH construction.
`engine/laya/retrieval.py` shares LIKE fallback and Reciprocal Rank Fusion.
It computes `sum(1 / (60 + rank))` with one-based ranks.
Its card UPDATE trigger names indexed columns to avoid unrelated reindexing.
Its tokenizer is `porter unicode61`; HiDock requires Spanish and English.
Take BM25, rank fusion, safe query construction and narrow triggers.
Use `unicode61 remove_diacritics 2` and prefix matching in HiDock.
Keep HiDock's vector store and provider partitions.
Leave Laya's ChromaDB and startup rebuild outside this adoption.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Any copied or adapted implementation must retain the license and relevant NOTICE.
Mark modified derived files and retain existing attribution notices.
Document conceptual inspiration even when implementing standard RRF independently.
Do not describe conceptual inspiration alone as a requirement to copy all upstream files.

## Goals and non-goals

- Find Spanish accented text and English prefixes through lexical ranking.
- Combine lexical and dense evidence without comparing their raw scores.
- Keep existing global search response groups and source visibility rules.
- Make text searchable before a vector provider is available.
- Preserve structured actions, digests, temporal grounding and citations.
- Provide useful search while backfill or FTS capability is unavailable.
- Avoid full text residency and a second database or search process.
- Exclude stemming, fuzzy spelling, reranking models and embedding replacement.
- Keep substring behavior in the fallback; disclose its different recall.
- Leave learned context lines to adoption 3 and replacement scheduling to adoption 6.

## Design

### Components and data model

Add a proposed lexical repository and pure RRF helper under main services.
These components do not exist yet; implementation filenames remain a PR choice.
Own a canonical `search_documents` table independently of vector availability.
Columns: integer `rowid`, unique `document_key`, `source_kind`, `source_id`.
Also store `chunk_ordinal`, `title`, `body`, `source_revision`, `generation`.
Keys use a typed source ID and chunk ordinal, independent of embedding provider.
Use an explicit mapping from existing vector IDs to canonical document keys.
A capture title/summary document has a distinct key from transcript chunks.
Notes get deterministic chunks from their full authored content.
People and projects get separate keyed title/body documents for grouped global results.
Do not equate a contact ID with a recording ID even when strings coincide.
Add source/generation indexes for bounded slice replacement.

The next migration creates the base table and an external-content `search_documents_fts`.
FTS columns are `title` and `body`, with `content='search_documents'`.
Set `content_rowid='rowid'` and `tokenize='unicode61 remove_diacritics 2'`.
Set prefix indexes to `2 3 4`; benchmark their space cost before rollout.
Keep IDs, revisions and lifecycle metadata outside tokenized columns.
INSERT triggers add the new row and DELETE triggers issue the FTS delete command.
UPDATE triggers use `AFTER UPDATE OF title, body` with a value-change guard.
Update by immutable rowid; issue FTS deletion using OLD text before inserting NEW text.
Source metadata updates alone must cause zero FTS writes.
Create no triggers against the lazily created `vector_embeddings` table.
If FTS creation fails specifically because the module is absent, keep the base table.
Record lexical capability as unavailable and complete the migration safely.
Other migration failures roll back; they are errors requiring repair.
Persist backfill checkpoints separately from schema completion.

### Exact retrieval flow

1. Normalize whitespace; cap input at 512 characters and 12 distinct terms.
2. Tokenize Unicode letters and numbers; retain short IDs as exact literals.
3. Escape double quotes and bind the generated MATCH expression as a parameter.
4. Prefix tokens of at least two characters with a trailing `*` outside quotes.
5. OR the terms for general search; never pass user FTS operators through.
6. Resolve intent and temporal range through the existing orchestrator.
7. Fetch lexical candidates ordered by ascending `bm25()`, then document key.
8. Fetch dense candidates only from the active provider/dimension partition.
9. Apply current source eligibility before assigning each list's ranks.
10. Map vector IDs to canonical keys; deduplicate within each list.
11. Fuse using one-based `sum(1/(60+rank))`, equal weight per retrieval method.
12. Break ties by best individual rank and then canonical key.
13. Apply the existing temporal policy explicitly after fusion; test its effect.
14. Hydrate only the final selected chunks and their citation metadata.
15. Recheck eligibility immediately before rendering or model prompt construction.

Use 100 candidates per method initially; paginate eligibility filtering to that count.
Stop by a 200 ms retrieval deadline and return a marked partial result if needed.
Avoid silently filling the final limit with excluded or stale documents.
For globalSearch, collapse chunk hits by source using the best fused source rank.
Return knowledge, people and projects in the existing shape; additive metadata is optional.
For RAG, pass fused chunks alongside the orchestrator's structured context.
Keep chunk evidence and source-level search grouping as separate views of the same keys.
When vectors fail, return BM25 only; when FTS fails, use escaped LIKE and available vectors.
Empty query returns empty groups without a full corpus scan.
Runtime FTS faults emit one bounded diagnostic and mark degraded lexical mode.

### Settings

Add proposed `search.hybridEnabled`, default false during rollout, to AppConfig.
Persist in the existing `<userData>\config.json` path (`services/config.ts:491`).
Keep RRF constant, tokenizer and candidate caps internal until measured tuning is needed.
Show index progress and degraded mode in Search settings without exposing SQL syntax.
When backfill is incomplete, retain legacy LIKE coverage for unindexed sources.
Deduplicate that coverage against indexed results and label partial lexical coverage.

## Performance and leanness budget

All figures below are acceptance targets, not observed performance.

| Measure | Target on the owner's full corpus | Measurement |
|---|---|---|
| Additional resident memory | <=32 MiB steady; <=64 MiB backfill peak | Electron main RSS delta and heap snapshots |
| Additional startup time | <=20 ms p95 | 20 cold and 20 warm starts against flag-off baseline |
| Lexical query | <=80 ms p95 warm; <=150 ms cold | 100 EN/ES queries, adapter wall time |
| Fusion and hydration | <=20 ms p95 beyond existing dense search | Timed spans; same result limit |
| Added disk | <=300 MiB including base text and FTS | DB page deltas; measure WAL separately |
| Main event loop | <=10 ms p95 added delay; no job slice >8 ms | Event-loop monitor while downloading and searching |

Measure end-to-end IPC search separately from cloud query-embedding time.
Record dense baseline latency; target <=100 ms additional hybrid overhead.
Use a frozen anonymized corpus preserving lengths and language distribution.
Report exact row counts, excluded rows, machine, disk, cache state and binding version.
Backfill runs one low-priority job after interactive readiness and idle time.
Read at most 250 chunks or 4 MiB per batch; shrink batches above 8 ms.
Yield with `setImmediate` between batches; synchronous SQLite calls cannot yield internally.
Pause backfill during transcription, USB work, foreground search or high event-loop delay.
Large parsing and rank work use a worker; the main writer owns short transactions.
Never backfill, optimize the whole FTS index or load chunk text at startup.

## Test plan

Write these failing tests before implementation; proposed names describe behavior.

- `hybrid-search.spanish-accent-and-prefix`: reunión and reuniones match reunion prefix.
- `hybrid-search.english-prefix`: deploy matches deployment without porter.
- `hybrid-search.literal-operators`: quotes, OR, colon, percent and underscore remain safe.
- `hybrid-search.rrf-one-based-deduplicated`: duplicated hits count once per list.
- `hybrid-search.provider-partition`: incompatible vectors never enter fusion.
- `hybrid-search.eligibility-before-limit`: excluded leading hits do not starve eligible ones.
- `hybrid-search.global-groups`: response shape and contact/project grouping survive.
- `hybrid-search.structured-routing`: action/report context and temporal grounding survive.
- `hybrid-search.module-absent`: adapter capability failure retains LIKE behavior.
- `hybrid-search.partial-backfill`: unindexed sources remain discoverable.
- `hybrid-search.metadata-update-no-fts-write`: timestamps alone cause zero index mutations.

Use a real better-sqlite3 database through DatabaseEngine and the app compatibility adapter.
Run the next migration from a main-shaped DB, an empty DB and a vector-table-absent DB.
Verify insert/update/delete trigger results with MATCH and `bm25()` reads.
Inject interrupted backfill, reopen the DB and verify idempotent resume.
Test rollback on a non-capability migration error without altering existing content.
On a full-size snapshot, evaluate an owner-labelled EN/ES query set and recall@10.
Require no recall regression on exact names; compare LIKE, dense and fused retrieval.
Exercise renderer Search and actual RAG prompt selection with locally inspected citations.
Run the performance matrix above before enabling the flag by default.

## Rollout

1. PR 1: failing tests, capability probe, canonical schema and trigger migration.
2. PR 2: bounded backfill, progress reporting and LIKE coverage while incomplete.
3. PR 3: pure RRF, globalSearch groups and orchestrator integration behind the flag.
4. PR 4: full-corpus measurements and default enablement only after acceptance.

Backfill resumes by source revision; no vectors are regenerated for this adoption.
Start with 20 recordings containing Spanish and English before the full idle pass.
Rollback disables hybrid reads and background jobs; retain additive tables and checkpoints.
Keep triggers installed while rollback reads LIKE so re-enabling can recover consistently.
An older binary may leave new derived rows stale; reconciliation detects revision mismatch.
Never roll schema backwards or remove recordings, notes or existing vector rows.

## Risks and open decisions

Prefix matching broadens recall and can increase false positives on common roots.
Measure prefix disk cost and EN/ES precision before changing weights.
The existing dense-search latency on the full library is to verify.
New canonical chunks must map correctly to legacy vector boundaries and citations.

- Recommended **equal**. Fusion weighting: **equal** or **lexical**?
  Equal costs no language tuning; lexical adds a weighted-RRF evaluation matrix.
- Recommended **prefix**. Prefix index storage: **prefix** or **scan**?
  Prefix spends extra FTS disk for speed; scan saves disk and needs measured query proof.
- Recommended **source**. Global knowledge grouping: **source** or **chunk**?
  Source preserves current cards; chunk requires new response and renderer behavior.
