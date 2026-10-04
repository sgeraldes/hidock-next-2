# Rolling summary in four layers

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/timeline-analysis.ts:935` analyzes one recording.
`timeline-analysis.ts:658` derives action and decision markers.
Its scorer calls Gemini directly at line 599 with a pre-call gate documented at line 491.
`apps/electron/electron/main/services/retrieval-orchestrator.ts:251` builds digest context
from per-meeting capture titles and summaries, as documented at line 247.
These are useful sources for a continuously updated cross-meeting view.
The inspected timeline and digest retrieval paths do not provide four rolling time layers.
A single recording's sentiment or markers cannot represent all current attention.

The owner supplies about 2,100 recordings and 240,000 chunks.
Reading all chunks for a daily summary would add unnecessary memory, latency and model cost.
The exact eligible digest count and daily arrival rate are to verify.
No daily model spend or summary benchmark was measured in this task.
Use digest-level changes and deterministic incremental updates before daily synthesis.

## What the open-source project does

Laya's `engine/laya/pipeline/omni.py` appends incremental recent items without LLM calls.
Its scheduled resynthesis compresses layers and stores versioned snapshots/deltas.
`docs/architecture.md` describes a ten-second update debounce and daily configurable synthesis.
Its four layers are Attention, Recent, Period and Milestone.
The source includes resynthesis gates so concurrent updates do not corrupt snapshots.
Take layered state, cheap append/update, versioned publication and daily compression.
Adapt the source set to eligible HiDock digests, actions and timeline decisions.
Keep changes arriving during synthesis in a durable pending revision.
Avoid copying its multi-platform pipeline or fetching the whole transcript corpus.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Retain license, NOTICE and modification attribution for derived implementation.
Record conceptual inspiration for independent state and scheduling code.
This document adds no Python engine or other runtime dependency.

## Goals and non-goals

- Show current attention with traceable source links.
- Maintain Recent cheaply after eligible source changes.
- Compress history into Period and Milestones with one daily bounded synthesis.
- State estimated daily cost and enforce a persisted dollar cap.
- Keep the last successful snapshot when synthesis fails or is unaffordable.
- Honour corrections, eligibility changes and privacy tier propagation.
- Exclude continuous model calls, autonomous actions and transcript-wide summarization.
- Exclude calendar rescheduling, email sending and promises of factual completeness.
- Keep individual recording timelines and existing digests available unchanged.
- Require source-supported output; model prose cannot create unsupported achievements.

## Design

### Components, layers and data model

Add proposed rolling-summary reducer, scheduler and synthesis components.
The next migration creates `rolling_summary_sources`, `rolling_summary_snapshots` and jobs.
Source rows store typed source ID, source revision, time, digest excerpt and citation IDs.
Also store eligibility/privacy revision, action state and last folded summary revision.
Snapshots store version, cutoff revision, timezone, layer JSON and synthesis metadata.
Each item stores source IDs/revisions, text, time interval and maximum privacy tier.
Persist a content hash and superseded flag; retain up to 30 published snapshots.
Add `rolling_summary_budget` keyed by owner-local date and timezone-policy epoch.
Store reserved USD, actual USD when known, attempts, model and verified rate revision.
Job rows include requested source revision, lease, status and retry time.
All table/component names in this paragraph are proposed.

Layer definitions are bounded product semantics.
Attention holds <=20 open actions, overdue items and owner-pinned unresolved decisions.
Recent holds <=50 items from the last seven owner-local days.
Period holds <=12 compact themes from the last 30 days.
Milestones holds <=30 source-supported completed outcomes across retained history.
If the available source set exceeds a cap, show omitted-source counts and latest update time.
Owner pins are preserved verbatim and still require valid visible sources.
Milestone selection uses explicit completion evidence; inferred success is rejected.
An item can cite multiple sources but cannot include an ineligible source.

### Exact incremental flow

1. Eligible digest/action/timeline publication queues its source ID and revision.
2. Coalesce source events for ten seconds after interactive readiness.
3. Read at most 100 changed digest-level sources, with bounded excerpts.
4. The deterministic reducer updates Attention and Recent by source key.
5. Remove withdrawn, invalid, deleted or excluded source contributions immediately.
6. Publish a new local snapshot transactionally with its source cutoff revision.
7. Show fresh Attention/Recent and the last synthesized Period/Milestones timestamp.
8. Leave any source events beyond the cutoff queued for the next pass.

No incremental update calls a model.
Use existing action status and timeline decision evidence instead of generating new actions.
Content corrections replace the source contribution; duplicate events remain idempotent.
Do not turn a stale model snapshot into current text by changing only its timestamp.
When a source is revoked, remove every derived item citing it until a safe reconstruction exists.

### Exact daily synthesis flow

1. At the configured local time, queue one job when eligible changes exist.
2. Wait for idle readiness; a missed schedule runs at the next idle opportunity.
3. Snapshot the source cutoff, current layers, eligible digests and owner pins.
4. Recheck privacy and source eligibility before constructing the request.
5. Bound the complete request to 12,000 input tokens and 2,000 output tokens.
6. Select the cheapest configured model meeting privacy and structured-output requirements.
7. Reserve the worst-case cost in a DB transaction before provider dispatch.
8. Ask for structured layers with citations drawn only from the supplied source ID allowlist.
9. Reject unknown citations, changed pins, empty skeletons and unsupported milestone claims.
10. Recheck every cited source and the policy revision before publication.
11. Atomically publish the new snapshot and reconcile actual usage with its reservation.
12. Fold any changes after the cutoff through the deterministic reducer.

If a source changed during the call, reject its stale derived items and retain pending revision work.
Do not hold a SQLite transaction open during the model call.
On failure, keep the previous safe synthesis and visibly mark the last attempt/error.
At most one retry occurs within the same daily cap.
No-change days make zero LLM calls.
Only one catch-up synthesis runs after several missed days; no per-day replay burst.

### Daily cost and cap

Rates below are an explicit budgeting scenario, not a current provider price claim.
Actual provider/model prices are to verify before enabling paid synthesis.

| Scenario | Calculation | USD/day |
|---|---|---|
| One full bounded call at $0.25/M input, $2/M output | 12,000 x 0.25/1M + 2,000 x 2/1M | 0.007 |
| One full call plus one full retry at those rates | 2 x 0.007 | 0.014 |
| Default hard cap | All reservations, failures and retries combined | 0.020 maximum |
| No changed sources | No request | 0.000 |

At those scenario rates, 30 one-call days cost $0.21; retry every day costs $0.42.
The hard 30-day cap is $0.60, before taxes or external subscription costs.
For verified rates `Ri` and `Ro`, reserve `(12000*Ri + 2000*Ro)/1000000` per call.
If the reservation exceeds remaining dollars, skip the call or use an allowed local model.
If rates are unknown, block paid synthesis and report cost unknown.
Never treat subscription CLI inference as a proven zero-cost API substitute.
Prefer priced API or local inference initially; CLI quota accounting is an open integration decision.
Reserve all provider attempts including fallback; disallow unpriced fallback.
Use provider-enforced output limits and count complete prompts before sending.
Record actual usage when available; retain worst-case reservation when usage is missing.
Crash-ambiguous requests consume their reservation until reconciled.
Timezone changes cannot reset today's cap: retain the prior window until 24 hours have elapsed.
This cap covers rolling-summary calls only; other pipeline spend is shown separately.

### Settings and reader

Add proposed `rollingSummary.enabled=false`, `model`, `dailyUsdCap=0.02` and `localTime=03:00`.
Persist under AppConfig in `<userData>\config.json` (`services/config.ts:491`).
Use the configured owner timezone; its precise existing config field is to verify.
Expose Update now using the same cap, eligibility and one-job schedule.
Show four layers, source links, fresh/stale timestamps, omitted counts and daily reserved/actual cost.
Add Pause synthesis while allowing cheap local source updates.
Apply adoption 8 to mixed-source summaries and their cached snapshots.

## Performance and leanness budget

Targets are measured on the full library, using digests rather than all chunk text.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=8 MiB steady; <=24 MiB synthesis preparation | Main RSS/heap delta at 100 changed sources |
| Startup overhead | <=5 ms p95; metadata/snapshot read only | 20 cold/warm starts on 2,100 recordings |
| Summary query | <=30 ms p95; Search added overhead <=2 ms | Snapshot IPC plus EN/ES search on 240,000 chunks |
| Disk growth | <=20 MiB state/history, excluding existing digests | DB/index/WAL deltas with 30 snapshots |
| Incremental update | <=100 ms p95 per 100 sources | Reducer plus short publish transaction |
| Event-loop delay | <=5 ms p95 added; <=8 ms slices | Monitor while USB and transcription are active |

Record exact eligible digests, daily changed sources, tokens and snapshot bytes.
One low-priority reducer/synthesis preparation job runs at a time.
Yield with `setImmediate` every 25 sources or before an 8 ms CPU slice is exceeded.
Heavy validation/compression runs in a worker; model waiting never blocks the main thread.
Pause preparation during foreground generation, search pressure, device work or transcription.
No historical synthesis, full digest scan or catch-up model call runs at startup.

## Test plan

Write these failing tests first.

- `rolling-summary.incremental-zero-llm`: a changed digest updates Recent without a call.
- `rolling-summary.layer-bounds`: caps, intervals, source links and omitted counts are correct.
- `rolling-summary.correction-replaces`: corrected source creates no duplicate contribution.
- `rolling-summary.revoked-source`: stale layers cannot expose excluded source text.
- `rolling-summary.daily-once`: missed days queue one catch-up call after idle readiness.
- `rolling-summary.cost-0-007`: scenario token/rate calculation matches $0.007.
- `rolling-summary.cap-retry-restart`: fallback, retry and restart cannot exceed $0.02 reservations.
- `rolling-summary.unknown-rates`: paid call is blocked when rate metadata is missing.
- `rolling-summary.timezone-cap`: timezone changes cannot create a second spending window.
- `rolling-summary.citations-and-pins`: unknown sources and changed owner pins are rejected.
- `rolling-summary.concurrent-delta`: events arriving during synthesis survive publication.

Use real better-sqlite3 state, leases, snapshots and budget reservations.
Crash after reservation and after publication; reopen and verify state plus spend accounting.
Use an actual permitted local model for structured synthesis and inspect source-supported layers.
Paid-model measurement belongs to the rollout PR with verified rates and bounded authority.
Exercise the renderer with source correction, deletion and budget exhaustion.
Measure full-size latency, memory and disk; retain per-call token/cost evidence.

## Rollout

1. PR 1: layer schema, deterministic reducer, source provenance and failing tests.
2. PR 2: daily scheduler, structured synthesis and persisted cost reservations.
3. PR 3: four-layer reader, freshness/cost display and source invalidation integration.

Backfill only the recent seven-day digest window initially, one idle batch at a time.
Older Period/Milestone history is a bounded explicit task within the same daily cap.
Start with 20 eligible sources and one local synthesis before paid enablement.
Rollback stops synthesis and hides the view; retain snapshots, sources and budget records.
Existing timelines and digests remain authoritative and require no schema downgrade.

## Risks and open decisions

Daily compression can omit unresolved items or invent completion; enforce evidence and pins.
Provider rate drift invalidates estimates; paid attempts require a current verified rate revision.
Exact timezone configuration and digest production hooks are to verify.

- Recommended **twocents**. Daily cap: **twocents** or **fivecents**?
  Twocents may skip expensive models; fivecents permits more retries at $1.50 per 30 days.
- Recommended **seven**. Recent window: **seven** or **fourteen**?
  Seven keeps prompts compact; fourteen needs tighter item selection within the same token bound.
- Recommended **local**. Unaffordable call: **local** or **skip**?
  Local needs an available validated model and CPU budget; skip retains visibly stale synthesis.
