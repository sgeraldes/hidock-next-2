# Knowledge RSI: measuring and improving retrieval, the graph and the decision engines from their own history

Owner's rulings (4-oct-2026), after reading Dream-RSI (arXiv 2609.14858, https://www.dream-rsi.com/):

- "Esto es, a mi entender, recursive self-improvement para el context graph, es decir, poder mejorar los
  chunks, remover datos viejos, optimizar los conocimientos." Scope: the knowledge layer and the decision
  engines, both.
- "40 casos no es suficiente." Engine comparisons are sized per step from a pilot, not fixed at 40.
- Start now with phase 1, logging every query locally.

Roles: Opus plans and reviews, Codex (gpt-6.1-sol, low effort) implements, a Sonnet subagent tests; every
part closes with its entry in `G:\Code\_briefing\dod`. Two adversarial rounds on Codex gpt-6-astra shaped
this plan; their findings are summarized below with the evidence they measured.

## The idea taken from the paper

Dream-RSI keeps every attempt of a long search as a tree with its measured outcome, replays alternative
exploration policies over those frozen trees without new executions, and adopts a new policy only when it
scores at least as well as the current one on that history. What transfers to HiDock is the measurement
loop: record what retrieval and the engines did, freeze a snapshot, score alternative policies on it, and
adopt only what wins on data the choice never saw. What does not transfer yet is an LLM writing policy code:
HiDock has no independent evaluator for most steps, and without one a policy generator optimizes noise.

## What the adversarial rounds established (backup of 4-oct 21:31, read-only)

| Fact | Consequence |
|---|---|
| 242,360 chunks in three embedding spaces (local 2,048-d 129,654; Gemini 3,072-d 112,645; Ollama 61) | Policies are scored per partition; spaces never mix |
| A full sweep of the local partition takes a median 21.95 ms on the main PC CPU | Offline exhaustive retrieval over a frozen copy is cheap; no GPU needed |
| `vector_embeddings.id` embeds `Date.now()` (`vector-store.ts:1082`) | Candidate identity must be source, chunk and content hash, never the row id |
| 15 owner queries in the in-app chat (8-jul to 20-ago); the brain-server has no search route | Today almost nobody uses the ranking we want to optimize; agents read whole transcripts |
| 2,933 eligible actionables from 1,408 recordings resolve to a source; 18,862 of 119,160 edges (16%) carry a source | Automatic questions exist but only prove association, not that the extractor was right |
| Questions generated from the extractor's own output reward the extractor | Circular; real and paraphrased questions written without seeing the extraction are required |
| No supersession edges, tables or temporal properties exist | "Remove old data" has no evaluator; pairs must be annotated first |
| `mergeNodes` deletes the losing node; the org reconciler and the wiki rewrite in place | Graph maintenance today is not reversible; policies must write proposals, not mutations |
| `PRAGMA foreign_key_check`: 370 violations in actionables (369 legacy recording ids), 3 in meeting_contacts, 2 in meeting_projects | Integrity must be repaired and tested before any maintenance policy runs |
| `askDecision` falls through only on failure (`decision-engines.ts:211`); an integer score yields confidence 1 (`decision-engines.ts:71-75`) | Engines never escalate on doubt, and score confidence is not a signal |
| Comparing engines: ±5 points needs ~385 independent cases per step; detecting a 5-point paired gain needs ~628, ~1,066 with ten pairwise comparisons | Labels are sized per step from a pilot that measures disagreement |

## Phase 1: record every query (now)

Spec: `docs/superpowers/specs/2026-10-04-retrieval-traces-design.md`. A separate local trace store records
each chat answer, each Explore search and each brain-server read: the candidates per channel with scores,
what was filtered and why, what was sent to the model, and timing. Nothing leaves the machine.

## Phase 2: health metrics, no model calls

Deterministic numbers shown in Settings and tracked per release: share of edges with a source, orphan nodes,
duplicate candidates per node type (normalized key and alias collisions), foreign-key violations, chunks per
recording, empty or terse chunks, trace volume and drop count. Repair the 375 foreign-key violations first.

## Phase 3: an evaluation set that is not circular

- 30 to 50 real questions from the owner and from the agents' actual flows (coverage pulls pending
  actionables, interviews pull meetings and transcripts), each with the passages that answer it marked in the
  transcript, plus hard negatives and questions with no answer.
- Paraphrased questions written from transcript segments by someone (or a model) that never sees the
  extractor's output, scored on passages, not on recordings.
- A fixed context budget in the score, so returning everything never wins.
- Development, validation and a final audit set kept apart; snapshots "as of" each question's date so the
  graph and the wiki cannot leak later meetings; grouping by episode so one interview never crosses sets.

## Phase 4: replay and a small grid

A frozen copy of the database and the vector partitions, the trace store and the evaluation set. Retrieval
policies (top-k, recency weight, diversity cap, channel mix, and, once PR #156's adoptions land, BM25 fusion
and chunk context lines) are scored with passage recall and precision under the context budget, per intent,
with regressions and forbidden sources reported beside the mean. Answers are regenerated only for the final
comparison, because a changed context makes the recorded answer stale. The current policy is always a
candidate; a new one is adopted only if it wins on the validation set and holds on the audit set.

## Phase 5: graph maintenance as proposals

Deduplication, supersession and wiki consolidation run on a copy and write an immutable proposal layer
(aliases, provenance, temporal scope) that the owner reviews. Supersession pairs are annotated with entity,
scope, effective date and explicit evidence; similarity or recency only nominates candidates, since a later
meeting can repeat, cite or make an exception to an earlier decision, and a historical question may need the
old one. Undo and un-merge are tested on copies, including cascades, before any proposal is applied.

## Phase 6: decision engines (parallel track)

1. Fix the confidence of score questions so it reflects the model's uncertainty, and let the chain escalate on
   low confidence, not only on failure.
2. Pilot: run all five engines on 100 kind questions, measure disagreement and prevalence, then size the label
   set per step. Disagreements are labeled first; the final test set stays representative of real use.
3. Bench (`decision_bench_results`) and a grid over cascades (engine order, escalation thresholds, stop rule),
   scored on held-out labels with a fixed quality floor. Agreement between strong engines is a weak label and is
   audited, never trusted as ground truth.

## When an LLM-written policy becomes worth it

Only after phases 3 and 4 show a grid plateau with a measurable gap, an evaluation set large enough to detect
the gain, and a policy space too large to enumerate (rules conditioned on intent, time and source). Until then
the grid is cheaper, auditable and enough.
