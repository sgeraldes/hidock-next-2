# Retrieval traces: a local record of every query

Date: 4 October 2026. Status: approved by the owner ("arrancar ya"); phase 1 of
`docs/superpowers/plans/2026-10-04-knowledge-rsi.md`.

## Problem

Nothing records what retrieval did. `rag.ts` `generateAnswer` routes by intent, searches the vector
store, adds pinned context, graph facts, actionables and digests, and sends a prompt; only the answer and a
`sources` envelope reach `chat_messages`. `globalSearch` (Explore page) records nothing. The brain-server
(`brain-server.ts`, 12 read routes, no search) records nothing, so how often the agents read and what they
read is unknown. Every improvement proposed for retrieval (PR #156's hybrid search, chunk context,
incremental reindex) says its gain "is to verify with labelled queries", and there are no queries to verify
with. This store is that instrument.

## What is recorded

A trace is one request: a chat answer, an Explore search, or a brain-server read.

| Group | Fields |
|---|---|
| Request | `trace_id` (the chat's `generationId` when there is one), `parent_id`, `consumer` (`chat`, `explore`, `brain`), `client` (brain only, from an optional `X-HiDock-Client` header, never other headers), `session_ref` (conversation id), `route` and typed arguments (ids, dates, limits; never free text), `started_at` UTC, `duration_ms` from a monotonic clock, `status` (`ok`, `empty`, `error`, `cancelled`), `error`, `app_version` |
| Retrieval | `intent`, temporal range, `top_k`, `policy_version` (a constant bumped whenever retrieval code changes behavior), embedding provider, model and dimensions, `retrieval_issue` (`provider-failure`, `reindex-pending`) |
| Candidates | one row per candidate and channel (`vector`, `pinned`, `graph`, `actionables`, `digests`, `explore`, `brain-row`): rank before and after filtering, raw and adjusted score (null when the channel has no ranking), source kind and id (recording, capture, actionable, meeting, graph node, artifact), chunk index, content hash, kept or dropped with the reason (diversity cap, eligibility, budget, recheck), and whether it was sent to the model |
| Result | `answer_message_id` once the chat persists the answer, the `pipeline_calls` id of the generation call when available, candidate count and a truncation flag |

The query text is stored encrypted with Electron `safeStorage`, capped at 8 KiB, and erased after 30 days.
A keyed HMAC-SHA256 of the normalized text is kept so repeated questions can be grouped after the text is
gone; the key is 32 random bytes kept encrypted in the store's meta table. When `safeStorage` is not
available the text is not stored and the trace says so. Query embeddings are not stored in this phase; the
provider and model are recorded so they can be recomputed.

Candidate identity never uses `vector_embeddings.id`, which embeds `Date.now()` (`vector-store.ts:1082`).
It is the source id, the chunk index and the first 16 bytes (hex) of the SHA-256 of the chunk text, so a
rebuilt index maps back to the same chunk and a rechunked one shows up as a different chunk.

The `sources` that `rag.ts` assembles before generation are recorded as "sent to the model", never as
evidence the answer cited or as correct.

## Where it lives

A separate SQLite file, `<getDataPath()>/traces/retrieval-traces.db`, WAL mode and a busy timeout, opened
lazily by whichever process writes: the app's main process and the headless brain (`brain-host.ts`), which
keeps the business database read-only and may write this file. It is never attached to the business
database and never part of its migrations or restore points. Schema version lives in its own meta table.

## How it writes

Why not a worker: the headless brain exits when the app starts, so two writers rarely coexist.
The main process uses a 50 ms busy timeout, writes at most 100 events per transaction, and schedules
the rest on the next tick. A busy write puts its batch back at the front of the bounded queue and
retries on the next timer. Maintenance stops on a busy checkpoint, deletes at most five batches,
and reclaims at most 2,000 pages per pass.

- Recording never blocks or fails a request. Hooks hand an event to a bounded in-memory queue (1,000
  events); a flush writes batches in one transaction every 2 seconds or at 50 events, off the request path.
  On overflow the event is dropped and a per-day drop counter goes up. A write error is logged at most once
  per minute and counted.
- Limits: 100 candidates per channel, 64 KiB per event (candidates beyond the cap are cut and the trace marks
  truncation), 1 GiB for the file. Over the cap, the oldest traces go first. The file runs in
  `auto_vacuum = INCREMENTAL` mode and eviction returns freed pages with `incremental_vacuum`; a full
  `VACUUM` would rewrite up to 1 GiB synchronously on the main process.
- Retention, run at startup and daily: query text erased after 30 days, traces deleted after 90 days.
  Deleting rows only ever touches this file.
- Eligibility: the store keeps ids, not content. Anything that reads traces (the evaluation tools later)
  revalidates eligibility at read time, so a recording marked personal, deleted or value-excluded after the
  fact never surfaces from a trace. The stats line only counts traces per consumer, which exposes no
  content, so it skips that per-candidate check.

## Hooks

- `rag.ts` `generateAnswer`: request fields, intent, temporal range, top-k, vector results before and after
  the diversity cap, pinned parts, graph parts (`buildGraphContext`), actionables and digests
  (`buildActionablesContext`, `buildDigestsContext`), parts dropped by the post-await recheck, parts sent,
  status and duration, including the early returns (no results, provider failure, abort).
- `assistant:addMessage` (or wherever the generation's answer is persisted against its `generationId`): the
  answer message id onto the trace.
- `rag.ts` `globalSearch`: query, results in order with scores, duration.
- `brain-server.ts` request handler: route, typed arguments, returned ids in order (score null), status and
  duration. `/health`, `/capabilities` and `POST /step-down` are not traced.

## Settings and visibility

Settings > Assistant gets two switches, both on by default: "Record queries" and "Keep the text of my
queries (encrypted, 30 days)". Turning the first off stops recording; turning the second off stops storing
text and erases what is stored. Under them, one line from a `traces:stats` IPC call: traces in the last 7
days per consumer, dropped events, and the file size.

## Tests

- Store: schema creation, insert and read back, candidate cap and truncation flag, event size cap, file-size
  eviction, 30-day text erasure and 90-day deletion, HMAC grouping, `safeStorage` unavailable.
- Queue: never throws into the caller, batches, overflow counts drops.
- Hooks: a chat answer writes one trace with vector, pinned and graph candidates, the kept and dropped flags,
  and the answer message id; the early-return paths write a trace with the right status; `globalSearch`
  writes a trace; a brain-server read writes a trace with returned ids, and `/health` writes none; with
  "Record queries" off nothing is written.
- Servers in tests listen on 127.0.0.1 only.

## Out of scope

Query embeddings, parsing citations out of answers, an endpoint for agents to report what they used, a
search route on the brain-server, and the evaluation set and replay tools (phases 3 and 4).
