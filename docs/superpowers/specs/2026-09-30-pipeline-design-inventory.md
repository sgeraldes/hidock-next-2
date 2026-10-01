# Inventory of AI call sites (input to the pipeline design)

Read from the main checkout at `1399564`, 30-sep-2026. Companion to
`2026-09-30-pipeline-design.md`. Paths: `S` = `apps/electron/electron/main/services`,
`E` = `packages/transcription/src/engines`, `I` = `apps/electron/electron/main/ipc`,
`R` = `apps/electron/src`.

## Call sites

| # | Step | Call site | What it does | Trigger | How provider and model are chosen | I/O and size | Fallback or retry | Persisted | Hazards for another model |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Transcribe, Gemini native | `E/gemini-engine.ts:1187` (via `S/transcription.ts:1165`) | Files-API upload, then `interactions.create` with word timestamps and diarization | per recording (queue) | `transcription.provider='gemini'` and `transcription.geminiModel`; the engine branches on the literal `gemini-3.5-transcribe` (`:1597`); per-item override `transcription_queue.provider` | audio in, timed turns out; chunks of at most 20 min | halves a chunk on `incomplete` or short coverage (floor 60 s, depth 10); SDK `maxRetries:0`, 10 min timeout; queue retry 30 s·2^n capped at 120 s, up to `quality.maxRetries` | `transcripts.*`; run `transcription` with tokens and cost | audio only; only this model serves `transcription_config`, `custom_vocabulary` and word timestamps |
| 2 | Transcribe, rolling Interactions | `E/gemini-engine.ts:1406` | 20-min ranges chained by `previous_interaction_id`, JSON-schema response | same, for models matching `/^gemini-(3\|[4-9])/` over 20 min | same keys | audio in; `max_output_tokens` 16384 | `incomplete` splits the range | same | `response_format` schema and `thinking_level:'minimal'` are Interactions-only |
| 3 | Transcribe, chunked `generateContentStream` | `E/gemini-engine.ts:1708` | chunked streaming with `responseSchema` | same; also the fallback for m4a/ogg/flac the native path cannot cut | `geminiModel` or fallback `chat.geminiModel` | audio in; maxOutput 65536; inline up to 14 MB, else Files API | retries without thinking on INVALID_ARGUMENT, retries on MAX_TOKENS, one repair-prompt retry | same | `ThinkingLevel.MINIMAL` gets a 400 on gemini-3.8-flash (`:1663`); streaming |
| 4 | Transcribe, local ASR | `S/transcription.ts:1266` | spawns `mcp_runner.py asr_mcp.cli`, model `CohereLabs/cohere-transcribe-03-2026`, optional `--diarize` | same, `provider='local-asr'` | `localAsr*` keys; model name hard-coded | audio in, JSON segments | queue retry only | same | needs the external Python project |
| 5 | Transcribe, VibeVoice | `S/transcription.ts:1371` | same runner with `--backend vibevoice` | same, `provider='vibevoice'` | `vibevoice*` keys; persisted label hard-coded | same | same | same | same as 4 |
| 6 | Live transcription | `S/gemini-live-transcription.ts:407` | Gemini Live session per channel, rotated every 9 min | user starts realtime | hard-coded `gemini-3.5-transcribe-live`; `transcription.language`; `quality.liveSilenceRms` | PCM16 stream in, interim and final text | reconnect on close | events to the renderer; audio saved as a recording unless `liveSaveRecording=false` | streaming, live-only model |
| 7 | Diarization / voice-ID | `S/speaker-linking.ts:1014`, `:380`, `:658`, `S/model-host-client.ts:161` | pyannote, ONNX (wespeaker + segmentation-3.0) or Model Host produce segments and voice vectors, matched to voice clusters | per recording before transcription (`transcription.ts:2362`); `recordings:reDiarize` | `transcription.speakerEngine` through `resolveSpeakerEngine`, gated by `speakerLinkingEnabled`; model pinned to the library | audio in; budget max(600 s, 1.5×duration) | Model Host failure goes to local; DirectML failure goes to CPU; unavailable degrades to provider-managed diarization | `voice_clusters`, `recording_voice_clusters`, `voice_cluster_observations`; runs `diarization`, `voice-id` | voice IDs valid in one model's space only; single voice slot |
| 8 | Transcript analysis | `S/transcription.ts:1631` (called `:2587`) | one prompt returns summary, action items, topics, key points, title, questions, language, mentioned people, project, meeting pick and value | per finished transcript | direct SDK with `chat.geminiModel`; not via BrainRouter | full transcript in, JSON out | two attempts (plain, then `responseMimeType`), `thinkingBudget:0`, maxOutput 8192; double failure gives `{summary:'Analysis failed'}` | `transcripts.*` summary fields; `recording_meeting_candidates`, `recordings.meeting_id` (auto-link gates 0.85 / 0.15 at `:2660`); `knowledge_captures.quality_*`; projects; runs `summary`, `title`, `meeting-resolution` (one call, usage only on `summary`) | fixed JSON shape, lenient parser, `thinkingBudget:0` |
| 9 | Actionable detection | `S/transcription.ts:1002` (called `:2888`) | detects follow-up outputs, JSON array | per transcript; skipped under 100 words, without a key, or if value-excluded | `getBrainRegistry().get('gemini-api').generate` directly; `taskRouting.suggestions` not applied; `chat.geminiModel`, `json:true`, `disableThinking:true`, maxTokens 8192 | last 5,000 words in | catch returns `[]`; no retry | `actionables`; run `actionable-detection` | Gemini options; template ids whitelisted to 5 |
| 10 | Timeline sentiment | `S/timeline-analysis.ts:594` (called `transcription.ts:2979`) | one call scores all ~45 s windows in -1..1 | per transcript; `recordings:analyzeTimeline` | direct SDK, `chat.geminiModel`; key from plain `config.transcription.geminiApiKey` (`:573`) | whole transcript in one call, maxOutput 4096 | failure omits sentiment, `sentimentAnalyzed:false`; no retry | `transcripts.sentiment_segments`, `event_markers`; run `timeline-analysis` | `thinkingBudget:0` |
| 11 | Self-identification | `S/self-identification.ts:480` (called `transcription.ts:3077`) | names speakers from first-person introductions | per transcript, only with a lexical cue; `self-id:*` IPC | BrainRouter task `chat` through `chat-llm`; temp 0, maxTokens 1024 | short cue turns in, JSON array out | router walks the whole chain | speaker map and contacts, markers `self_id:scanned:*`; part of run `speaker-identity` | any brain works |
| 12 | Speaker inference | `S/speaker-inference.ts:374` (Jev) / `:393` (LLM) | names remaining labels from a roster | per transcript after self-ID; `self-id:inferSpeakers` | `jevKeyFor('speakerNames')` selects Jev, else task `chat` | short | no Jev-to-LLM fallback | speaker map | Jev choice-questions versus a free-text JSON array |
| 13 | Jev evaluation | `S/value-classification.ts:466` to `S/jev-client.ts:63` | one call with 12 questions (stars, kind, context, invented, overfull, action items, sensitive, 5 reasons) | after each transcript (`scheduleEvaluationCatchup`) and a boot task; `value:startBackfill` | `jevKeyFor('value')`; model `jev-latest` | 8,000-character excerpt + summary + subject + audio stats | none in the client, 30 s timeout; backfill retries 1/2/4 s (×3 on rate limit) plus durable attempts | `recording_evaluations`; `knowledge_captures.quality_*`; no processing run | Jev primitives, not a prompt |
| 14 | Value via LLM | `S/value-classification.ts:681` | same rating as JSON, when Jev is off | catch-up / backfill | `getProviderConfigFromSettings()` needs `chat.provider==='gemini'` and the plain key; bypasses the router | same excerpt | same backfill retries | same minus the evaluation row | no usage recorded |
| 15 | Jev meeting match | `S/jev-meeting-match.ts:218` | choice among at most 12 candidate meetings plus "none" | user opens candidates; `maintenance:matchMeetings` | `jevKeyFor('meetingMatch')` | 2,500 head + 800 tail characters + summary + candidates | stored answer reused while the candidate key is unchanged | `recording_meeting_matches`; auto-link at p≥0.7 and margin≥0.25 | Jev only |
| 16 | LLM meeting pick | `S/meeting-disambiguation.ts:84` | picks one of two or more overlapping meetings | same dialog when Jev returns nothing | task `chat` | short | fail-soft null | not persisted | expects a bare integer |
| 17 | Graph ingest (DB) | `S/knowledge-graph-service.ts:223`, extract `:309` | entity extraction | 60 s debounce after `entity:transcript-ready`; `graph:ingestAll` | `getGraphProviderConfig()`: Gemini key from the credential store + `chat.geminiModel`; bypasses the router | full transcript in | errors kept per transcript and retried next pass | `graph_nodes`, `graph_edges`, `graph_ingested_transcripts`; run `graph-sync` records only the event | prompt-only JSON; no usage recorded |
| 18 | Graph ingest (folder) | `S/knowledge-graph-service.ts:434`, `:466` | same over files | `graph:ingestFolder` | same | file text | same | same | same |
| 19 | Embed passages | `S/brains/brain-router.ts:302`; adapters `gemini-api-brain.ts:199`, `local-onnx-embed-brain.ts:74`, `S/ollama.ts:117` | index chunks | per transcript; note save; artifact import; reindex on brain enable or `embed` route change | `taskRouting.embed`, then Gemini if keyed, then gemini → local-onnx → ollama; model ids hard-coded; only `embeddings.ollamaModel` configurable | text in, vectors out; 500-character chunks, batches of 100 | a throw moves to the next candidate | `vector_embeddings`; run `rag-indexing` | vector spaces incomparable (3072/2048/768); switching means reindex; `purpose` query/passage matters |
| 20 | Embed query | `S/vector-store.ts:1090`, `:1275` | embeds the search query | every RAG question or search | same router | short | same | none | must match the partition model |
| 21 | RAG chat | `S/rag.ts:1257` | assistant answer | `rag:chat` | router `chat`: `taskRouting.chat` → `defaultBrain` → chain; Gemini uses `chat.geminiModel`, temp 0.7, maxTokens 1024, thinking 0 | history up to 4096 estimated tokens + retrieved chunks | walks the whole chain | conversation via `assistant:addMessage` | the CLI brains pass only `--model` (and now `--effort`) and ignore temperature, maxTokens, json and thinking |
| 22 | Summarize / action items (assistant) | `S/rag.ts:1367`, `:1411` | meeting summary and action items | `rag:summarize-meeting`, `rag:find-action-items` | task `chat` | 8,000 characters | as 21 | none | |
| 23 | Transcript reformat | `S/transcript-upgrade.ts:427` | turns a legacy flat transcript into speaker turns | `transcript-upgrade:run`, then a background drain that yields to the queue | task `chat`, temp 0.2, maxTokens 8192 | blocks up to 12,000 characters, many calls per transcript | failed rows retried on the next drain | `transcripts.speakers` | JSON turns |
| 24 | Outputs | `S/output-generator.ts:250`, `:272` | templated document | `outputs:generate` (5 per minute) | `resolve('outputs','generate')`: `taskRouting.outputs` → `defaultBrain` → gemini-api, ollama | transcripts in, text out | none after resolve | `outputs` table when an actionable is linked; file export | `OllamaBrain.generate` drops all options |
| 25 | Handover agent | `S/handover-service.ts:716`, `:888` | agentic CLI run in a target directory | `handover:runAgent` | `resolve('handover','agentic')` over claude-code, codex, gemini-cli, or an explicit brain | prompt in, `cwd` set | usage-limit cooldown | run log file | needs agentic CLIs; 120-180 s timeouts |
| 26 | Note analysis | `S/note-intelligence.ts:100` | title, summary, category, tags | `notes:analyze` | `chat('suggestions', …)`, temp 0.2, maxTokens 500 | up to 12,000 characters | error stored on the note | `notes.*` | the only user of task `suggestions` |
| 27 | Image description | `S/artifact-types.ts:236` | vision description and tags | each imported, pasted or connector image, gated by `capture.describeImages` | direct SDK, `chat.geminiModel`; bypasses the router | image bytes in, JSON out, 1024 tokens | none; import proceeds without a description | `artifacts.extracted_text/metadata`, `knowledge_captures.summary`, then embedded | multimodal `inlineData`, `thinkingBudget:0`; no usage recorded |
| 28 | Unwired | `transcription.ts:1876` (`reanalyzeFailedTranscripts`), `artifact-service.ts:422`, `brain-router.ts:425` and `gemini-api-brain.ts:223` (`analyzeAudio`) | | no caller found outside tests | | | | | do not build on them without confirming |

Not AI: `S/audio-preflight.ts` (ffmpeg silence and volume detection), audio profile, quality rules,
diarization quality, integrity and the org reconciler.

## Configuration that touches models (`S/config.ts`, type `:123`, defaults `:344`)

- `transcription.*`: `provider` `gemini`; the Gemini key; `geminiModel` `gemini-3.5-transcribe`;
  `localAsr*`; `vibevoice*`; `speakerLinking*`; `modelHostUrl` and the Model Host access token;
  `speakerEngine` `auto`; the Jev key; `autoTranscribe` true; `language` `es`;
  `valueClassificationEnabled` true;
  `valueClassificationMinConfidence` 0.6.
- `embeddings.*`: `provider` `ollama` (never read); `localCpuPercent` 50; `ollamaBaseUrl`;
  `ollamaModel` `nomic-embed-text`; `chunkSize` 500; `chunkOverlap` 50.
- `chat.*`: `provider` `gemini` (read only by `getProviderConfigFromSettings` and the Settings UI,
  never by BrainRouter); `geminiModel` `gemini-3.8-flash`; `ollamaModel` `llama3.2`;
  `maxContextChunks` 10 (ignored by RAG).
- `brains.*`: `enabled` (gemini-api and ollama on by default), `defaultBrain` `gemini-api`,
  `taskRouting` `{}`.
- `decisions.*`: `jevEnabled`, `jevValue`, `jevMeetingMatch`, `jevSpeakerNames` all true.
- `capture.describeImages` true. `quality.*` thresholds (Jev, warnings, retries).
- Hard-coded: `gemini-embedding-001`, `gemini-3.5-transcribe-live`, `jev-latest`,
  `CohereLabs/cohere-transcribe-03-2026`, the ONNX voice models, `GEMINI_PRICES` in
  `S/gemini-usage.ts:95`, `RETIRED_GEMINI_MODELS` (`config.ts:473`), the Jev speaker-name gates
  (0.8 and 0.3) and the per-call temperature and maxTokens of rows 21, 23 and 26.

## BrainRouter (`S/brains/brain-router.ts`, `types.ts`)

API: `resolve(task, need)`, `chat(task, messages, opts)`, `embed(texts, opts)`, `activeEmbedBrainId()`,
`analyzeAudio(input)`, `resolvePrimaryChatBrainId(task)`, `getLastChatFailure()`. There is no router
`generate`; callers use `resolve()` and then `brain.generate`.

`BrainTask` = `transcribeAnalyze | chat | outputs | handover | embed | suggestions`. Used by: `chat` for
rows 11, 12 (LLM path), 16, 21, 22, 23; `outputs` for 24; `handover` for 25; `embed` for 19-20;
`suggestions` for 26 only; `transcribeAnalyze` only inside the unwired `analyzeAudio`.

Gaps: rows 8, 9, 10, 13, 14, 15, 17, 27 and all transcription engines bypass the router; the UI writes
only `taskRouting.embed`; `FALLBACK_CHAINS` omits `kiro`; `getOllamaService()` caches URL and models on
first use with no reset; `GenerateOptions.model` exists and no production caller sets it.

Harnesses as of phase 1: eight brains (`openai-compatible` added), six audio engines and Jev described in
`brains/descriptor.ts`, `brains/engine-descriptors.ts` and listed by `brains/harness-catalog.ts`.

## Sequence for one recording (`transcribeRecording`, `transcription.ts:2133`)

1. gates and metadata (duration, `vad`); 2. `diarization` and `voice-id`; 3. `transcription`;
4. analysis (`summary`, `title`, `meeting-resolution`); 5. persist, value, and the Jev evaluation;
6. `actionable-detection`; 7. `timeline-analysis`; 8. `org-reconciliation`; 9. `speaker-identity`
(self-ID, inference, live owner); 10. `graph-sync` (the ingest runs about 60 s later);
11. `wiki-export`; 12. `rag-indexing`. On demand: Jev or LLM meeting match.

## Settings UI

`R/features/settings/sections.ts` (`SettingsSectionId`, `SETTINGS_SECTIONS`), `SettingsNav.tsx`, route
`R/App.tsx:309` (`/settings/:section?`), `R/pages/Settings.tsx` (self-contained pages render at
`:882-888`). Pages that touch models: `transcription`, `ai-providers`
(`components/settings/AIBrainsSettings.tsx`), `decisions` (`DecisionsSection.tsx`), `quality`,
`speakers`, `privacy`, `assistant`. Persistence: `useConfigStore.updateConfig(section, values)` to
`config:update-section`, no allow-list. Checklist for a new page: `AppConfig` and `DEFAULT_CONFIG`; the
renderer mirror `R/types/index.ts:231` (it does not mirror `brains`); `SECRET_CONFIG_FIELDS`;
`sections.ts`; the render line; `sections.test.ts`.

## Processing runs

`processing_runs` (`S/database.ts:400`): `stage, provider, tool, model, version, execution, status,
parent_run_ids, output_refs, usage_json, estimated_cost_*, cost_method, quality_*`. Stages:
`metadata, schedule-match, vad, diarization, transcription, summary, title, meeting-resolution,
speaker-identity, voice-id, persistence, actionable-detection, timeline-analysis, org-reconciliation,
graph-sync, wiki-export, rag-indexing`. Not recorded as runs: Jev evaluation, Jev meeting match, the
graph LLM call, image description, note analysis, reformat and RAG chat. Usage and cost are captured
only for Gemini paths that call `recordGeminiUsage` (rows 1-3, 8, 9, 10 and the Gemini brain).

As of phase 2a, the calls of rows 11, 12, 13, 15, 16, 21, 22, 23, 24, 25 and 26 are recorded in
`pipeline_calls` (`S/pipeline/call-store.ts`), with or without a recording, with usage and cost where
the harness states them. Rows 8, 9, 10, 14, 17, 18 and 27 follow in phase 2b. The headless brain host
opens the database read-only and records nothing.

## Unverified

Whether other models accept `thinkingBudget:0`; whether the Jev API accepts images; whether live
transcripts are stored anywhere beyond the renderer events.
