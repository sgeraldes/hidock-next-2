# Learned rules from owner corrections

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/value-classification.ts:239` applies classifications.
Its precedence contract at line 196 preserves owner ratings.
The fixed reason vocabulary starts at line 94 and limits model-controlled tags.
`apps/electron/electron/main/services/identity-rules.ts:306` checks merge eligibility.
`identity-rules.ts:332` uses the journalled acceptance path for merges.
`identity-rules.ts:98` limits existing daily Jev calls to 300.
`apps/electron/electron/main/services/org-reconciler.ts:848` honours stored resolutions.
Its mention decision API is `applyMentionDecisionNoSave` at line 1833.
These mechanisms already apply rules and protect particular owner decisions.
The inspected modules do not provide a general correction-to-learned-rule consolidation loop.
Existing `identity-decisions` provenance must be reused rather than bypassed.

The supplied corpus is about 2,100 recordings and 240,000 chunks.
The number of explicit owner corrections and their coverage is to verify.
Do not infer feedback counts from the number of recordings or AI decisions.
Learn only from confirmed owner corrections with traceable before/after values.

## What the open-source project does

Laya's `engine/laya/pipeline/learn.py` extracts scoped classification rules.
`engine/laya/pipeline/context_learn.py` learns from link/unlink corrections.
`engine/laya/pipeline/learn_common.py` shares learning support.
`docs/architecture.md` describes extraction after 15 unprocessed corrections.
The code reads configurable thresholds and batch limits.
Consolidation rewrites learned rules within the selected scope and preserves manual rules.
Take the threshold, scoped extraction, compact consolidation and owner correction provenance.
Adapt priority/persona and grouping rules to HiDock value and identity decisions.
Identity proposals must preserve every existing undo, visibility and co-occurrence guard.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Derived extraction or consolidation code must retain license and attribution notices.
Mark changes to copied files and include relevant NOTICE in distributions.
Record independent implementation inspiration without importing Python or another process.

## Goals and non-goals

- Turn repeated explicit corrections into small, inspectable scoped rule proposals.
- Use a cheap configured text model only after enough new evidence exists.
- Dry-run every proposal and require owner acceptance before activation.
- Consolidate learned rules while preserving manual rules verbatim.
- Bound model spend, prompt size, rule count and firing rate.
- Keep deterministic validity and owner choices above learned rules.
- Never learn from an AI's own outputs, implicit clicks or hidden content.
- Exclude arbitrary rule code, SQL expressions and broad automatic person merging.
- Exclude retroactive mass classification and silent split reversals.
- Keep transcription quality and validity thresholds outside learning.

## Design

### Components and data model

Add proposed correction capture, rule proposal and dry-run evaluation components.
Their names and tables below describe new design, not existing APIs.
The next migration creates `learning_corrections` with immutable IDs and owner-event IDs.
Store domain, scope, source IDs, before/after typed JSON and source revision.
Also store timestamp, privacy tier, eligibility state and processed batch ID.
Unique owner-event ID prevents duplicate corrections when IPC retries.
Capture correction in the same transaction as the explicit owner change.
Reuse existing identity-decision IDs and merge-journal IDs as foreign provenance references.
The exact classification correction IPC hook is to verify before implementation.

Create `learned_rule_versions`: rule ID, version, domain, scope and typed condition JSON.
Store typed outcome JSON, evidence IDs, state, model, confidence and prompt hash.
States are proposed, dryrun, accepted, disabled and superseded.
Create `learning_batches` for leases, input revision, reserved cost and outcome.
Create `learned_rule_firings` with source revision, version, proposed effect and applied effect.
Index rules by domain/scope/state and feedback by scope/processed status.
Keep manual rules in their existing store; consolidation cannot overwrite them.
No model response is executed directly or admitted as a SQL predicate.

### Typed rule contract and precedence

Conditions allow a finite set of explicit category, meeting-domain and identity evidence tests.
Text conditions are bounded case-folded token sets, evaluated locally.
No freeform regular expressions, remote lookups or generated code are accepted.
Value outcomes use the existing fixed rating and reason vocabulary.
Identity outcomes initially suggest a merge or preserve a distinct-person constraint.
An accepted learned merge suggestion still requires the normal owner merge acceptance.
Stored owner split/undo constraints prohibit learned re-merging of that pair.
Guard order is eligibility, measured validity, owner resolution, deterministic rule, learned rule.
Conflicting learned rules abstain and expose evidence; model confidence cannot resolve conflict.
`org-reconciler.ts` reads accepted scoped suggestions after existing stored resolutions.
`value-classification.ts` can use accepted guidance in the model prompt within its fixed schema.
Preserve its owner-rating and measured-rating precedence at persistence time.

### Exact learning flow

1. Record a committed explicit correction and its owner provenance transactionally.
2. Count eligible unprocessed corrections per domain and scope.
3. Queue extraction after 15 corrections; cap a batch at 50.
4. After idle readiness, reserve the call budget and acquire the sole learning lease.
5. Recheck eligibility and privacy; select only the remaining permitted evidence.
6. Send bounded typed before/after examples to the configured cheap model.
7. Accept at most five schema-valid candidate rules with confidence >=0.85.
8. Require at least three distinct supporting corrections per proposed rule.
9. Dry-run against all known corrections in scope, capped at 200 examples.
10. Reject any rule conflicting with a current owner choice or protected split.
11. Require >=90% correction agreement and zero protected-choice violations.
12. Present dry-run counts, counterexamples and evidence for explicit acceptance.
13. Atomically publish the accepted version and its scope revision.
14. Record bounded firings and expose Disable and Undo through existing owner paths.

Confidence and agreement thresholds are proposal filters, not proof of generalization.
Mark a batch processed only when proposals and outcome persist successfully.
Failed batches retain feedback; retries consume the same daily budget pool.
Correction undo marks its evidence withdrawn and disables unsupported dependent rules.
Cap active learned rules at 20 per domain and 40 total.
Cap injected learned text at 1,200 tokens; trim by accepted priority and scope.
At 16 active learned rules in a domain, queue one LLM consolidation proposal.
Consolidation may reduce redundancy, never broaden scope or remove negative constraints.
Keep the previous accepted versions active until the consolidated set passes the same dry run.
Owner acceptance publishes the complete replacement set transactionally.
At the cap, retain pending proposals for review and stop growth.
Permit at most ten applied value changes per rule per day; identity remains suggestion-only.

### Settings and cost control

Add proposed `learning.enabled=false`, `learning.model`, `learning.dailyUsdCap=0.05`.
Persist them in `<userData>\config.json` (`services/config.ts:491`).
Expose separate value/identity enablement and proposal review under advanced Settings.
Choose the cheapest configured model that meets schema and privacy requirements.
Current model pricing and Jev suitability for rule JSON are to verify before selecting a default.
Bound each call to 8,000 input and 1,000 output tokens.
Reserve worst-case dollars from configured verified rates before extraction or consolidation.
Unknown rates block paid learning; local inference records zero API spend and still uses a call cap.
Allow two attempts per batch and at most four learning calls per day.
Retries and consolidation share the cap; persist reservations before provider dispatch.
Crash-ambiguous reservations remain spent until actual usage can be reconciled.

## Performance and leanness budget

Targets below require real-library measurements.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=8 MiB steady; <=24 MiB batch peak | RSS/heap delta with 200 bounded examples |
| Startup overhead | <=5 ms p95; no feedback scan | 20 cold/warm starts with flag on/off |
| Decision overhead | <=5 ms p95 local rule matching | 1,000 value/identity cases on real IDs |
| Search overhead | <=2 ms added IPC p95 | Search during dry run on 240,000 chunks |
| Added disk | <=25 MiB/year under caps | Measured correction/version/firing row sizes |
| Main event loop | <=5 ms p95 added delay; <=8 ms slices | Monitor correction bursts and dry runs |

Measure the exact correction count on the 2,100-recording corpus without scanning chunk bodies.
One low-priority learning or consolidation job runs at a time.
Dry-run evaluation processes 25 cases before yielding with `setImmediate`.
Heavy parsing and schema validation go to a worker; short DB transactions remain on the writer.
Pause learning for transcription, foreground generation, USB work or memory pressure.
No extraction, consolidation, feedback backfill or model call runs at startup.

## Test plan

Write the following failing tests first.

- `learned-rules.owner-events-only`: AI classifications never become feedback.
- `learned-rules.threshold-15`: fourteen events schedule no model call.
- `learned-rules.duplicate-event`: retrying owner IPC records one correction.
- `learned-rules.schema-only`: generated code and unknown outcomes are rejected.
- `learned-rules.protected-split`: matching positive evidence cannot reverse an owner split.
- `learned-rules.owner-rating-wins`: accepted guidance cannot overwrite owner value.
- `learned-rules.dry-run-before-accept`: extraction produces no automatic changes.
- `learned-rules.manual-verbatim`: consolidation preserves every manual rule.
- `learned-rules.cap-and-abstain`: full or conflicting rule sets remain bounded.
- `learned-rules.budget-restart`: retries and crash reservations share the persisted cap.
- `learned-rules.withdrawn-evidence`: undo disables unsupported dependent proposals.

Use actual better-sqlite3 transactions for owner edits plus correction rows.
Force failure between edit and feedback insert; neither half may commit alone.
Run extraction with a permitted local cheap model and inspect parsed proposals and dry-run rows.
Exercise real identity merge, undo and existing journal paths without destructive cleanup.
Use synthetic contacts in a disposable test database, retaining fixture evidence.
Replay consented owner corrections on a snapshot and compare held-out agreement.
Prove dry run changes zero contacts, captures and manual rules.
Measure all budgets before enabling a domain for the owner's profile.

## Rollout

1. PR 1: correction provenance migration and transactional capture, learning disabled.
2. PR 2: extraction schema, cost reservations and dry-run review only.
3. PR 3: accepted value guidance, precedence checks and disable behavior.
4. PR 4: identity suggestions and consolidation with protected-choice regression tests.

Backfill only verifiable owner events with reliable before/after provenance.
Skip historical rows whose ownership or correction content cannot be established.
Begin with one scope and 15 new explicit corrections.
Rollback disables learning and rule application; retain owner edits, journals and proposals.
Undo individual applied changes through existing journalled operations.

## Risks

Small samples can overfit; dry-run agreement needs later held-out evidence.
Natural-language consolidation can weaken negative identity constraints; typed guards remain authoritative.
Existing historical correction coverage is to verify before planning a learning backfill.

## Decisions taken

Source: [decision matrix](../../decisions/decisions.json).

4.1 — Activate learned rules only after owner acceptance. Sparse corrections can overfit and silently change classifications; dry-run review and the active-rule cap bound the owner's review effort.

4.2 — Suggest identity merges for acceptance through the normal owner path. A false merge mixes people and is difficult to undo cleanly; the existing path preserves merge journals, undo and owner splits.

4.3 — Propose rules after fifteen new corrections. This follows Laya's threshold and learns sooner while the four-call and $0.05 daily caps bound spending. Medium confidence: the first PR measures the owner's correction count, and proposal quality determines whether to raise the configurable threshold.

## Order and migration

Follow the rollout dependencies above. Schema migration numbers are assigned at merge time; other branches also add migrations. Main is at v72 as of 5 October 2026, and this spec reserves no migration number.
