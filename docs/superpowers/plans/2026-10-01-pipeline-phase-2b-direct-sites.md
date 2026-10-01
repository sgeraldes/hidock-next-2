# Pipeline Phase 2b: The Direct Gemini Sites Leave a Ledger Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every text call that reaches a model without going through the router leaves one row in the call ledger of phase 2a, with its time, its tokens and its cost, so the Pipeline page of phase 3a shows numbers for all text steps. Nothing about where those calls go, what they send or what they return changes.

**Architecture:** The six call sites keep their own code. Each call is wrapped in `withCallRecord` (phase 2a), which times it, collects the usage reported inside it, writes one row, and rethrows what the call throws. The SDK sites report their token counts with the helper the Gemini brain already uses. The two sites that call `complete()` of `@hidock/ai-providers` get their tokens through a usage reporter that the package calls after each completion and that the app registers once, so no call site and no test mock of `complete` changes. Choosing a harness for these steps is not part of this plan: it needs each site's input, parser and writer pulled out into a task definition (phase 3b).

**Tech Stack:** TypeScript, the Vercel `ai` SDK (v6) in `packages/ai-providers`, `@google/generative-ai`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-pipeline-design.md` (phases table, row 2b) and the inventory (rows 8, 9, 10, 14, 17, 18, 27). Phase 2a plan: `docs/superpowers/plans/2026-10-01-pipeline-phase-2a-runner.md`.

## Decisions made while the owner is away

1. Record-only. The design's phase 2b says "on the runner"; the runner needs a harness-neutral request (messages, options), and these sites send audio-free but SDK-specific shapes (a Gemini `generationConfig` with `thinkingBudget`, `inlineData` images, a two-attempt strategy with its own diagnostics). Moving them is the task-definition refactor of phase 3b. What the owner asked for first (usage and cost for all text calls) is delivered by recording.
2. One row per provider call, not per site call: the analysis makes up to two billed attempts and each is a row, as each is billed.
3. New steps: `analysis`, `actionable-detection`, `timeline`, `value-llm`, `graph-extract`, `image-describe`. They join `OBSERVED_STEPS`, so they never appear on the Pipeline page (it lists the steps that have a plan).

## Global Constraints

- No change in what any site sends, returns, throws or logs. A site that swallowed an error still swallows it (spec section 1, item 6).
- A failing ledger write never reaches the caller (`trackCall` contract).
- Prompts and answers never go in a row or in a log.
- Code style of the repository: no semicolons, single quotes, two-space indent, tests in a `__tests__` folder, `@vitest-environment node` on main-process tests. Source files use CRLF; patch scripts read and write binary and keep `\r\n`.
- Machine rules: heavy commands one at a time with `lowrun`; nothing in the foreground; no stderr redirection; no secrets in tests.
- Commits carry no attribution lines. Stage explicit paths. Before every push run the secret gate.

## Review Focus

1. A site whose call throws must still throw (or swallow) exactly as before, and its row must say `failed`. Tasks 3 and 4.
2. The usage of a retried call must not be summed onto the row of the first attempt. Task 3 (analysis).
3. A reporter that throws, or a response with no usage, must not break the call. Tasks 1 and 3.
4. The reporter must add nothing outside a tracked call (a manual timeline run, a chat message). Task 1.
5. The two `complete()` sites run inside loops (graph ingest of hundreds of transcripts): one row per call, no row for a transcript skipped before the call. Task 4.

## File Structure

| File | Responsibility |
|---|---|
| `packages/ai-providers/src/complete.ts` | `setCompletionUsageReporter`; `complete` reports provider, model, tokens and time after each completion |
| `electron/main/services/pipeline/steps.ts` | the six steps in `OBSERVED_STEPS` |
| `electron/main/services/pipeline/direct-calls.ts` | `registerCompletionUsage()` (maps the package's report to `recordHarnessUsage`) |
| `electron/main/services/pipeline/install.ts` | `installPipeline` also registers the reporter |
| `electron/main/services/brains/gemini-api-brain.ts` | `reportGeminiCall` is exported |
| `transcription.ts`, `timeline-analysis.ts`, `artifact-types.ts`, `value-classification.ts`, `knowledge-graph-service.ts` | each call wrapped in `withCallRecord` |

## Tasks

1. **The package reports usage.** Test first in the package: `complete` calls a registered reporter with `{ provider, model, inputTokens, outputTokens, durationMs }` after a completion; a reporter that throws does not change the result; no reporter, no error; a result without `usage` reports undefined tokens. Then `setCompletionUsageReporter(fn | null)` and the call in `complete`. Export it from `index.ts`. Rebuild the package.
2. **The app registers it, and the steps exist.** Test first: `registerCompletionUsage()` makes a `complete()` inside `trackCall` produce a row with `provider` (`google` is stored as `gemini-api`, so its price is known), the model and the tokens, and a `complete()` outside `trackCall` adds nothing; `installPipeline` registers it; the six steps are in `OBSERVED_STEPS`. Then `direct-calls.ts`, the `install.ts` call, the steps, and the export of `reportGeminiCall`.
3. **The SDK sites.** For each of the transcript analysis (both attempts), the timeline scorer and the image description, a test that sets a call sink, drives the real function with a mocked SDK, and asserts: one row per provider call with the right step, status `completed`, the model, the tokens; a call that throws gives a `failed` row and the function behaves as before (the analysis moves to its next attempt, the timeline scorer rethrows, the image returns its note); a response with no usage still writes a row. Then wrap each `generateContent` in `withCallRecord` and report the response with `reportGeminiCall`. `analyzeTranscriptWithGemini` takes an optional `recordingId` from its two callers.
4. **The brain site and the `complete()` sites.** The actionable detection wraps `brain.generate` (the brain reports its own usage). The standalone value rating and the graph extraction wrap `complete(...)`: tests assert one row per call with step, recording id, tokens, and that an ineligible or already-ingested transcript writes no row.
5. **Verification and delivery.** Typecheck, ESLint, secret gate, the whole suite, a review by a separate agent, the design status and inventory notes, the pull request, CI, merge, cleanup.

## Self-review

- Spec coverage: phase 2b of the phases table (usage and cost for all text calls) is covered by recording; moving the sites onto the runner is deferred to 3b with the reason in decision 1.
- Placeholders: none; the sites are named by file and the tests are named by behaviour.
- Types: `withCallRecord`, `trackCall`, `recordHarnessUsage` and `reportGeminiCall` come from phase 1 and 2a; `setCompletionUsageReporter` and `registerCompletionUsage` are defined in tasks 1 and 2 and used in task 4.
