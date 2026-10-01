# Pipeline Phase 3b: Try a Plan Before Adopting It, Outline for Approval

> **For agentic workers:** this is an outline, not yet a step-by-step plan. Expand each task into the test, the run, the code and the commit steps (superpowers:writing-plans) before building, and build with superpowers:executing-plans.

**Goal:** From Settings > Pipeline the owner runs a draft plan for one step on one real input (a note, a recording), sees what each call returned, how long it took and what it cost next to the stored result, and then keeps it as a candidate, adopts it, or discards it. Nothing is overwritten without a click. The page also gets a profile manager and presets.

**Architecture:** Each step's call site is cut into a task definition with five parts: load its input, build the request, parse the answer, read the stored result, write a result. The call site becomes "load, run, parse, write" through one function (`runTask`). The Test bench calls the same function with the draft plan and a candidate sink, so a trial exercises exactly the code that runs for real. Candidates live in a new table `pipeline_results`; Adopt calls the task's own writer.

**Spec:** `docs/superpowers/specs/2026-09-30-pipeline-design.md` (sections 5, 10 and 11); phases 2a, 2b and 3a are on main (plans in this folder).

## Status

Written on 1-oct-2026 while the owner slept, as the next phase after 3a and 2b. It needs the owner's answers to the three decisions below before building. Nothing in it is built.

## Decisions for the owner

1. **Which steps get a Test bench first.** Recommended: `notes`, `meeting-pick` and `reformat` in 3b-1. Their input is one row, their output is small and typed, and their writer is one existing function. Then `speaker-roster`, `self-id` and `outputs` in 3b-2, whose writers bind contacts and speaker maps and need more care. The assistant steps (`chat`, `rag-summarize`, `rag-action-items`) get a "try it" with no Adopt: an answer to a question is not a stored result.
   - Alternative: all nine in one release. Costs about twice the review and puts the delicate writers (contact binding, transcript replacement) behind a button in the first build.
2. **Where candidates live.** Recommended: a table `pipeline_results(id, step, subject_id, plan_fingerprint, output_json, usage_json, estimated_cost_amount, created_at, adopted_at, replaced_json)`, as design section 11 says, with `replaced_json` holding what Adopt overwrote so an adoption can be undone.
   - Alternative: keep candidates in memory only. No schema change, but a trial is lost on restart and "run this step for 50 recordings and compare" is impossible.
3. **Moving the six direct sites onto the runner** (phase 2b recorded them but kept their code). Recommended: a separate phase 3c after 3b-1, because each of those sites sends an SDK-specific shape (a two-attempt strategy, `inlineData` images, one JSON bundle that carries eleven tasks), so they need their own task definitions and, for the analysis bundle, the split of design phase 5.
   - Alternative: never; they stay observed. The owner then cannot choose a harness for analysis, graph, timeline, image description or value rating.

## Global Constraints

- A trial writes nothing but `pipeline_results`. Adopt is the only thing that writes through a task's writer, and only when the owner clicks it.
- A task keeps today's gates: a recording that became ineligible gets no provider call, in a trial as in the real run (`shouldGenerate`, fail-closed).
- A trial's calls leave rows in the ledger like any call, so its cost is visible, with a flag that they were trials.
- No prompt or answer in a log or in the ledger; a candidate's output is stored only in `pipeline_results`.
- Code style, machine rules, commit rules and the secret gate of the earlier plans apply.

## Review Focus

1. A trial must never change the stored result, the search index, the speaker map or the recording's links; only Adopt does. Task 3.
2. Adopt must not overwrite a result the owner edited after the trial ran (the stored value changed since the candidate was made). Task 4.
3. A trial on a step whose input is large (a transcript) must respect the same excerpt limits as the real call, or it measures something else. Task 2.
4. A plan that names a harness that is down must say so in the trial, with the reason, not return an empty candidate. Task 3.
5. Deleting a profile that a step uses must be refused, and a preset must never save a plan the app cannot run. Tasks 6 and 7.

## File Structure

| File | Responsibility |
|---|---|
| `electron/main/services/pipeline/task-def.ts` | the `TaskDef` interface and `runTask(def, subject, options)` |
| `electron/main/services/pipeline/tasks/notes.ts`, `meeting-pick.ts`, `reformat.ts` | one task definition each, moved out of their call sites |
| `electron/main/services/pipeline/results-store.ts` | `pipeline_results` (schema 65): add, list, get, mark adopted, read-back for undo |
| `electron/main/ipc/pipeline-handlers.ts` | `pipeline:runTrial`, `pipeline:listResults`, `pipeline:adopt`, `pipeline:discard`, profile and preset channels |
| `src/features/settings/pipeline/TestBench.tsx` and `ResultsPanel.tsx` | pick a subject, run the draft, show the calls and the stored result side by side, Adopt, keep, discard |
| `src/features/settings/pipeline/ProfileManager.tsx`, `presets.ts` | create, duplicate, rename, delete (blocked while used), test connection; Recommended, Local only, Cheapest, Best quality |

## Tasks

1. **The task definition and `runTask`.** Interface: `TaskDef<Subject, Output> { step; load(subjectId): Subject | null; request(subject): RunTextRequest; parse(text): Output | null; stored(subjectId): Output | null; write(subjectId, output): void }` and `runTask(def, subjectId, { plan?, sink: 'real' | 'candidate' })`. Tests with a fake task: the real sink calls `write` once; the candidate sink never calls it; an ineligible subject makes no provider call; a parse miss returns the raw answer and a reason.
2. **Move the three call sites onto task definitions.** `analyzeNote` (notes), the LLM meeting pick, `reformatOne`: each keeps its prompt, its excerpt limits, its parser and its writer exactly, and the existing tests of each site must pass unchanged. A characterisation test per site records the request it builds today and fails if the task builds a different one.
3. **Trials.** `pipeline:runTrial({ step, subjectId, plan })` resolves the draft plan (the same validation as saving), runs `runTask` with the candidate sink, stores the candidate and returns the calls (harness, model, time, tokens, cost), the candidate and the stored result. Tests: nothing outside `pipeline_results` changes (a database diff); a down harness returns its reason; a trial of Automatic uses today's routing.
4. **Adopt and undo.** `pipeline:adopt(resultId)` re-reads the stored result, refuses with the reason when it changed since the trial, otherwise writes through the task's `write` and keeps the replaced value; `pipeline:undoAdopt` puts it back. Tests for each.
5. **The page.** Test bench in the row editor: choose a subject (a recent note, a recording with a transcript), run, see the calls and the two results; for enums and scores show agreement over a batch ("run for the last 20"). Design-skill review in a hidden window, light and dark, 1000 and 400 px, before the commit.
6. **Profile manager.** Create, duplicate, rename, delete (refused while a step uses it, naming the step), test connection (one tiny call through the harness, with the reason on failure).
7. **Presets.** Recommended (design section 12), Local only, Cheapest, Best quality: each is a function from the available harnesses to a configuration, validated before it is shown; a preset that cannot be satisfied says which step has no harness. Reset to recommended.
8. **Verification and delivery.** As in the earlier plans: typecheck, lint, secret gate, the whole suite, a separate reviewer, the design status, the pull request, CI, merge, cleanup.

## Self-review

- Spec coverage: design section 10 (Test on a recording, Profiles, presets) and section 11 (`pipeline_results`, Adopt, nothing overwritten without a click). Left out on purpose and named: stacked and parallel plans (design phase 5), gates on Jev signals (phase 6), the audio steps (phase 4).
- The three decisions above change the scope of tasks 2 and 3; the rest does not depend on them.
