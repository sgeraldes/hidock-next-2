# Three privacy tiers enforced at model calls

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/database.ts:89` describes personal/deleted lifecycle fields.
Personal recordings are excluded from AI pipelines; that is an existing owner-exclusion rule.
It does not establish a payload-level three-tier cloud/local classification.
`apps/electron/electron/main/services/brains/brain-router.ts:42` defines generation fallback.
Its embedding chain at line 44 includes Gemini, local ONNX and Ollama.
`apps/electron/electron/main/services/pipeline/runner.ts:13` documents per-attempt eligibility.
`pipeline/runner.ts:34` carries messages and a recording ID, without a full source manifest.
`apps/electron/electron/main/services/timeline-analysis.ts:599` calls Gemini directly.
Gating only renderer controls or the primary router would leave direct and fallback paths exposed.

`apps/electron/electron/main/services/rag.ts:1225` already rechecks prompt source eligibility.
Privacy must cover each component of that prompt, including history and inferred graph text.
The inspected contracts do not define the three tiers proposed below.
Existing descriptors already carry `dataLeavesMachine` (`services/brains/descriptor.ts:45`).
OpenAI-compatible endpoints use loopback detection (`services/brains/openai-compatible-brain.ts:131`).
Ollama's descriptor currently fixes that field to false (`services/brains/ollama-brain.ts:44`),
while its service accepts a configured base URL (`services/ollama.ts:235`).
Extend and enforce these descriptors; do not replace them with an unrelated provider catalog.
The complete audio/text/embed/direct-call inventory is to verify before enforcement release.
The supplied scale is about 2,100 recordings and 240,000 chunks.
No claim is made that current stored cloud history can be withdrawn by a local policy change.

## What the open-source project does

Laya's `docs/architecture.md`, Three-Tier Data Classification, labels metadata as tier 1.
Its tier 2 includes descriptions and channel messages, with default cloud processing.
Its tier 3 includes DMs, email bodies and flagged content, with a cloud privacy warning.
The same document describes local Ollama and untrusted-input boundaries.
Take explicit classification and auditable processing decisions.
HiDock adopts a stricter tier 3 rule: local processing only.
Project names and identifiers can be sensitive; metadata is never automatically harmless.
A warning cannot grant cloud permission for a forbidden payload.
Keep existing personal/deleted exclusion independent of the new tier label.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Copied/adapted policy code or prose must retain relevant notices and license attribution.
Record conceptual inspiration and the stricter HiDock policy difference explicitly.
No external policy package or source implementation is installed by this document.

## Goals and non-goals

- Make allowed cloud egress explicit for every source and every provider attempt.
- Keep tier 3 audio, text, embeddings and derived content local.
- Apply policy to cloud-backed CLIs, direct SDK calls, retry and fallback.
- Treat mixed-source derived content according to its most restrictive input.
- Fail closed for unknown provenance and unknown endpoint locality.
- Explain blocked work with actionable local-provider status.
- Preserve existing owner exclusions, validity and capability routing.
- Exclude a classifier that automatically downgrades sensitive content.
- Exclude claiming deletion from third-party provider retention or logs.
- Exclude network monitoring, firewall policy and arbitrary local-agent file access.

## Design

### Tier contract

| Tier | Intended data | Permitted processing |
|---|---|---|
| 1: shareable | Owner-designated non-sensitive content or metadata | Local or configured cloud |
| 2: controlled | Ordinary work transcripts/notes and derived content | Local; cloud only with persisted owner grant |
| 3: private | Sensitive content, private sources, unknown provenance | Verified local only |

The tier names are proposed; existing storage_tier values keep their retention meaning.
Tier ordering is numeric restriction: mixed inputs take the maximum tier.
Personal/deleted/untrusted exclusion still blocks processing even with a tier 1 label.
Treat unknown source IDs, chat attachments and provenance-free text as tier 3.
Owner may explicitly downgrade a source, with a recorded revision and clear effect.
A model or learned rule cannot lower a tier or manufacture a grant.
Cloud grants apply to selected tier 2 source types or specific sources and purposes.
Do not include tier 3 in the cloud-grant UI.

### Data model and migration

The next migration creates proposed `source_privacy_policy` and `privacy_grants` tables.
Policy keys are source kind and source ID; store tier, owner/default origin and revision.
Also store last-change time and optional local-only reason code without content.
Grant rows store scope, source kind/ID, permitted purposes, expiry and policy revision.
Use finite purposes such as transcription, embedding, analysis, retrieval-answer and learning.
Create `model_egress_decisions` for attempt ID, purpose, endpoint class, tier and outcome.
Record provider/model IDs, policy revision and reason codes, never prompt bodies or source titles.
Bound audit retention to 30 days and size under the disk budget.
Existing recordings and notes receive effective tier 2 without a cloud grant during staged migration.
Unmapped source types have effective tier 3 until the owner classifies them.
Metadata-only tier 1 requires explicit mapping or owner designation; no blanket exemption.
Use a proposed provenance mapping for derived outputs rather than duplicating every source policy.
Canonical chunks from adoption 1 retain source references and policy revision.
Older provenance-free derived records are local-only until reconciled.
Migration installs schema/default semantics only; no whole-library content classifier runs.

### Model boundary contract

Extend the model request contract with purpose and a complete typed source manifest.
Manifest entries carry source ID, revision, contributed fields and any derived-source IDs.
Each message, attachment, audio file, image, history turn and tool result has provenance.
System defaults may be tier 1; authored prompt overrides require their own effective policy.
Anonymous user query text is tier 3 by default until a persisted chat-session cloud grant classifies it.
That grant can classify query text as tier 2; it cannot downgrade retrieved tier 3 context.
Compute effective tier on the complete payload before serialization and before every provider call.
At policy enforcement, re-read current source state so cached permits cannot outlive revocation.
Enforce eligibility first, then privacy, then capability and provider availability.

Provider descriptors add a verified endpoint class: local, cloud or unknown.
Local ONNX is local because it performs inference without a remote request.
Ollama is local only when configured to a verified loopback endpoint.
LAN endpoints and remote OpenAI-compatible servers are cloud unless explicitly verified under a later policy.
Claude Code, Codex, Gemini CLI and Kiro inference are cloud-backed for this policy.
A locally installed CLI does not imply local model processing.
Unknown endpoint class cannot process tier 3.
Reject redirects from a loopback model endpoint to a remote host.
DNS names resolving unpredictably are not accepted as verified loopback.
Local providers that cannot transcribe or generate must return blocked/unavailable by capability.
No implicit cloud fallback is permitted when the local capability is absent.

### Exact attempt flow

1. Caller supplies purpose and manifest alongside its messages or media.
2. Resolve all derived contributions to their original source set.
3. Read current lifecycle eligibility, effective tiers and purpose grants.
4. Build a permit bound to payload hash, source revisions, policy revision and provider endpoint.
5. Remove prohibited sources only when the caller's defined operation permits a partial answer.
6. Recompute the payload and disclose omitted sources when a partial answer is supported.
7. For source-specific transcription/analysis, block rather than silently truncate the source.
8. Immediately before SDK send or CLI stdin, recheck permit revisions and endpoint identity.
9. Record a content-free allowed/blocked decision and dispatch only an allowed attempt.
10. On retry, fallback or plan onFail, acquire a fresh permit for that exact endpoint/payload.
11. Propagate the maximum input tier and source lineage into the stored result.
12. Recheck policy before rendering cached derived content or including it in another model call.

Policy revocation during setup prevents sending; revocation during an in-flight request aborts locally.
An already transmitted payload cannot be recalled; record that temporal boundary honestly.
No fallback attempt may treat privacy denial as ordinary provider failure.
Embedding requests are egress too, including query embedding and batch chunk embedding.
Audio upload/transcription must check before file bytes leave the process.
Direct Gemini timeline scoring is routed through the same permit evaluator before SDK dispatch.
Pipeline direct harnesses and all brain adapters require the same final-boundary assertion.
Future adapters without an endpoint descriptor remain fail closed.
Any discovered bypass blocks enforcement rollout until integrated or disabled.

### Settings and migration experience

Add proposed `privacy.tiersEnabled`, `defaultTier=2` and cloud grants to AppConfig/policy storage.
AppConfig lives at `<userData>\config.json` (`services/config.ts:491`).
Grant source records live in SQLite; global display preferences live in config.
Stage the feature disabled while call paths and provenance are inventoried.
Before enabling, present existing source counts and the cloud grant review once.
No grant is inferred from an API key, provider selection or previous cloud use.
Show per-item tier controls and a bulk tier/grant operation with counts and purposes.
Blocked job status names the required local capability or missing tier 2 grant.
Cached excerpts, summaries, context lines, backlinks and learned rules inherit source restrictions.
Tier 3 text can remain in local FTS; its cloud retrieval-answer contribution is forbidden.
Local search remains available within existing eligibility rules.

## Performance and leanness budget

Acceptance targets below require measurement on the supplied full-size corpus.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=8 MiB steady; <=16 MiB manifest peak | RSS/heap during 100-source mixed RAG calls |
| Startup overhead | <=5 ms p95; policy schema metadata only | 20 cold/warm starts on 2,100 recordings |
| Per-attempt policy latency | <=10 ms p95 for 100 source IDs | Real adapter timings before send |
| Search overhead | <=5 ms added p95 | EN/ES search over 240,000 chunks |
| Added disk | <=25 MiB policy/provenance; <=20 MiB audit | Page/WAL deltas at configured 30-day retention |
| Event-loop delay | <=5 ms p95 added; <=8 ms slices | Monitor bulk tier edits plus device work |

Use indexed batched policy lookups; do not read chunk bodies to classify at send time.
Cap one manifest at 100 source IDs; larger operations split before preparation.
Cache immutable policy metadata with revision invalidation, never long-lived send permits.
Bulk provenance reconciliation is one low-priority job after interactive readiness.
Process 250 metadata rows per batch and yield with `setImmediate`.
Pause heavy reconciliation for foreground search, transcription and USB work.
No content classifier, full chunk hydration or heavy privacy backfill runs at startup.
Policy enforcement itself is synchronous at the final boundary and cannot defer to background work.

## Test plan

Write these failing tests first.

- `privacy-tiers.private-never-cloud`: tier 3 payload reaches zero cloud SDK/CLI sends.
- `privacy-tiers.controlled-needs-purpose-grant`: tier 2 analysis grant does not permit embedding.
- `privacy-tiers.mixed-max-tier`: one private contribution restricts the complete unsplit payload.
- `privacy-tiers.fallback-rechecks`: local failure cannot route private text to Gemini.
- `privacy-tiers.direct-sdk`: timeline scorer checks the permit before generateContent.
- `privacy-tiers.cli-is-cloud`: installed CLI location cannot imply local inference.
- `privacy-tiers.remote-ollama`: remote endpoints and loopback redirects cannot pass as local.
- `privacy-tiers.unknown-provenance`: legacy text and history fail closed.
- `privacy-tiers.revocation-before-send`: changed policy after setup prevents dispatch.
- `privacy-tiers.media-and-query-embed`: audio upload and query embedding enforce policy.
- `privacy-tiers.derived-lineage`: summaries, rules, context and backlinks inherit all input tiers.
- `privacy-tiers.audit-no-content`: titles, prompts, media paths and secrets never enter audit rows.

Use real better-sqlite3 policies, grants, revisions and audit reads after migration/restart.
Use local HTTP receiver fixtures at the actual adapter transport boundary to inspect sent payloads.
Exercise allow, denial, retry, fallback, redirect and revocation during delayed preparation.
A transport spy alone is supporting evidence; run real adapters against controlled receivers.
For CLIs, use a controlled executable receiver and inspect actual stdin/environment/files passed.
Verify forbidden source markers appear in zero receiver payloads across the inventoried paths.
Exercise a real local model with a tier 3 source and inspect the persisted derived tier.
Check Electron blocked statuses and bulk grant review; no actual private cloud request is needed.
Run full-corpus timing and require zero unintegrated model-call paths before default enablement.

## Rollout

1. PR 1: complete call-path inventory, policy schema, manifests and failing boundary tests.
2. PR 2: brain adapter, router, pipeline direct/fallback and embedding enforcement.
3. PR 3: direct SDK/audio paths, derived lineage and legacy provenance reconciliation.
4. PR 4: source tier/grant UI, staged owner review and enforcement enablement.

Backfill metadata provenance only, in bounded idle batches; unknown records stay local-only.
Start with 20 synthetic/consented sources covering every adapter and content modality.
Enable before cloud use of learned rules or rolling summaries from adoptions 4 and 7.
Rollback disables new background work and UI expansion while retaining installed send guards.
Retain policies, grants and audit; never reopen a forbidden cloud path during rollback.
If a guard fails, block that adapter until repaired and expose its unavailable status.
No content deletion, remote retention claim or schema downgrade is part of rollback.

## Risks and open decisions

Legacy graph/history provenance can be incomplete; unknown text must remain local-only.
Local endpoints and cloud-backed CLIs need endpoint-level evidence, not marketing labels.
Owner downgrade is an explicit policy change whose effect must be visible before future sends.

- Recommended **controlled**. Existing ordinary sources: **controlled** or **private**?
  Controlled requires cloud grants; private blocks all cloud until explicit source downgrades.
- Recommended **loopback**. Local endpoint scope: **loopback** or **lan**?
  Loopback is narrow; LAN needs endpoint trust, transport security and administrator policy.
- Recommended **omit**. Mixed RAG context: **omit** or **block**?
  Omit needs visible exclusions and fresh payload permits; block reduces answer availability.
