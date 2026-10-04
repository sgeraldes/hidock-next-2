# Context lines for indexed chunks

Date: 4 October 2026. Status: proposed design; depends on adoption 1.

## Problem

`apps/electron/electron/main/services/vector-store.ts:158` chunks text by length.
The stored row has `content`, `subject`, meeting and recording IDs at line 313.
There is no dedicated context line in that table definition.
`vector-store.ts:35` documents 237,920 chunks and lazy content hydration.
A short response such as "Approved" may contain none of the meeting's topic words.
Its title metadata does not establish a topic-bearing lexical body by itself.
The current lexical global search scans capture title and summary
(`apps/electron/electron/main/services/rag.ts:1529`).
Adoption 1 creates a canonical chunk index and BM25 retrieval.
This adoption adds explicit local context to that index.

`apps/electron/electron/main/services/notes.ts:96` resolves note display titles.
`apps/electron/electron/main/services/note-intelligence.ts:173` indexes note metadata.
Use source titles without overwriting owner-authored text.
The supplied corpus is about 2,100 recordings and 240,000 chunks.
The proportion of terse chunks and retrieval loss is to verify with labelled queries.
No measured retrieval gain is claimed by this design.

## What the open-source project does

Laya persists `action_cards.thread_context` during `engine/laya/pipeline/emit.py`.
`engine/laya/db/fts.py` includes it as a BM25 column.
`docs/architecture.md` describes a group-summary headline/status or recent card headers.
`engine/laya/db/migrations/068_card_thread_context.sql` introduces the context field.
Old rows may remain NULL under its snapshot-at-emit behavior.
Take a bounded persisted context string with an explicit source and revision.
Use deterministic HiDock titles and existing topic evidence before considering model prose.
Keep the context separate from verbatim chunk evidence.
Defer embedding context because it changes the searchable vector representation.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Retain the license, NOTICE and change notices for any derived implementation.
Record conceptual inspiration when implementing the pattern independently.
This task adds no upstream code or new runtime dependency.

## Goals and non-goals

- Make terse chunks discoverable by their meeting title and available topic.
- Store the same bounded context for all chunks of a source revision.
- Preserve verbatim evidence and explain which field produced a lexical match.
- Keep context construction local, deterministic and cheap.
- Respect transcript validity, deletion, owner exclusion and privacy tiers.
- Recover from title changes through source-slice replacement.
- Avoid regenerating the 240,000 existing vectors.
- Exclude LLM topic generation, neighbour-transcript copying and recursive context.
- Exclude multi-meeting context that could assign the wrong meeting to a chunk.
- Keep chunk sizing and diarization outside this adoption.

## Design

### Components and data model

Extend adoption 1's proposed `search_documents` with nullable `context_line`.
Also add `context_revision`, `context_origin` and `context_version`.
These columns and the context builder are proposed components.
Origins are `meeting`, `capture`, `note` or `none`.
Context revision hashes the input fields and builder version.
The next migration adds those columns and upgrades the FTS definition.
The FTS column order becomes title, body, context_line.
Retain `unicode61 remove_diacritics 2` and prefix indexes from adoption 1.
Recreate the derived virtual table transactionally; keep canonical content intact.
An interrupted schema transaction must leave the previous usable index.
Populate the new FTS incrementally after schema installation, never by a startup rebuild.
Use lexical readiness checkpoints so partially populated rows retain LIKE coverage.
Narrow the UPDATE trigger to title, body and context_line with value-change guards.
Changing context_revision alone causes zero FTS writes.
Existing rows start with NULL context; NULL is equivalent to empty indexed text.
No additional column is required in the lazily owned `vector_embeddings` table.

### Context construction

Read the current eligible source snapshot once for an indexing job.
For a recording, prefer the linked meeting subject if the link is current and permitted.
If absent, use the owner's capture title, then the available source title.
Add an existing topic label only when its provenance is eligible for this source.
If no explicit topic field is available, omit topic rather than generating one.
The exact current topic storage field is to verify before wiring it.
For a note, use `noteDisplayTitle` and its explicit category when present.
Do not include attendee lists, email addresses or inferred names in a context line.
Normalize whitespace and remove control characters.
Limit the complete line to 240 Unicode characters and 1 KiB UTF-8.
Trim on a grapheme-safe boundary and append no invented interpretation.
Format as `Meeting: <title>; Topic: <topic>` or `Note: <title>; Category: <category>`.
Omit absent fields and their separators.
Persist the resulting string, origin and source revision for every chunk in the slice.
Never alter the authored body or original transcript.

### Exact indexing and retrieval flow

1. Adoption 1 creates canonical chunks even when vector generation is unavailable.
2. Resolve one eligible source snapshot and its context inputs.
3. Construct and validate one bounded line for that revision.
4. Attach it to all staged chunks in the source generation.
5. Publish the source slice through adoption 6's revision-safe replacement when available.
6. Before adoption 6 lands, use adoption 1's bounded idempotent source writer.
7. FTS triggers index the context line together with body and title.
8. Retrieval uses `bm25(fts, 2.0, 1.0, 0.25)` as initial title/body/context weights.
9. Fuse the lexical list through adoption 1's RRF; preserve dense results unchanged.
10. Hydrate only selected chunk bodies and their stored context metadata.
11. Show the context as a source label outside the quoted transcript evidence.
12. Recheck source eligibility and privacy before display or model egress.

Allow a context-only hit; label it so the owner can inspect the actual terse text.
Limit context-only results to two chunks per source in the initial top ten.
Fill unused slots with other eligible hits; do not hide a sole relevant source.
A title change queues one source context refresh without calling an embedding provider.
A calendar relink invalidates the former context revision before reuse.
An excluded or invalid recording contributes neither title nor topic context.
Treat context as derived content with the maximum privacy tier of its inputs.
No source text is copied from neighbouring meetings.

### Settings

Add proposed `search.chunkContextEnabled`, initially false, in AppConfig.
Persist in `<userData>\config.json` (`services/config.ts:491`).
Show context backfill progress beside hybrid index progress.
Keep character limits, weights and builder version internal constants initially.
When disabled, stop context jobs and use a zero context BM25 weight.
Suppress context-only candidates explicitly; a zero weight alone still permits MATCH hits.
Keep ordinary body/title matches and dense retrieval available.
Rollback requires no vector regeneration or authored-content change.

## Performance and leanness budget

These are proposed acceptance limits on the full supplied corpus.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=8 MiB steady; <=16 MiB refresh peak | Main heap/RSS delta over adoption 1 |
| Startup overhead | <=2 ms p95 | 20 cold/warm starts with existing checkpoints |
| Added lexical latency | <=10 ms p95 warm | Same 100 EN/ES queries before/after context |
| Added disk | <=100 MiB at 240,000 chunks | Column and FTS page deltas; WAL separately |
| Added event-loop delay | <=5 ms p95; slices <=8 ms | Monitor during title edits and USB download |

At 240 characters per chunk, UTF-8 size depends on actual characters and must be measured.
Measure average line bytes and context-only precision; avoid presenting a byte estimate as fact.
Use the real-length corpus and record exact eligible chunk counts.
Background refresh is one low-priority job shared with lexical backfill.
Reuse the context string within a source batch without caching the entire corpus.
Write at most 250 rows or 4 MiB per transaction, reducing batches above 8 ms.
Yield with `setImmediate` between batches; pause for foreground queries and transcription.
Heavy migration population and context backfill never run at startup.
No LLM call, embedding cost or full vector residency is added.

## Test plan

Write these failing tests first.

- `chunk-context.terse-spanish`: "Aprobado" is found by the meeting's accented topic.
- `chunk-context.terse-english`: "Done" is found by the deployment meeting title.
- `chunk-context.verbatim-body`: context never changes quoted transcript content.
- `chunk-context.absent-topic`: missing topic is omitted without an inferred replacement.
- `chunk-context.owner-title`: authored note title wins according to the existing resolver.
- `chunk-context.bounds`: long emoji, combining marks and CRLF remain within both limits.
- `chunk-context.relink`: old meeting terms disappear after source refresh.
- `chunk-context.excluded-input`: hidden or invalid inputs never enter the line.
- `chunk-context.metadata-update`: provenance-only edits cause zero FTS rewrites.
- `chunk-context.disabled`: context-only matches disappear while body matches survive.
- `chunk-context.vector-unchanged`: refresh makes zero embedding calls.

Use real better-sqlite3 migrations from adoption 1's schema and read back FTS matches.
Compare NULL old rows, partially refreshed rows and fully populated rows.
Interrupt migration and refresh separately; verify restart and idempotent resume.
Check title update, meeting relink and source deletion against actual persisted rows.
Use owner-labelled terse-chunk queries and report recall@10 plus context-only precision.
Exercise the reader citation UI to confirm it displays the original chunk as evidence.
Run the full-corpus memory, disk and query matrix before default enablement.

## Rollout

1. PR 1: builder tests, additive context schema and versioned FTS upgrade.
2. PR 2: eligible source context writes, bounded backfill and relink invalidation.
3. PR 3: weighted retrieval, context-only labels and disable behavior.

Depends on adoption 1; adoption 6 later replaces the interim slice writer.
Start with 20 meetings and ten notes before the full idle context pass.
No historical topic synthesis runs during backfill.
Rollback disables context reads and jobs, retaining columns and source text.
Retain revision data so a later re-enable can refresh changed sources.

## Risks and open decisions

Repeated meeting titles can flood retrieval with weak context-only evidence.
An existing topic label may itself be unreliable or absent; provenance must be explicit.
Builder changes require a lexical refresh whose full-corpus duration is to verify.

- Recommended **lexical**. Context representation: **lexical** or **embedded**?
  Lexical costs one FTS refresh; embedded costs new provider partitions and paid re-embedding.
- Recommended **current**. Title policy: **current** or **snapshot**?
  Current costs refresh on relink/edit; snapshot is cheaper and preserves stale title terms.
- Recommended **quarter**. Context BM25 weight: **quarter** or **equal**?
  Quarter limits repeated-title dominance; equal needs more precision tuning on terse queries.
