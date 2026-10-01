# Configurable AI pipeline: steps, plans and harnesses

Owner request, 30-sep-2026, in his words: "you should never run the harness with default config, it
should be stripped down, with the appropriate model"; "I need to be able to select each and every
step of the pipeline which harness AND model I want. A set of default or recommended ones are ok,
but I need flexibility! Some steps could even mean Jev or smaller models"; "I could also be using
local models for some steps. Completely configurable!"; "I need to be able to config the service so
I can do multiple passes in a single run, or split among different steps. Do I send to a single
harness and model to process one shot, or multiple stacked steps one after the other, or a
combination? A new pipeline system needs to emerge from this."

Status: approved by the owner on 30-sep-2026; the four decisions of section 16 were taken that day and
are reflected below. Built so far: phase 0 (PR #113), phase 1 (PR #118) and phase 2a (PR #120).

## 1. What we want

1. Every AI step of the app can be pointed at any harness and model that can do it, with its own
   thinking level, from Settings. A recommended default ships for each step, so nothing has to be
   configured to get today's behaviour.
2. A step can run as one shot (one call), with a fallback, as stacked passes (a draft, then a refine
   or a check), as several models at once with a merge rule, or with its input split. Several small
   tasks can share one call (a bundle) or each run alone.
3. A harness is always run stripped down. Nothing loads a tool, a plugin, a hook, a project file or a
   session that the task does not use.
4. Local models are first-class: Ollama, any OpenAI-compatible server on this machine or the LAN,
   ONNX models, and Jev.
5. What each call costs and how long it takes is recorded for every harness and shown per step, and a
   step can be tried on a real recording with the result next to the current one before it is
   adopted.
6. With no configuration the app behaves as it does today.

Not in scope: a general workflow builder, user-written code, prompt editing (the Prompts page in the
Settings redesign owns that), and the local heuristic steps (voice activity, reconcile, wiki export,
quality rules), which only get an on/off switch later.

## 2. What exists today (inventory, 30-sep-2026)

27 places call a model. The full table is in `2026-09-30-pipeline-design-inventory.md`;
the facts that shape the design:

- Eight of them bypass the `BrainRouter` and call an SDK or the Jev API directly: the transcript
  analysis, action-item detection, the timeline, the LLM value rating, the graph ingest, image
  description, the Jev calls and all the transcription engines. The router covers chat, self-ID,
  roster inference, meeting pick, reformat, outputs, notes, handover and embeddings.
- The model or harness is chosen six different ways: `transcription.geminiModel`, `chat.geminiModel`,
  `brains.defaultBrain`, `brains.taskRouting`, `decisions.jev*` and constants in the code. The Settings
  UI writes only `taskRouting.embed`.
- One Gemini call returns the summary, title, action items, topics, key points, questions, mentioned
  people, language, meeting pick and value together, and three processing-run stages
  (`summary`, `title`, `meeting-resolution`) share it. Those tasks cannot take different models.
- Usage and cost are recorded only for Gemini paths. The Jev calls, the graph ingest and image
  description record none.
- The CLI harnesses (Claude Code, Codex, Gemini CLI, Kiro) were started with the machine's default
  configuration. For Claude Code that meant every hook, plugin, MCP server and project file, and the
  account's default model: 15.8 s for a one-word answer against about 5 s stripped down (measured
  30-sep-2026), and quota spent on tooling. Phase 0 fixes this for Claude Code and Codex.
- Where the time goes (pipeline cost plan, 125 recordings, 103 h of audio): diarization 55 h,
  transcription 5.1 h, search indexing 0.9 h, summary 0.2 h, action items 0.1 h, timeline 0.1 h. The
  text steps are seconds per recording, so choosing their model matters for quality, quota and
  privacy more than for time, except in bulk jobs (a backfill of 2,000 recordings).

## 3. Vocabulary

| Word | Meaning |
|---|---|
| Task | The smallest unit of AI work, with a typed input, a typed output and one place it is saved: `summary`, `title`, `action-items`, `topics`, `key-points`, `questions`, `mentioned-people`, `meeting-pick`, `value`, `evaluation`, `sentiment-timeline`, `self-id`, `speaker-roster`, `meeting-match`, `graph-extract`, `image-describe`, `note-analysis`, `reformat`, `chat`, `output-document`, `handover`, `embed`, `transcribe`, `diarize`. |
| Step | What the owner configures in Settings: one or more tasks that run together in the flow. `understand` holds summary, title, topics, key points, questions, people, language and meeting pick. `action-items`, `timeline`, `evaluate`, `speaker-names`, `meeting-match`, `graph`, `images`, `notes`, `reformat`, `chat`, `outputs`, `handover`, `embed` and `transcribe` are steps too. |
| Harness | Something that can run a model: `gemini-api`, `ollama`, `openai-compatible` (LM Studio, llama.cpp server, vLLM), `claude-code`, `codex`, `gemini-cli`, `kiro`, `jev`, `local-onnx`, the ASR engines. |
| Profile | A named harness plus model plus settings (thinking level, temperature, output limit, timeout). Reused by any number of steps. |
| Call | One request to a profile carrying one or more tasks (a bundle). |
| Plan | How a step is executed: an ordered list of passes; a pass is one or more calls that run together. |
| Preset | A named set of plans for every step: Recommended, Local only, Cheapest, Best quality, Custom. |

## 4. Approaches considered

A. Extend the `BrainRouter` with a per-task model and effort. Smallest change. The router is
   chat-shaped: it returns one string from one brain, it has no notion of a task with a typed
   output, of a pass, or of a merge, and eight call sites do not go through it. Stacked passes would
   be bolted on outside it.

B. A pipeline module above the brains (recommended). Tasks, plans and a runner are new; the brains
   become the harness adapters underneath, keeping their auth, cooldown, lean invocation and tests.
   Call sites stop choosing a provider and ask the runner for a step. One place records usage and
   cost. Larger, but every requirement in section 1 has a place to live.

C. Adopt an orchestration library (LangGraph, LangChain, an agent framework). Brings a dependency and
   a model of the world (chains, agents, tools) that does not match CLI harnesses or the app's
   privacy gates. The `ai` SDK already used by `packages/ai-providers` can stay as the model layer
   for API harnesses inside B.

The rest of this document describes B.

## 5. Architecture

```
Settings > Pipeline  ──writes──►  config.pipeline (validated, versioned)
                                       │
call sites  ── runStep('understand', ctx) ──►  PipelineRunner
                                       │            │  resolves the plan, checks capabilities,
                                       │            │  orders passes, runs calls, merges, retries,
                                       │            │  records runs, applies gates and budgets
                                       ▼            ▼
                                 Task catalog     Harness adapters (brains + new)
                                 (prompt, schema,   lean invocation, capabilities, model discovery,
                                  parser, sink)     usage and cost, cooldown
```

New module `electron/main/services/pipeline/`:

- `types.ts`: `TaskDef`, `StepDef`, `Profile`, `Plan`, `Pass`, `Call`, `MergeRule`, `Condition`.
- `catalog/`: one file per task family. Each `TaskDef` says what it reads (`transcript`,
  `excerpt`, `audio`, `image`, other tasks' outputs), the output contract (JSON schema and parser),
  the sink (which table and column, through the existing writers), the capabilities it needs and its
  recommended profile.
- `profiles.ts`: profile registry, availability (installed, signed in, in cooldown), model discovery.
- `runner.ts`: the plan interpreter. `merge.ts`, `conditions.ts`, `budget.ts`, `run-record.ts`.
- `presets.ts`, `migration.ts` (legacy keys to `pipeline`), `contracts.ts` (structured output).
- Harness adapters stay in `services/brains/` and gain a capability descriptor. New adapters:
  `openai-compatible-brain.ts`, `jev-harness.ts` (Jev's Score/Choice/Noul primitives behind the same
  interface, usable only by tasks that map to them).

The macro order of a recording (voice activity, diarization, transcription, understanding, ...) stays
in `transcribeRecording`. Each AI stage inside it becomes `runStep(...)`. The order between AI steps
follows data dependencies the catalog declares (`action-items` may read `evaluation`), which is what
lets a gate such as "skip action items when Jev says there are none" run before the expensive call.

## 6. Harness layer

Every harness has one invocation shape for text work, and it is the lean one. A run for an agent that
works in a repository (handover) is the only exception and says so (`cwd`).

| Harness | Kind | Lean text invocation | Model discovery | Effort | Structured output | Latency class |
|---|---|---|---|---|---|---|
| gemini-api | API | SDK, thinking off or a level | list models API | `thinkingLevel` or budget | native `responseSchema` | fast (about 1-3 s) |
| ollama | local | HTTP, `format: json`, `keep_alive` | `/api/tags` | none (model dependent) | `format` schema | depends on hardware |
| openai-compatible | local or LAN | HTTP chat completions | `/v1/models` | none | `response_format` when supported | depends on hardware |
| claude-code | CLI | `-p --strict-mcp-config --disable-slash-commands --tools= --no-session-persistence --setting-sources= --output-format json --system-prompt <one line>`, empty working folder, prompt on stdin | aliases (`haiku`, `sonnet`, `opus`) and full names | `--effort` | `--json-schema` (to verify) or prompt plus repair | slow (5-15 s per call) |
| codex | CLI | `exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --color never`, empty folder | from the CLI | `model_reasoning_effort` | `--output-schema` or prompt plus repair | slow |
| gemini-cli, kiro | CLI | kiro: `chat --no-interactive --trust-tools=` plus `--effort`, already at its floor (5 s a call, measured 30-sep-2026); gemini-cli: default flags, lean flags not measured because the CLI answers only with a key in the shell | from the CLI | none | prompt plus repair | slow |
| jev | special | HTTP, primitives only | fixed | none | native (Choice, Score) | fast |
| local-onnx, ASR engines | local | in process or Python worker | from disk | none | none | audio, heavy |

Rules:

1. A harness declares capabilities (`audio`, `vision`, `jsonSchema`, `longContext`, `streaming`,
   `agentic`, `local`) and a latency class. A task lists what it needs; the UI offers only harnesses
   that satisfy it and the runner refuses the rest with a message that names the missing capability.
2. Structured output is a contract, not a prompt habit. A task has a JSON schema. The adapter uses
   the native mode where it has one; otherwise the prompt carries the schema, the lenient parser
   reads the answer and, if it fails, one repair call by a cheap profile fixes the JSON. Today's
   `repairJsonString` and repair retries move into this layer.
3. A CLI harness takes 5-15 s a call even stripped down. The runner marks a `slow` profile on a step
   that runs per item in a bulk job and asks for confirmation once when the plan is saved.
4. Privacy is a property of the profile: `dataLeavesMachine` and the vendor. The Pipeline page shows
   it on every step, and the Local only preset refuses any profile that sends text out.
5. Prompts never go in argv and never in the log; only constants do. Failures are logged through
   `summarizeCliFailure`. Secrets stay in the credential store.
6. Quota: a harness that reports being out of quota rests until its reset (`brain-cooldown`); the
   runner treats a resting profile as unavailable and uses the fallback.

### Audio engines and embeddings

The owner put every step in scope, so `transcribe`, `diarize` and `embed` are steps with profiles like
the others. What differs is that their engines are not interchangeable, so the capability descriptor
does more work here.

| Step | Engines (harnesses) | Capabilities that matter |
|---|---|---|
| transcribe | `gemini-transcribe` (native, rolling and chunked paths), `local-asr` (Cohere transcribe), `vibevoice`, `model-host` when it serves transcription | `audio`, `timestamps`, `diarization`, `maxAudioMinutes`, `languages` |
| diarize | `pyannote-onnx` on this machine, `model-host` | `audio`, `segments`, `voiceVectors` |
| embed | `local-onnx-embed`, `ollama`, `gemini-embedding` | `embedding`, `dimensions` |
| live-transcribe | `gemini-live` | `audio`, `streaming` (realtime only, not part of a recording's flow) |

Rules:

1. `transcribe` needs timestamps. A transcriber without diarization is valid only while the `diarize`
   step is on, because the speaker labels then come from its segments (the pairing the app makes
   today for the local engines). The runner refuses a pair that leaves the transcript without
   speakers and names the missing capability.
2. Audio calls belong to the `audio` resource class: the existing queue, one heavy job at a time, and
   the display-GPU rule. A fallback engine for `transcribe` is allowed but marked `slow`: a failed
   two-hour recording costs its time twice.
3. Changing the `embed` profile changes the vector space. Saving the plan asks for confirmation and
   starts the reindex the app already runs when the embedding route changes; the old index stays
   until the new one is complete.
4. The Test bench works on audio steps too, on one recording chosen by the owner, with progress and
   the same candidate and Adopt flow. A diarization or a transcript is compared by speaker count,
   segment boundaries and word error against the stored one, not by reading both.
5. Each engine keeps its own page for what is not a choice of model (paths, tokens, the Model Host
   URL). The choice of engine moves to the Pipeline page and the old page shows it read only,
   linked to the new one.

## 7. Plans

A plan is the answer to the owner's question: one shot, stacked, or both.

```
Plan   := { passes: Pass[] }                         // 1 to 3 passes
Pass   := { calls: Call[], merge?: MergeRule }       // 1 to 4 calls, run together
Call   := { profile, tasks: TaskId[] | '*', role, when?: Condition, onFail? }
role   := 'produce' | 'refine' | 'verify' | 'judge'
```

The shapes people ask for are all plans:

| Shape | Plan |
|---|---|
| One shot | 1 pass, 1 call, `tasks: '*'` (today's transcript analysis) |
| Split among steps | 1 pass, several calls with disjoint task sets, run together; or several passes when one call needs another's output |
| Fallback | `onFail: { profile: 'local-qwen' }` on the call; also used for a resting or missing profile |
| Stacked | pass 1 `produce` with a cheap profile, pass 2 `refine` or `verify` with a stronger one; pass 2 receives the source and pass 1's outputs |
| Ensemble | 1 pass, several `produce` calls for the same tasks, `merge: vote | union | first-valid | prefer:<profile> | judge` |
| Gated | `when: { task: 'evaluation.hasActionItems', lt: 0.2 }` on the `action-items` call: skipped, and the skip is recorded |
| Split input (later) | `split: { by: 'time' | 'section' | 'tokens', size }` on a pass, one call per part, then a `reduce` pass |

Semantics:

- `produce` creates task outputs from the source. `refine` gets the source and the previous outputs
  and returns the final ones. `verify` returns `ok` or corrections that the runner applies. `judge`
  reads the candidates of an ensemble and returns the chosen or merged output.
- Only the last pass's outputs reach the sinks. Earlier outputs stay in the run records, so a bad
  refine can be compared with its draft.
- A failed call never loses the other calls' outputs: a bundle keeps every task that parsed, and the
  missing tasks are retried alone or filled by the fallback.
- Limits keep plans understandable and bounded: at most 3 passes, 4 calls in a pass, a timeout per
  call, and a token or cost budget per recording (default: none; the stop policy is `skip-rest`).
- A plan is validated when it is saved and again when the runner loads it: every task of the step is
  produced exactly once by the last pass that touches it, every profile exists, capabilities match,
  dependencies form no cycle. An invalid plan is never run; the step falls back to the preset's plan
  and the Pipeline page shows a warning with the reason.

## 8. Configuration

A new `pipeline` section in `AppConfig`, versioned, validated with zod, edited only through the
Pipeline page (and importable and exportable as JSON).

```jsonc
"pipeline": {
  "version": 1,
  "preset": "recommended",
  "profiles": {
    "gemini-flash": { "harness": "gemini-api", "model": "gemini-3.8-flash", "thinking": "off" },
    "claude-haiku": { "harness": "claude-code", "model": "haiku", "effort": "low" },
    "local-qwen":   { "harness": "ollama", "model": "qwen3:8b", "temperature": 0.2 },
    "jev":          { "harness": "jev" }
  },
  "steps": {
    "understand": { "passes": [ { "calls": [ { "profile": "gemini-flash", "tasks": "*", "role": "produce" } ] } ] },
    "action-items": {
      "passes": [ { "calls": [ { "profile": "gemini-flash", "tasks": "*", "role": "produce",
                                 "when": { "task": "evaluation.hasActionItems", "gte": 0.2 } } ] } ]
    },
    "speaker-names": { "passes": [ { "calls": [ { "profile": "jev", "tasks": "*", "role": "produce",
                                                  "onFail": { "profile": "claude-haiku" } } ] } ] }
  },
  "budget": { "perRecordingUsd": null }
}
```

Migration (`migration.ts`): the first start after the update builds `pipeline` from the legacy keys so
the behaviour is identical: `transcription.provider/geminiModel` to `transcribe`, `chat.geminiModel`
to `understand`, `action-items`, `timeline`, `graph`, `images`; `brains.defaultBrain/taskRouting` to
`chat`, `outputs`, `handover`, `notes`; `decisions.jev*` to `evaluate`, `meeting-match`,
`speaker-names`; `transcription.speakerEngine` and the Model Host settings to `diarize`;
`embeddings.*` and `brains.taskRouting.embed` to `embed`. Legacy keys stay readable for one release. The
existing pages (AI providers, Decisions, Transcription) become views over the same keys ("one setting,
two pages", Settings redesign) and are removed once the Pipeline page covers them.

## 9. The runner

1. Resolve: read the step's plan, replace a resting or unavailable profile by its `onFail`, drop calls
   whose `when` is false, order the passes.
2. Gate: before every call, re-check the source is still eligible (`shouldGenerate`, fail-closed, as
   the router does today). An ineligible source ends the step with nothing written.
3. Cache: key = task ids + prompt version + input hash + profile fingerprint. A re-run of the same
   plan on the same input reuses the outputs and spends nothing.
4. Execute: calls of a pass run together under resource limits. The classes are `cloud-api` (per
   vendor rate limit), `cli` (2 at a time, they start a process), `local-cpu` and `local-gpu` (one
   heavy job at a time; a call on the display GPU stays under 50 ms per batch or falls back to CPU;
   these are the machine rules of the owner), and `audio` (the existing queue).
5. Parse: the contract parses each task's output; a task that fails to parse is retried alone once,
   with the repair call, then falls back.
6. Merge: apply the pass's merge rule; run `verify` corrections.
7. Persist: write the final outputs through the existing sinks. When the step is a candidate run (the
   Test bench, or "re-run with another plan"), the outputs go to `pipeline_results` instead
   (section 11).
8. Record: one `pipeline_calls` row per call (`step`, `route`, `provider` = harness, `model`,
   `usage_json`, `estimated_cost_*`, `parent_call_id` = the attempt that failed before it, with or
   without a recording); `processing_runs` keeps the per-recording stages the reader shows. Cost
   tables per harness: Gemini has one; the CLIs report tokens when their JSON output allows it,
   otherwise the duration; local models record duration. Every AI call gets a row, including the Jev
   calls, graph ingest and image description that record none today.
9. Report: progress events to the Operations panel; errors name the step, the call and the profile.

## 10. Settings > Pipeline

A page under Services in the redesigned Settings.

- Top bar: preset selector (Recommended, Local only, Cheapest, Best quality, Custom), Reset to
  recommended, Export and Import.
- One table of steps in execution order, grouped (Audio, Understanding, Speakers, Classification,
  Knowledge, Interactive). Each row shows the plan as a chain of chips
  (`Gemini 3.8 flash · off` then `Claude Haiku · low`), a privacy badge, and the median time and cost
  of the last 30 days from `processing_runs`.
- Row editor: plan shape (One shot, Fallback, Stacked, Several at once, Split), then the calls. Per
  call: harness (only what is installed and signed in; the rest greyed with the reason), model
  (combobox with discovered models and free text), thinking level, temperature, output limit,
  timeout. A task matrix for bundles: which tasks a call carries. Conditions. The editor shows the
  validation message live.
- Test on a recording: pick a recording, run the draft plan now, see each call's output, time, tokens
  and cost and the current stored result side by side. Adopt, keep as a candidate, or discard.
- Profiles: create, duplicate, rename, delete (blocked while a step uses it), test connection.
- Nothing here needs a restart.

## 11. Evaluating a change

A model swap can change results silently. Two mechanisms:

- The model and the plan fingerprint are stamped on every result (`processing_runs` already has
  `model`).
- `pipeline_results(recording_id, step, plan_fingerprint, output_json, created_at, adopted_at)`
  holds candidate outputs. "Re-run this step for N recordings with plan X" writes candidates only.
  The Pipeline page shows agreement and differences (for enums and scores: how often they agree; for
  text: side by side) and Adopt writes to the sinks. Nothing is overwritten without the owner's
  click, in line with the rule that a change goes next to the old version.

## 12. Recommended defaults

Chosen to keep today's behaviour and to fix what measurement showed. Each one is a starting point to
be checked with the Test bench on the owner's recordings before the preset is called done.

| Step | Recommended profile | Why |
|---|---|---|
| transcribe | gemini-3.5-transcribe (unchanged) | the model with timed, diarized output in one pass; the local engines need the diarize step |
| diarize | ONNX on this machine, Model Host when present (unchanged) | audio, heavy |
| understand | Gemini 3.8 flash, thinking off, one shot (unchanged) | 5.8 s a recording, JSON native |
| action-items, timeline | Gemini 3.8 flash, thinking off, `action-items` gated by Jev's `hasActionItems` | 1.4 s and 2.4 s; the gate removes most calls |
| evaluate, value, meeting-match, speaker-names | Jev | classification primitives, fast, cheap |
| self-id, speaker-roster (LLM path) | Gemini flash lite or a local 7-8B model | bulk, short input, JSON |
| meeting-pick, notes, titles | Gemini flash, thinking off | short |
| reformat | Gemini flash | 12,000-character blocks, many calls |
| graph | Gemini flash, thinking off | one call per transcript, in the background |
| images | Gemini flash | vision |
| chat | Gemini 3.8 flash, thinking low | interactive, quality matters |
| outputs | a stronger model, thinking medium | documents, low volume |
| handover | Claude Code or Codex in agentic mode | needs tools and a repository |
| embed | unchanged; changing it reindexes (section 6, rule 3) | vector spaces differ per model |

The owner's current default brain (`claude-code`) becomes an explicit choice for `chat` and
`handover`; the bulk steps do not inherit it. That is the fix for the speaker-naming re-run that
crawled when every LLM call started `claude -p`.

## 13. Phases

Each phase has its own plan, tests, adversarial review and PR series.

| Phase | Content | Behaviour change |
|---|---|---|
| 0 | Lean invocation for Claude Code and Codex; `effort` in `GenerateOptions`; empty working folder. Built (PR #113). | faster CLI calls; no tools or hooks loaded |
| 1 | Capability descriptors on every adapter, audio and embedding engines included; OpenAI-compatible adapter (with Ollama); Jev harness wrapper; model discovery; lean flags for Gemini CLI and Kiro (measured); structured-output contract with repair; cost and usage for every adapter. Built (PR #118); the Gemini CLI flags were not measured for lack of a key in the shell | none visible |
| 2a | Text runner with `single` and `fallback`, the `pipeline_calls` ledger, default plans that keep today's routing; the nine text call sites that go through the router and the three Jev call sites on it. Built (PR #120). | a ledger row per call with time, tokens and cost; no change in results |
| 2b | The six text call sites that call the Gemini SDK directly (analysis bundle, action detection, timeline, LLM value rating, graph ingest, image description) on the runner | usage and cost for all text calls |
| 3 | `pipeline` config, migration, Settings > Pipeline for single and fallback plans on the text steps, profiles, Test bench, `pipeline_results` and Adopt | the owner can choose harness, model and effort for every text step |
| 4 | The audio steps join: `transcribe`, `diarize`, `embed` and `live-transcribe` through the same runner and page, with the pairing rules and the reindex confirmation of section 6; their old pages show the engine read only | the owner can choose the engine of every audio step |
| 5 | Stacked passes, ensembles and merge rules; splitting the `understand` bundle into separate tasks | new shapes available |
| 6 | Gates on Jev signals, split-input and reduce, presets, recommendations from history | cost and time drop on gated steps |

Phase 3 answers the first half of the request (a harness, a model and an effort per step) for the
text steps and phase 4 completes it for every step. Phase 5 answers the second half (passes and
splits), after the Test bench exists to judge them (owner decisions 1 and 3).

## 14. Testing

- Plan interpreter: fake harnesses that answer from scripts (valid, invalid JSON, slow, out of quota,
  throwing). Every plan shape, every merge rule, gates, budgets, cancellation by the eligibility gate,
  partial bundles, cache hits, cycles and validation errors.
- Adapters: fake spawn and fake HTTP; the exact argv of each lean invocation is asserted, and that no
  prompt appears in argv or in a logged failure.
- Catalog: golden JSON fixtures per task (real answers from Gemini, Claude, a local model) through the
  parser and the repair path.
- Migration: legacy configs from the owner's real file (secrets removed) produce plans equal to
  today's calls.
- Settings page: component tests for the editor and the validation messages; a hidden-window render
  as done for the Library rows.
- Real path: the Test bench run against a real recording with each installed harness before a phase
  is called done.

## 15. Risks

- Prompt portability: the prompts are tuned to Gemini's JSON mode. Other models need the schema in the
  prompt and the repair path; quality per task per model is measured with the Test bench, not
  assumed.
- Silent quality change: covered by section 11. No default changes without a preset change the owner
  approves.
- Complexity of plans: capped at 3 passes and 4 calls, validated on save, and the UI leads with the
  four common shapes. Split-input and reduce wait for phase 6 to see whether they are asked for.
- Local model resources: the runner's resource classes keep one heavy job at a time and protect the
  display GPU.
- Audio engines are not interchangeable: an engine without timestamps or speakers cannot serve the
  transcript the rest of the app reads. The capability check refuses those pairs before a recording
  is spent on them, and the phase 4 tests run every engine pair on a real recording.
- A changed embedding profile invalidates the index. Confirmation on save, and the old index stays
  until the new one is complete, so search never goes blank.
- CLI latency: shown as a latency class and confirmed once for bulk steps; not hidden.
- Two ways to configure during migration: the existing pages read and write the same keys until they
  are removed.

## 16. Decisions (owner, 30-sep-2026)

1. Scope of the first release: every step, the audio engines included (transcription, diarization,
   embeddings, live transcription). The design recommended text steps first, and the owner chose the
   full scope. The audio steps come in phase 4, on the same runner and page, with the pairing and
   reindex rules of section 6.
2. Local models: Ollama and any OpenAI-compatible server (LM Studio, llama.cpp, vLLM), in phase 1.
3. Stacked and parallel plans: right after the per-step choice (phase 5), once the Test bench exists.
4. Candidate results and Adopt (section 11) for re-runs and the Test bench; the normal pipeline still
   writes straight to the sinks.
