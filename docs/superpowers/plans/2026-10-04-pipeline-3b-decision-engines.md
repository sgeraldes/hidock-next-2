# Pipeline 3b, decisions first: engines, presets, labels and a bench with real data

Owner's rulings (4-oct-2026), answering the outline `2026-10-01-pipeline-phase-3b-try-before-adopting.md`:

- "Esto debe ser configurable. Una opción 0 costo es importantísima, luego la menos costosa, luego la
  más accurate, y la más rápida. Me gustaría que todas marcharan, haiku no me parece buen resultado,
  pero necesito datos reales."
- A global preset with a per-step override. Presets, in order of importance: zero cost, cheapest, most
  accurate, fastest. Every preset has a fallback chain: when the gamestation is in a game or off, the
  next cheapest engine answers, and the ledger says so.
- Accuracy is measured against labels he gives: 40 recordings (20 where Jev doubted the kind, 20 where
  it did not), one click each.
- Engines compared: Clef and Clef-Flash on the gamestation, Jev, Claude Haiku, Gemini Flash.
- First the five decision steps: `kind-pick`, `identity-tiebreak`, `meeting-match`, `evaluate`,
  `sample-compare`. Then the rest of 3b (test bench for `notes`, `meeting-pick`, `reformat`, profile
  manager, Adopt).

Roles: Opus plans and reviews, Codex (gpt-6.1-sol, low effort) implements, a Sonnet subagent tests;
each part closes with its entry in `G:\Code\_briefing\dod`.

## Part 1: decision engines and presets (first PR)

- `pipeline/decision-engines.ts`: one interface, `ask(state, questions) -> JevResponse`, for five
  engines: `jev` (askJev), `clef` and `clef-flash` (decideOnModelHost), `haiku` and `gemini-flash`
  (a prompt that asks for one JSON answer per question, parsed into Jev's answer shape; an answer that
  does not parse is a failure, never a guess). Each engine has a descriptor: cost per call (zero for
  the host, list price for the LLMs, unknown for Jev until measured), where data goes, availability.
- `askDecision(step, state, questions)`: resolves the engine chain from `config.pipeline.decisions`
  (`preset` plus `overrides[step]`), tries each available engine in order, records a `pipeline_calls`
  row per attempt with route `decision:<engine>`, and returns the first answer. Default preset:
  zero cost (`clef-flash`, `clef`, then the cheapest paid engine).
- The five steps call `askDecision` instead of the Jev harness; `kind-pick` asks one `choice`
  question whose criteria are `RECORDING_KINDS` and whose state is today's excerpt, meeting subject
  and length, so its parsing and storage (`kind_llm`) stay as they are.
- Until the bench has data, cheapest, most accurate and fastest are ordered from the descriptors and
  the ledger's measured latency.

## Part 2: labels

A screen in Settings > Pipeline shows 40 recordings (20 with Jev's kind confidence under
`KIND_FALLBACK_MAX_JEV_CONFIDENCE`, 20 above, valid transcripts only) with the opening of the
transcript, and the owner picks the kind. Stored in `decision_labels(recording_id, question, answer,
labeled_at)`.

## Part 3: bench

Runs the kind question for the labeled recordings through every engine, stores the answers in
`decision_bench_results`, and shows per engine accuracy, median and p95 time and cost per call. The
four Jev steps get agreement with Jev, time and cost. The presets then read their order from these
results.

## Part 4: the rest of 3b

As in the outline: task definitions, test bench and Adopt for `notes`, `meeting-pick`, `reformat`;
profile manager; presets for the text steps.
