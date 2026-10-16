# SPEC-013 verification checkpoint — 2026-10-11

La lista única de trabajo y criterios de cierre del cliente está en
[Cierre del cliente HiDock y del procesamiento remoto](../client-done-when.md).
Este documento conserva evidencias y límites de sus ensayos; sus listas históricas
no sustituyen ese control actual ni incluyen el trabajo propio de firmware.

## Current status — 12 October 2026

**Partially verified; the complete SPEC-013 acceptance matrix remains open.** This section supersedes
older deployment/readiness statements below. All subsequent dated sections are historical evidence,
not statements of the currently installed versions. In particular, earlier “host not installed”,
“Ollama unavailable” and “remote embeddings pending” entries describe their measurement dates.

### Latest bounded run and processing restrictions

- Do not process 11–12 October recordings. Automatic connection/download are off in the active competing
  recovery profile (both flags false). The dormant production profile still had both true and was not altered;
  this is not a claim that every profile is disabled.
- Two sequential paired-HTTPS jobs used one unchanged **21 August / five-minute** source: Qwen 1.7B on CUDA
  took **18.440 s client / 11.344 s worker**; Parakeet v3 on CPU took **10.104 s / 7.860 s**. Two-second
  whole-host samples peaked at CPU/GPU/VRAM **8.14% / 100% / 10,509 MiB** and **36.33% / 0% / 283 MiB**
  respectively. Whole-host samples include unrelated processes and do not measure exact per-worker peaks.
  Final active jobs were zero; no cloud calls, recent recordings, production DB writes or new review deliveries.
- This was not an app-queue/full-pipeline or gold-reference quality test. Low-energy material from about
  56–164 seconds elicited possible Qwen/Cohere hallucinations; no Parakeet window omission was established.
  Timestamp coverage from zero to the end is not lexical coverage. Existing reviewed-119-word rescoring
  is unchanged (Gemini **1.68%**, best only in that review); no default changed.
- Host **0.5.2 is now installed and ready**; update API accepted 202, installed policy SHA256 matches source,
  and 244 tests / 30 files passed. Installer SHA256:
  `6abb3329a1a466ff0a9b222e4e6386a9d2d4ac468c041ad6461b7304e2213129`.
  The installed ordinary-worker policy was executed locally with synthetic memory counters: zero/tiny
  budgets rejected below 1,024 MiB; exactly 1,024 MiB accepted. This is not physical host exhaustion testing.
  Eight ASR engines, semantic embeddings, text generation and realtime remained qualified ready.
  A third remote job reran the same older source with Parakeet: **10.117 s**, CPU 16/32 threads, 50%,
  below-normal, 16,209 MiB Job limit, completed and host idle. Text matched before-update output; full
  result hash differed because timing metadata changed. Total new remote ASR jobs: **3**; cloud/recent
  recording counts remain **0**, and automatic settings were not changed. See
  [applied-host verification](../../.diagnostics/host-052-verification.json) and [memory limit scope](resource-memory-limits-2026-10-12.md),
  [resource run](../../.diagnostics/remote-long-resource-20261012/report.json) and
  [coverage evidence](../../.diagnostics/remote-long-resource-20261012/coverage-investigation.json).
### Applied host and observed client boundaries

- GAMESTATION **0.5.2 is installed**. Its actual update preserved semantic-embedding and native-realtime
  validation proofs. Managed generation preparation completed with a real Spanish JSON result on CUDA
  and worker teardown. The shared heavy-work admission guard also covers Clef decisions; disconnect
  cleanup is implemented. This is not proof of every concurrent-engine/fault combination.
- Eight remote ASR engines were previously exercised, with public-corpus pilot results and scoped
  user-reviewed library results recorded in the [accuracy report](asr-observed-accuracy-2026-10-11.md).
  Native diarization is separately qualified. Clef/Clef-Flash remain typed decision engines; the new
  managed Qwen generation role supplies general text/chat rather than claiming Clef can do that.
- Actual paired realtime protocol calls returned incremental output before commit and exercised cancellation.
  This does not establish full live-meeting transcription quality or complete Library integration.
- Actual `ModelHostEmbedBrain` through pinned HTTPS returned two distinct, finite, normalized
  2,048-dimensional vectors for query and passage: **6,866 ms / 6,937 ms**. Incorrect space binding
  was rejected before upload. This client harness did not exercise SQLite partition persistence.
- Actual `ModelHostGenerateBrain` through pinned HTTPS returned Spanish JSON in **2,884 ms**
  (**30 input / 11 output tokens**) and a short chat response in **2,795 ms** (**22 / 4 tokens**).
  Incorrect model-version binding was rejected before upload. A third request was observed active,
  cancelled, and the host returned idle within **525 ms**. Production client configuration was unchanged.
  These are synthetic boundary/latency checks, not generation-quality or sustained-load benchmarks.
- The actual client UI was exercised in normal mode using an isolated empty database and disabled device
  access: Check reported all three new roles ready. Prepare semantic was accepted, preparation controls
  were disabled while running, the host really revalidated, and reconnect/Check returned ready again.
  Explicit generation Enable bound the advertised version without changing the existing default.
  This is real renderer/IPC/host behavior, but not production-library acceptance.
- Correction: `installed-role-health.json` was an **unpackaged recovery instance (PID 101076)**, not
  installed-executable proof. Its authenticated API did confirm the selected remote embedding route and
  bound semantic space. Applying that route preserved the transcription provider, default brain
  (`claude-code`) and unrelated settings. Earlier independently observed installed recovery/normal-window
  evidence remains valid, but neither observation verifies the newest maintenance UI.
- Recovery-mode sampling observed peak process-tree working set **687.375 MiB**, maximum health response
  **44.5403 ms**, and minimum available RAM **24.327 GiB**. A separate installed normal-UI launch on a complete
  intended library-snapshot profile observed **521.781 MiB**, **39.4712 ms**, and **24.668 GiB**
  respectively. **Correction: that app opened an empty nested database**, not the copied library.
  `prepare-library-benchmark.cjs` set `storage.dataPath` to `profile/data`; file storage appends
  `/data/hidock.db`, so runtime opened `profile/data/data/hidock.db` (962,560 bytes, **0 recordings /
  0 vectors**). The untouched intended `profile/data/hidock.db` copy is 3,240,947,712 bytes with
  **2,220 recordings / 243,110 vectors**, confirmed separately read-only. The initial profile also gated
  assistant behind disabled transcription. Resource samples remain actual process observations, but
  **are empty-database UI evidence, not complete-library, semantic restoration or pipeline acceptance**.
- Packaging exposed stale-source ASAR offsets. A full-entry integrity gate and packaging exclusions were
  corrected. The checker validates every packed regular-file SHA256 and offset/size bounds, and parses
  package JSON/main JavaScript without executing it; unpacked native checks are separate. Its three tests
  passed and it rejected the actual corrupt archive. The subsequent rebuilt archive passed verification of
  **17,608 entries**. That packaging check alone does not establish runtime
  acceptance. **The latest maintenance package is now built and installed**;
  artifact installation is distinct from observing its new UI and workflow.

- The later semantic-startup launch used the **same incorrect nested empty database**. Its **0 restored
  documents**, **10 tasks / 30 ms**, **526.270 MiB** peak working set, **42.5753 ms** maximum health
  response and **24.855 GiB** minimum available RAM describe empty-database startup. The backup path
  in `library-semantic-startup.out.log` confirms the nested location. These figures do **not** show that
  243,110 historical vectors were excluded by provider or that a complete-library boot is responsive.
  Independent native-database 130,404-vector benchmarks below used their explicit copied database paths
  and remain valid; they must not be conflated with these empty-UI launches.
- Actual `VectorStore` + `ModelHostEmbedBrain` + native `DatabaseEngine` retrieved one library excerpt through
  the remote partition: passage embedding **8,253 ms** (2,000 characters), query **7,182 ms** (180 characters),
  each 2,048 dimensions. Persistence/reopen retained the correct top result; reopening reused the cached query.
  The old-provider row remained byte-for-byte unchanged and excluded from the search. Two host calls only;
  subsequent parent health inspection confirmed **0 active jobs**. The initial final assertion failed solely
  on JSON property order; independent per-column/BLOB comparison resolved it, with the original report retained.
  Eligibility used a conservative read-only snapshot SQL seam, not full application privacy wiring. This is
  actual retrieval/persistence evidence, not full assistant UI or whole-library backfill acceptance.
- CPU-only Cohere now has a scoped successful path: replacing the failing mmap load path with **pread**,
  retaining **BF16**, completed isolated load and the actual CLI JSON contract. A **5.15-second fixture** took
  **0.641 seconds of inference**; this excludes cold import/load overhead. The pread probe separately measured
  import **7.084 s** and load **9.065 s**. The process exited 0, and cleanup observed no owned processes.
  Policy remained **50% CPU / 12 threads / below-normal priority / 8 GiB Job memory**. The shared plugin and
  CUDA runtime were untouched. Matching a prior output hash is not independent WER; that short probe alone establishes no long recording,
  diarization, or complete CPU pipeline is established. Earlier native crashes remain historical evidence.
- Search yielding changes passed **47 focused tests** and an actual offline native-database/VectorStore
  benchmark over **12,000 copied eligible 2,048-dimensional old-partition vectors**: search **131.341 ms**,
  **11 timer ticks**, maximum timer gap **18.470 ms**, and identical top-five IDs to the synchronous
  scoring/sorting baseline (**42.265 ms**). The query vector was cached: zero external inference calls or
  production writes. This measures cooperative yielding on a bounded snapshot, not full-library or native UI
  responsiveness. The latest package is installed; its new workflow still requires installed UI verification.

- The complete largest existing active partition (**130,404 vectors**, not the 243,110 rows across all
  providers) was then measured with actual native database/VectorStore code. The final timestamped run
  restored it in **3.319 s**, with cache written by **3.921 s**, versus **17.429 s** in the earlier
  timer-heavy restore. In this last sample no recorded timer gap, budget slice or SQL call exceeded
  **30 ms**. Earlier runs did record approximately **360 ms** stalls: these were not reproduced in the
  final instrumentation, but are neither causally explained nor ruled out. Peak private memory was
  **1,414,389,760 bytes (1.414 GB)**; minimum available RAM **24,018,698,240 bytes (24.019 GB)**.
  Windows Job policy remained 50% / 12 threads / 8 GiB / below-normal; exit 0, zero external inference.
  This is a bounded offline existing-partition restore, not a full app workload or new remote-index backfill.
- Installed CPU worker resources were exercised on the 5.15-second fixture: **0.680 s inference /
  12.417 s wall**, exit 0, no matching workers remaining. Resource SHA256 values and the installed resource
  directory are recorded in the evidence. A separate five-minute Library-source run completed in
  **19.276 s inference / 28.518 s wall** (reported audio 299.88 s), exit 0, source unchanged, and no owned
  processes remaining. Peak tree RSS was **6,308,593,664 bytes (6.309 GB)**. The CLI returned text without
  timestamp segments; whether its 2,048-token output cap was reached is not reported. Thus this demonstrates
  bounded installed CPU execution and cleanup, **not independent WER, guaranteed transcript completeness,
  diarization, or the complete enrichment pipeline**. No audio/transcript delivery is needed for this evidence.
- The selected remote semantic namespace still contains **0 production indexed documents**; the isolated
  single-excerpt retrieval did not backfill it. Full historical production migration remains pending.

- The latest installed maintenance ASAR SHA256 is
  `FCFC9F23A24B7EE6901682FCD08DEBB1B9969EA4253B00E50C4950ECF01003C9`.
  Maintenance exposes explicit Start/Pause/Resume/Cancel in the existing AI settings, with one recording /
  four batches per UI operation, pinned host/provider/space, readiness checks before uploads, no automatic
  start or boot resume, and no silent fallback. Pause completes the current batch; cancellation waits for
  request settlement and blocks late persistence. Existing provider partitions remain preserved.
- Actual native SQLite + VectorStore + pinned-TLS maintenance ran one batch (**four chunks**, **7.867 s**),
  paused, closed/reopened, then explicitly resumed another four chunks (**7.687 s**). The first batch and
  old provider partition were unchanged; no duplicate chunks were requested. Final cancellation and host
  idle were checked. Peak client RSS was approximately **131 MiB**. Production configuration/data were
  unchanged. This used an isolated feature-enabled snapshot eligibility seam, not production IPC/UI.
- **Installed new maintenance UI verification is blocked by an identified competing device-validation session:**
  thread **Instala REA para ingeniería del HiDO** (`01a12894-3a3c-7ff3-8851-d304fd0b5fb3`) launched
  `launch-device-validation.ps1`, owning PID 87476 and profile `completion630-runtime`. Read-only thread
  inspection established ownership. Leave that session/process untouched; messaging it is not authorized.
  The user will close the other session when finished; neither messaging nor closing it is authorized. Installed UI verification awaits release of the shared user lock. Installation/hash evidence does not close this gate.

### Resource-policy scope

The actual restart coordinator and Windows Job supervisor changed an owned fixture worker chain from
**25% (6 of 24 processors) to 50% (12 of 24)**. Kernel Job rate flags were observed, checkpoints survived,
late cancellation prevented replacement, and every owned process exited. This exercised isolated SQLite
ownership and real process/kernel enforcement; **neither full app UI nor model inference was exercised**
in that test. Earlier long diarization measurements remain useful but do not broaden this scope.

### Evidence (no private transcript content reproduced here)

- [Host 0.5.1 update](../../.diagnostics/host-051-update.json) and
  [post-update health](../../.diagnostics/host-051-health.json).
- [Paired realtime result](../../.diagnostics/host-realtime-paired-result.json).
- [Actual client semantic boundary](../../.diagnostics/semantic-client-boundary/report.json).
- [Actual client generation/cancellation boundary](../../.diagnostics/generation-client-boundary/report.json).
- [Owned worker CPU restart chain](../../.diagnostics/spec013-cpu-restart/owned-worker-chain.json).
- [Applied remote embedding configuration](../../.diagnostics/managed-semantic-applied.json) and
  [corrected unpackaged role health](../../.diagnostics/installed-role-health.json).
- [Recovery resource samples](../../.diagnostics/installed-recovery-resources.json) and
  [empty nested-database UI samples (corrected scope)](../../.diagnostics/installed-library-snapshot-resources.json).
- [Historical failed CPU load](../../.diagnostics/cohere-cpu-isolated/report.json),
  [successful pread probe](../../.diagnostics/cohere-cpu-pread/report.json),
  [actual CPU CLI result](../../.diagnostics/cohere-cpu-cli/report.json), and
  [owned-process cleanup](../../.diagnostics/cohere-cpu-cli/cleanup.json).
- [empty nested-database semantic startup resources (corrected scope)](../../.diagnostics/installed-library-semantic-startup-resources.json).
- [Actual persisted semantic retrieval](../../.diagnostics/semantic-library-boundary-redirected/boundary-verification.json)
  and [post-test idle host](../../.diagnostics/semantic-host-final-health.json).
- [Native offline search-yield benchmark](../../.diagnostics/vector-search-native-benchmark-adaptive/report.json).
- [Final full-active-partition restore](../../.diagnostics/vector-restore-final-timestamped/report.json) and
  [bounded process resource samples](../../.diagnostics/vector-restore-final-timestamped/resource-report.json).
- [Installed short CPU worker/resource hashes](../../.diagnostics/cohere-cpu-installed-20261012-065304/report.json)
  and [five-minute Library-source CPU run](../../.diagnostics/cohere-cpu-long/report.json).

- Storage-path audit: [preparation script](../../.diagnostics/prepare-library-benchmark.cjs),
  [original copy metadata](../../.diagnostics/library-benchmark-preparation.json),
  [separate correction receipt](../../.diagnostics/library-benchmark-path-correction.json), and
  [runtime nested backup/zero-restore log](../../.diagnostics/library-semantic-startup.out.log).
- [Actual maintenance pause/reopen/resume boundary](../../.diagnostics/semantic-maintenance-boundary/report.json)
  and [maintenance resource samples](../../.diagnostics/semantic-maintenance-boundary/resource-report.json).

### Remaining acceptance and release gates

1. Await release of the shared user lock by the identified device-validation session, then verify the corrected
   isolated storage root resolves the intended copied database (check runtime path and counts), and the newly
   installed maintenance UI/workflow without terminating or messaging that session. Full-library responsiveness
   and semantic backfill remain distinct from the bounded offline benchmark, empty-partition startup and
   one-excerpt retrieval.
2. MAI/Muse remain credential-blocked; their implemented adapters/UI do not constitute successful provider
   inference. Consumer signing/distribution remains open.
3. A genuinely unsynced recording of at least 48 MB is still needed for normal-device concurrent sync/CPU
   acceptance. Do not manufacture unsynced state, probe USB, or ask for further audio/transcript review deliveries.
4. Installed CPU-only Cohere short and five-minute execution now pass, but full long-recording enrichment,
   independently scored quality, timestamp/diarization coverage, controlled
   hardware-change acceptance, complete-library semantic/realtime integration, sustained resource/latency
   behavior and failure/recovery combinations remain open. No independent WER is claimed for the short fixture.
5. Complete keyboard/accessibility acceptance remains open; prior focused keyboard fixes do not establish
   WCAG 2.1 AA conformance. Retain the approved palette/layout and record unresolved contrast findings.

## Historical verification record

The original checkpoint and follow-ups below are retained unchanged for chronology. Read their pending,
installed-version and test-scope statements in their dated context; use the current status above for rollout.


Status: partially verified. This is not acceptance of the complete specification.

## Applied UI scope

The live application was inspected with the approved symbol joined to `ext`, the original sidebar colors,
Settings at the bottom of the sidebar, and notifications/activity beside the processing controls. No broader
color or navigation redesign is approved. Client and GAMESTATION deployment subsequently completed; see the
chronological live deployment evidence below. The complete acceptance matrix remains partially verified.

## Observed process boundaries

| Execution | Observed result | Evidence under apps/electron/out |
|---|---|---|
| Actual pyannote CPU diarization, 59m45.1s recording | Completed in 1153.567s; 1446 segments, 6 acoustic speakers; peak CPU 49.9083%; peak tree RSS 2970.742 MiB; minimum free RAM 21.7203 GiB; exit 0; no remaining descendants | spec013-audio-benchmark-summary.json; spec013-audio-benchmark.jsonl |
| Earlier bounded 120s run of the same worker | Timeout ended the process tree, no descendants; peak CPU 49.5167%; peak RSS 2943.625 MiB | spec013-audio-benchmark-120s.jsonl |
| Actual local VAD on the 59m45.1s audio | Completed in 2505ms; cancellation returned in 265ms | spec013-vad-real.json; spec013-vad-cancel-real.json |
| Isolated ONNX embeddings | 2048 dimensions; 2960ms total; 12 runtime threads; below-normal priority; peak RSS 3633.84 MiB; no orphan worker | embedding-smoke.jsonl |

During the long CPU run, native HiDock navigation and opening/closing the monitor were exercised. Observed
monitor readings included current main-loop delay 1.3–13.1ms, lifetime peak 917.2ms and window scheduling
peak 13.7ms. These measurements do not prove that Windows never froze: no human observation was obtained
for that entire interval. The long run tested diarization, not the entire transcription/enrichment pipeline.

## Additional implementation and checks

- Manual pipeline ownership survives cancellation until the provider/child actually settles. A duplicate manual
  request cannot overwrite an existing run with an error. Focused QA: 84 tests passed across manual ownership,
  VAD cancellation and failed self-identification requests.
- A failed self-identification provider call no longer marks the transcript scanned.
- Local memory admission reserves 10% of physical RAM, bounded to 1–8 GiB. The completed long benchmark
  predates this larger reserve but stayed well above it.
- Idle embedding unload is configurable. Resource policy is emitted by the worker and displayed only when
  reported, rather than inferred from settings. The new provenance fields were added after the long run.
- The durable host API now supports VAD. An actual ffmpeg execution through authenticated HTTP jobs on
  loopback returned a verified result and removed temporary audio. This is not a GAMESTATION test.
  Host evidence: apps/model-host/build/spec013-vad-host-tests.log (6 tests).
- Explicit Resume can replace a remote identity only after GET confirms failed/cancelled/interrupted state.
  Completed/running/unreachable/cleanup-failed jobs do not authorize duplicate work. Focused client/IPC
  evidence: spec013-remote-restart-tests.log (67 tests).
- TLS outside loopback, pinned trust, revocable hashed token storage and installer certificate provisioning
  exist. No update has yet been installed and verified on GAMESTATION.

## Outstanding acceptance work

1. Remote ASR/VibeVoice runtime deployment, capability-driven execution-location controls and actual sample runs.
2. Startup reattachment to remote jobs and continuation of incomplete downstream checkpoints, including graph,
   wiki and partial indexing. Explicit reconnect by retained job ID is implemented; automatic startup continuation
   is not fully implemented.
3. Explicit safe restart of a currently running local stage after changing its CPU limit.
4. One-time explanation of a previously CUDA-backed runtime resolving to CPU after hardware change.
5. Install the new host on GAMESTATION, import its public TLS certificate, test capabilities, GPU execution,
   cancellation, desktop reconnect and temporary-input cleanup; then apply the matching client build.
6. Run the complete representative pipeline, verify one real paid request under downstream validation failure,
   and exercise actual 48 MB device sync concurrently with bounded CPU processing through the normal app.
   USB mocks and disk streaming checks alone do not satisfy this hardware criterion.
7. Keyboard/accessibility QA of the current settings and live operations, and final SPEC-013 acceptance review.

No automatic paid retranscription, driver changes, USB diagnostics, or unrelated process termination were
used for these measurements.

## Follow-up implementation and evidence (02:30 local)

- Remote ASR routing and Settings execution controls are implemented. Save/Test use the draft engine.
  Cohere auto/missing language fails before job creation/upload, and cannot enable local fallback.
- ASR capability advertisement requires a successful spoken-sample result plus a matching runtime/worker
  fingerprint. Preparation is an optional Start-menu action using private host Python and bounded validation.
- Actual local Cohere probe on 15 seconds failed safely: the existing ASR environment lacks
  `CohereAsrForConditionalGeneration`. It exited after 15.75 seconds without orphan workers. That environment
  was not upgraded. This is failure evidence, not a successful ASR benchmark.
- Remote job checkpoints now retain endpoint/model/stage/language/audio hash without credentials. Startup
  observation uses the retained ID, bounded reconnects, and preserves verified results locally. A saved raw
  transcript pins its original route so later configuration changes cannot cause a second audio submission.
  QA exercised authenticated real loopback HTTP: exactly two GETs, no POST/PUT; SQLite writes mocked there.
- Explicit local-stage restart and later cancellation precedence are implemented and regression-tested.
- Hardware-change CPU explanation is implemented and component-tested, not yet verified in the new live build.
- Partial vector indexing persists four-chunk batches and a pending marker. Real SQLite tests demonstrate
  restart/backfill resumes missing chunks without reembedding saved content, then clears the marker.
- Latest host suite: 154 tests/18 files pass. Focused vector/privacy/transcription/local-restart QA:
  90 tests/4 files pass. Recovery QA: 9 tests including real HTTP. These are not a full end-to-end acceptance.

The earlier outstanding list is superseded for source implementation of local restart, hardware explanation,
remote-route controls and partial-index recovery. Remaining real-boundary work includes applying the host/client
pair, GPU ASR/diarization, cancellation/reconnect on GAMESTATION, new live settings UI, paid-provider downstream
failure verification and normal-device sync alongside the complete representative pipeline. Graph ingestion has
its own durable `graph_ingested_transcripts` marker; event dispatch alone is not proof of graph completion.


## Follow-up verification (02:42 local)

- Resuming a saved raw transcript now preserves the existing transcript row when its text matches; it does not
  perform INSERT OR REPLACE and erase summary/foreign-key dependents. This is covered at the mocked call boundary;
  a production-data restart acceptance has not been performed.
- A recovered remote transcript uses the saved host provenance even when the configured URL is removed/changed.
- Cancel during RAG prevents the next embedding batch and persistence and cannot report the pipeline completed.
- Graph event dispatch no longer masquerades as completed graph ingestion. Actual ingestion owns a separate operation
  scope, commits its durable marker transactionally, and retains paid provider responses before parsing/persistence.
  A real SQLite trigger forced marker persistence to fail; a second pass reused the response, called the mocked model
  exactly once across both attempts, then committed graph data/marker. This is not proof of real provider billing.
- Remote recovery queues the original engine after verified completion; raw ASR checkpoints pin its route. The retained
  pipeline provider identifies continuation after non-ASR remote stages. Live remote restart acceptance is pending.
- Isolated browser verification rendered the actual AudioExecutionSettings and DiarizationCpuShare components with
  in-page IPC substitutes: keyboard arrows changed 50% to 55% (12 to 13 of 24 processors), Tab moved visible focus to
  idle unload, remote selection updated, and Test announced its result through the status region. No real host/model
  was contacted and no production configuration changed. Screenshot: apps/electron/out/spec013-settings-ui.png.
- Latest combined client checks: 136 tests across 6 files pass. Graph/privacy checks: 111 tests across 4 files pass
  before the final independent graph scope wrapper, subsequently covered by the 136-test run. Latest targeted host
  package checks: 56 tests across 3 files pass. Do not sum these as unique tests: suites overlap.
- Final TypeScript checks and staged Electron build pass. The newer staged client has NOT replaced the running build.

### Prepared installer and deployment boundary

`apps/model-host/build/HiDock-Model-Host-0.4.1-Setup.exe` (47,992,027 bytes)

SHA256: `29E9770E5E263D8C5D6F8B6E501BAD216262DA91238C4A9AB56A096A3A4DD925`

Superseded deployment assessment: the existing authenticated `model-host:update` IPC / `PUT /update` maintenance path
can deploy the host without SSH or WinRM. Windows administrative SMB access also permits reading the actual installer
logs. The earlier claim that manual installation was necessary was incorrect.

### Live deployment and RTX verification, 12:57 onward

- Updated GAMESTATION through the paired updater. Setup completed, HTTPS8766 became available, HTTP8765 became
  loopback-only. Verified the public certificate SHA256 against the installer log read through Windows SMB before
  sending credentials. Private key was never read/copied. Updated client URL/certificate; existing pairing retained.
- Applied the staged Electron build with a normal backend shutdown and backup at
  `apps/electron/out/spec013-previous-20261011-125925`; running app uses the new build in `hidock-next-2`.
- Actual embedded Python initially failed to import its installed sibling `resource_policy.py`. Fixed the worker's
  module search path explicitly and rebuilt/redeployed the installer. Real GPU setup then passed on CUDA.
- Authenticated real jobs over TLS: 30-second spoken sample VAD 1037ms; diarization 8087ms, CUDA, 9 segments;
  cancellation 20ms. Duplicate create requests returned the same durable ID. Host job directory contained only JSON
  records afterward, no temporary audio. Evidence: `apps/model-host/build/spec013-gamestation-verification.json`.
- Real application Settings keyboard check: CPU50→55 showed13/24; restored50 and Tab focused idle-unload control.
  Screenshot: `apps/electron/out/spec013-live-transcription-settings.png`. This does not establish full accessibility.
- Added authenticated, TLS-only, idle-only remote ASR preparation through fixed tray operations (no arbitrary command
  execution). QA tests cover authorization, duplicate requests, reservation during pause and control races. Updater
  rechecks preparation/admission after upload. Installer now preserves resource/model policies across updates.
- Remote ASR preparation completed on RTX4090. The new real Settings button was exercised again at13:26;
  preparation passed and the client subsequently confirmed the advertised Cohere engine on CUDA.

### Further live evidence, 13:24 onward

- Applied preparation UI build after graceful backend shutdown, with backup at
  `apps/electron/out/spec013-previous-20261011-132435`. Actual Settings button requested preparation; host's
  prepare-asr.log reports RTX4090 success. Test connection returns Cohere, remote, gamestation:8766, CUDA.
  Screenshot/result: `apps/electron/out/spec013-live-prepare.png` and `spec013-live-prepare-result.json`.
- Real remote Spanish ASR:30seconds of speech processed in15157ms,169outputtokens,8segments, verified result hash.
  Evidence:`apps/model-host/build/spec013-gamestation-asr.json`. No temporary host audio remained.
- Actual remote client module disconnected after upload; a new process recovered the same completed job using GETs
  only. No second POST or PUT. Evidence:`spec013-client-disconnect.json` and `spec013-client-resume.json` under
  apps/model-host/build. This proves the module/process boundary, not the complete desktop queue startup path.
- Real Gemini30second transcription through the actual GeminiEngine plus real providerCheckpoints and isolated
  SQLite: one POST /v1beta/interactions. Provider response5081bytes persisted before a deliberately invalid timestamp
  copy failed actual validation. Closed/reopened SQLite and retranscribed through the same engine: identical output
  hash, no external request. Upload used initiation+transfer POSTs; these were not extra inference calls. Remote file
  DELETE was observed. Evidence:`apps/electron/out/spec013-provider-boundary-result.json`. User library untouched.
- QA found acoustic fallback could start locally after a remote identity was saved during a failed request. Source
  now rechecks durable ownership immediately before fallback; unknown/unreadable state fails closed.46speaker tests
  pass. Host state copy now reflects configured fallback and limits speaker-route claims to speakers;36tests pass.
  These corrections were built and applied at13:37 after graceful shutdown; backup:
  `apps/electron/out/spec013-previous-20261011-133734`. Latest targeted run:67tests/4files passed.
- Current deployed host installer:47,995,069bytes,
  SHA256`6BCAD9E5B30AB314E1DDFC481D1FA216B236490AA499610574D4925897A4FD90`.
- GAMESTATION Ollama11434 did not respond within the bounded test. Remote Ollama acceptance is unverified.

Remaining acceptance: full desktop queue/startup recovery, full representative pipeline under resource limits
(bounded59m45diarization already measured), normal48MBhardware sync alongside inference, remote Ollama routing and
idle release, full integrated Settings/Operations accessibility, and actual VibeVoice engine if offered as ready.
The full specification remains IN PROGRESS. Source/unit evidence must not be represented as complete acceptance.

### SQLite recovery and long-audio failure, 13:36 onward

- Actual startup recovery observer used isolated real SQLite and a real RTX job. A process exited after upload;
  its replacement recovered through11GETrequests, with no POST/PUT. Persistent operation changed running→completed,
  the transcript checkpoint held1642bytes, pending jobs and active ownership both cleared, and continuation received
  the original model/stage. Evidence:`apps/electron/out/spec013-observer-resume.json`. This still does not establish
  the complete desktop UI queue continuation.
- The59m45recording exposed a Cohere decoder limit failure absent in the30second sample. The first full-pipeline
  attempt failed explicitly, with no truncated transcript accepted. Isolated client peakRSS220.7MiB and main-loop
  delay93ms. Evidence:`apps/electron/out/spec013-pipeline-first-failure.json`.
- Cohere now requires generated EOS (excluding decoder prefix and allowing padding), disables forced ceiling EOS,
  and bisects incomplete windows at exact integer sample boundaries. Three subdivision levels cap attempts;
  exhausted output reports the exact failed interval. Seven pure Python tests passed. No arbitrary increase in
  decoder output or silent acceptance of truncated text.
- Rebuilt and applied the host through its authenticated updater. New installer47,994,448bytes,
  SHA256`2F502CB9B7293F084EA38EC805E5848CFD17DAC5542DAD2908939CE7F177D236`.
  Actual Cohere preparation/revalidation passed on RTX4090 at13:49. The second isolated59m45pipeline test is running;
  no success claim yet. It uses temporary data, preserves the user's library and does not connect to USB.

### Acoustic microturn correction and third run, 13:55 onward

- Second run exposed the actual interval:25.5796875–25.5965625seconds, only17milliseconds. Fail-closed decoding
  correctly refused it, but independently transcribing every acoustic microturn was the wrong segmentation policy.
- Host now expands short acoustic turns with bounded real context, unions overlapping windows, and partitions long
  windows evenly to at most20seconds without tiny trailing fragments. Mixed-speaker/context windows retain acoustic
  provenance and unresolved attribution; they are not assigned to the dominant voice. Eleven Python tests pass.
- Client reconciliation and self-identification now honor unresolved mixed/context evidence. Naming tests exercise
  zero model calls and zero contact/voice binding for those windows.66focused tests pass. Typechecks and build passed;
  deployed normally with backup`apps/electron/out/spec013-previous-20261011-1358`.
- Host installer48,001,558bytes, SHA256`D5CA7E5DC487B088856F2FACBE01CDABC643D10509D179C56728C671549B5FA7`.
  Actual preparation passed RTX4090 at13:55. Third59m45ASR completed on CUDA in114980ms;639segments,
  37697textcharacters,120explicitly mixed/unresolved windows. No transcript accuracy claim follows from these counts.
  Downstream full pipeline is still running at this checkpoint.
- Actual app screenshot after deployment:`apps/electron/out/spec013-attribution-live.png`: approved wordmark,
  original sidebar colors, Settings at bottom, no header settings button, notifications/activity after node metrics.

### Completed isolated pipeline and real queue continuation, 14:00 onward

- Third representative pipeline completed from16:56:24.268Z to16:59:32.912Z (188.644seconds): remote Cohere ASR,
  remote pyannote voice enrichment, cloud analysis/actions/timeline, wiki export and Gemini embeddings. Persistent
  recording/transcript status is complete. Provider diarization is explicitly degraded for unresolved attribution;
  it is not silently presented as trusted identity. Main-process peak242.35MiB, observed whole test tree448.60MiB,
  minimum available system RAM23.705GiB, maximum sampled main-loop delay96ms, no remaining test descendants.
  This measures the isolated pipeline helper, not total desktop-app RAM or a human-observed absence of freezes.
  Evidence:`apps/electron/out/spec013-pipeline-verification.json`.
- Readback of actual persisted transcript:120mixed windows remain Unknown speaker/unresolved, no contact binding
  for those labels. Remote jobs directory contains only JSON records (no retained uploaded audio).
- Ran actual graph ingestion against that same isolated SQLite and real configured model:1transcript ingested,
  75nodes, durable marker committed and graph-sync operation completed. Second pass skipped it. Evidence:
  `apps/electron/out/spec013-graph-result.json`. This direct service test excludes the event-bus debounce timer.
- Actual startTranscriptionProcessor restart test: first process exits after30second audio upload, second uses the
  retained job ID viaGET, recovers saved ASR, then automatically queues and runs the downstream pipeline. A later
  audio submission belongs to optional pyannote enrichment, not a repeated ASR job. This short excerpt was classified
  as value-excluded, so queue and remaining pipeline correctly ended cancelled; transcript remained complete and
  pending/processing/remote counts returned to zero. Do not report this as a fully completed pipeline. Evidence:
  `apps/electron/out/spec013-queue-disconnect.json` and `spec013-queue-resume.json`.
- GAMESTATION keeps the decision model warm for its configured10minute idle period;0active jobs does not mean all
  GPU memory is immediately released. Host-wide memory telemetry must not be described as app-process attribution.

### Acceptance status after these runs

| Criterion | Current evidence / remaining boundary |
|---|---|
| 1 CPU budget | Real local diarization tree was bounded at50%/below-normal; not every supported local ASR engine exercised. |
| 2 Hardware change | CPU path exercised on this workstation; no controlled before/after GPU-swap experiment. |
| 3 Representative local pipeline |59m45CPU diarization measured; complete59m45remote/cloud pipeline now measured. Full CPU-only ASR pipeline remains unverified with the old local runtime. |
| 4 Cancellation | Real worker timeout/cancel and remote cancellation checked, no descendants; not every model engine tested. |
| 5 Optional stage failure | Regression and bounded-worker evidence; no full live forced-timeout→provider continuation acceptance. |
| 6 Provider response replay | Real Gemini inference, durable SQLite response, downstream invalid timestamp, replay with no external call passed. |
| 7 Remote execution/recovery | Actual TLS RTX jobs, result verification, process restart and cleanup passed. |
| 8 Queue/ledger | Real manual pipeline and actual startup processor continuation observed; value exclusion correctly cancels remainder. Full automatic live UI combination remains unverified. |
| 9 Remote embeddings/idle | Cloud Gemini embeddings worked; GAMESTATION Ollama11434 unavailable, location requested from user. |
| 10 Accessibility | Actual Settings keyboard/resource controls observed; complete WCAG2.1AA audit not established. |
| 11 USB48MB | Read-only cache: H1E connected,557files,39at least48MB, all39already synced. No safe pending fixture; no USB probing or artificial unsync performed. |
| 12 Concurrent USB/CPU | Blocked on that pending recording fixture; earlier CPU navigation alone is not equivalent. |

Measured waterfall: `docs/performance/spec-013-waterfall-2026-10-11.png` (rendered and inspected).
HTML version is generated but was not browser-verified because local-file navigation was blocked by browser policy.
Isolated test credential/config copies were removed after verification; test databases/reports remain for evidence.
SPEC-013 remains PARTIALLY VERIFIED, not complete.

### Final live keyboard check, 14:17

- Applied the ServiceList accessibility correction to the running renderer only (no backend or USB restart).
  Native CDP key input verified ArrowDown/End move focus without selecting, Enter/Space select the focused
  service, Home/Enter restore Pipeline, and exactly one listbox option remains in the tab order throughout.
  Evidence: `apps/electron/out/spec013-settings-keyboard-native.json`.
- The previous test omitted the Enter text payload and did not exercise native activation correctly; the
  corrected native sequence above selected Gemini and Live transcription successfully. No model configuration
  was changed: these are Settings detail-pane selections.
- Actual renderer axe check no longer reports the listitem structural violation. Existing palette contrast
  findings remain; unsupported color parsing also produced NaN results, which are not numerical contrast evidence.
  This does not establish complete WCAG AA conformance. Sidebar colors were preserved as requested.
- Host after test jobs: zero active jobs, GPU 0%, about 309 MiB VRAM in
  `apps/electron/out/spec013-host-after-tests.json`; this is host-wide telemetry, not process attribution.

### Continued verification, 14:35 onward

- Real optional-stage timeout test with isolated SQLite and an actual sleeping worker: 30.773 seconds,
  worker tree terminated, acoustic/voice enrichment degraded to provider-managed attribution, transcript hash
  preserved, pipeline completed, no pending/processing queue entries and zero network attempts. Later analysis
  was skipped because the cloned profile had audio_not_checked; this proves transcript continuity and no requeue,
  not execution of every later stage. Evidence: apps/electron/out/spec013-timeout-result.json.
- Current configured local ASR plugin runtime has transformers 4.57.6 and lacks CohereAsrForConditionalGeneration,
  despite its pyproject requiring transformers >=5.4. Created test-only dependency overlays under out; no shared
  plugin or production configuration was modified.
- A bounded offline CPU model-load test with an overlay providing transformers 5.10.2 on the plugin's Python3.14 /
  torch2.11 runtime failed natively while copying weights: 0xC00000FD followed by 0xC0000005 with faulthandler traces.
  No model inference completed. These exit codes are not proof of RAM exhaustion. Windows Job policy was50% CPU,
  12threads, below-normal and10GiB job memory; supervisor180second deadline. Comparing a separate Python3.11
  runtime before deciding on any local deployment. Evidence: spec013-local-cpu-python314-result.json and stderr log.
- Additional dependency evidence: installed VibeVoice1.0.0 requires transformers<5 while Cohere's declared
  requirement is>=5.4. A shared runtime cannot satisfy both. Isolated overlays avoid changing the shared plugin.
- The bounded CPU load also failed natively under Python3.11/torch2.13, including a one-worker/one-torch-thread
  load experiment. Therefore Python3.14 alone is not established as the cause. Faulthandler locates failure in
  native tensor materialization/copy while loading weights. No model load or local ASR success is claimed.
  The10GiB limit was not raised; no test worker remains. Need investigate loading allocations/native compatibility
  before any hour-long local ASR run; current remote/cloud configuration remains unchanged.

### Clef/Clef-Flash verification and actual routing, 19:55 local

- Rechecked live HiDock in hidock-next-2 and paired GAMESTATION0.4.1. Both model files on disk;
  host ready, RTX4090, no active job at start. Actual app decision preset zero-cost, no overrides.
- Real window.electronAPI.modelHost.decide calls, same synthetic explicit-action example, each166inputtokens:
  Clef-Flash cold30827ms/warm347ms, Clef cold52118ms/warm671ms. Both returned valid noul answers.
  This is connectivity/schema/latency evidence, not an accuracy benchmark. No paid cloud calls in these tests.
  Reports: .diagnostics/spec013-decisions/{flash-live,flash-warm,clef-live,clef-warm}.json.
- Read-only production SQLite audit found completed calls with non-null provider/model:
  Clef-Flash194 (evaluate44, identity-tiebreak1, kind-pick2, meeting-match12, sample-compare135), Clef1(sample-compare).
  Older completed rows with missing provider/model excluded from those counts. Thus previous reporting that only
  download/integration was known was incomplete: these models had already been used by the actual application.
- Five decision routes exist. They do not replace audio transcription, summaries, actionables, timelines or
  all speaker-name inference. Sample comparison may first purchase Gemini audio sampling before asking Clef.
- zero-cost intentionally falls back to paid engines in the existing plan/router. Corrected displayed label to
  Prefer free and disclosed possible paid-cloud fallback when selected globally or by override. No routing or
  saved configuration changes.24focusedtests passed, staged build passed; applied renderer only, inspected actual
  Settings/Pipeline screen. Screenshot .diagnostics/spec013-decisions/settings-live.png.
- Broader SPEC-013 remains partial for the boundaries listed above; these results close the question of whether
  Clef and Clef-Flash are installed and can answer through HiDock on GAMESTATION.














