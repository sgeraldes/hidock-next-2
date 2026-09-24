# SPEC-013: Resource-Aware Transcription Execution and Remote Compute

- **Status:** Proposed
- **Date:** 2026-09-16
- **Scope:** Electron transcription settings, local workers, remote processing, queue truth, retries, resource isolation
- **Amends:** SPEC-007, SPEC-009, and SPEC-011
- **Origin:** written 16-sep in the archived `sgeraldes/hidock-next` repository, where it was never
  committed; moved here on 24-sep with its mockups (`mockups/spec-013-*`). SPEC-007, 009 and 011 live
  only in that archive.
- **Built since, in this repository:** the speaker-linking timeout scaled to the audio length, the
  CPU-percentage thread budget for the diarization worker (`diarizationThreadEnv` in
  `speaker-linking.ts`, every OpenMP/MKL/BLAS/torch variable), speaker setup per hardware with DirectML
  detection (#35), the Model Host as the remote audio worker (#9). Process priority, stage checkpoints
  and the device-download backpressure in section 6.5 have not been checked against today's code;
  that re-scope is a dated row in `docs/superpowers/plans/2026-09-24-hidock-plan.md`.

## 1. Product decision

HiDock Next MUST remain responsive while transcription and enrichment run with or without a supported GPU. Local model
execution is background work and MUST NOT be allowed to saturate the workstation, make the UI unresponsive, or silently
repeat paid provider work.

The user chooses a transcription engine and an execution location. Local execution uses a percentage-based CPU budget
that is recalculated for the current machine. Remote execution can use a separate HiDock Worker host for audio workloads
and an Ollama host for chat and embeddings. Ollama is not treated as an audio diarization or ASR server unless it later
exposes a compatible, explicitly tested audio API.

The default local policy is **Balanced: 50% of logical processors, below-normal priority, one recording at a time**.
On a 24-thread machine this resolves to 12 logical processors. The UI MUST show both the percentage and the resolved
count.

### 1.1 Incident evidence that this spec must correct

The 2026-09-16 incident establishes two independent responsiveness defects:

- `2026Sep10-140259-Rec82.hda` spent 2 h 5 min in local pyannote diarization on an RX 6600 XT machine. The worker
  selected CPU because the installed PyTorch runtime exposes CUDA or CPU, and it received no affinity, priority, or
  runtime thread limit. Four earlier runs had already failed at the former 600-second timeout.
- While that worker was still active, device reconciliation queued `2026Sep16-094536-Rec02.hda` (48.0 MB). The live
  download path sends per-poll progress from main to renderer, returns 256 KB data batches to renderer, assembles the
  entire file there, and sends the full buffer back to main for persistence. The durable queue does not become
  `downloading` until the first renderer batch reports progress.

The first defect can saturate the computer; the second creates avoidable IPC, allocation, and render pressure exactly
when the machine is already under load. Killing the development process ends both workloads, so immediate recovery
does not prove that USB transfer alone caused the freeze. The permanent correction MUST address both paths.

## 2. Goals

1. Keep playback, navigation, device access, and ordinary desktop work responsive during background processing.
2. Make the selected engine, execution location, accelerator, CPU budget, and fallback policy explicit.
3. Support a remote RTX/NVIDIA workstation without requiring the Electron application or recording library to move.
4. Make every in-flight stage visible and cancellable from a single persistent operation ledger.
5. Prevent an optional enrichment failure from discarding valid transcription work or triggering repeated paid calls.
6. Preserve exact execution provenance for every completed or failed stage.

## 3. Non-goals

- Pretending unsupported AMD acceleration is available to the existing CUDA-based PyTorch pipeline.
- Exposing Ollama directly to the public internet.
- Running multiple recordings concurrently by default.
- Retrying a complete pipeline when only a downstream validation or enrichment stage failed.
- Using elapsed wall-clock time as synthetic progress.

## 4. Settings model

### 4.1 Transcription engine

The settings surface groups provider choice and execution policy in one `Transcription` section.

| Engine | Audio execution | Required settings |
|---|---|---|
| Gemini 3.5 Transcribe | Google cloud | API key, model, local/remote speaker-identification policy |
| Local ASR | Local or HiDock Worker | runtime/model, execution host, resource policy |
| VibeVoice | Local or HiDock Worker | runtime/model, execution host, resource policy |
| Remote worker default | HiDock Worker decides from advertised capabilities | worker URL, token, tested capabilities |

Engine availability MUST be capability-driven. A saved value is not proof that the engine is usable.

### 4.2 Execution location

- `This computer`: use a supervised local worker.
- `Remote worker`: send the recording to a configured HiDock Worker service.
- `Auto`: prefer a healthy compatible remote worker; otherwise use bounded local execution only when local fallback is
  enabled.

The default remote failure policy is **Pause and show the error**. The user may opt into `Fall back to this computer`,
which always retains the configured local CPU budget.

### 4.3 Local resource policy

```typescript
interface LocalComputePolicy {
  cpuPercent: number;              // integer, 10..100, step 5; default 50
  priority: 'low' | 'below-normal' | 'normal'; // default below-normal
  maxConcurrentRecordings: 1 | 2;  // default 1
  accelerator: 'auto' | 'cpu';     // future capability ids may extend this union
  pauseOnBattery: boolean;         // default true on portable devices
  pauseWhenSystemBusy: boolean;    // default true
  busyCpuThresholdPercent: number; // default 80, measured outside HiDock workers
}
```

`cpuPercent` is a percentage of logical processors visible to the application. The resolved limit is:

```text
max(1, floor(logicalProcessorCount * cpuPercent / 100))
```

The UI MUST render `50% · 12 of 24 logical processors`, not just `50%`. Values are clamped after a hardware change.

All local model subprocesses MUST receive the same budget through both mechanisms:

1. operating-system scheduling controls: process-tree priority and CPU affinity/CPU sets; and
2. runtime controls: `torch.set_num_threads`, `torch.set_num_interop_threads`, `OMP_NUM_THREADS`,
   `MKL_NUM_THREADS`, and equivalent controls used by the selected engine.

Applying only affinity or only an environment variable is insufficient. Child processes MUST inherit the supervised
job/process group. Windows implementations MUST account for processor groups on machines with more than 64 logical
processors.

Changes apply to the next stage by default. The UI offers `Apply after current stage` and, when safe cancellation is
supported, `Restart current stage with new limit`. It MUST NOT abruptly kill an active worker merely because the slider
moved.

### 4.4 Accelerator behavior

`Auto` uses only accelerators advertised as supported by the installed runtime. The current speaker-linking runtime may
advertise CUDA or CPU. An AMD GPU that is not supported by that runtime results in a visible CPU selection, not an
error and not an attempt to use CUDA.

The UI shows observed execution, for example `CPU · 12 threads`, `CUDA · RTX 4090`, or `Remote · RTX 4090`. Hardware
detection is refreshed at startup and on explicit `Test` actions.

## 5. Remote compute architecture

### 5.1 Separate service roles

```text
HiDock Next desktop
  ├─ Ollama endpoint       -> chat and embeddings
  └─ HiDock Worker endpoint -> VAD, diarization, voice embeddings, ASR, timestamp validation
```

The HiDock Worker exposes a versioned API with:

- `GET /v1/capabilities`: engine/model versions, devices, available memory, supported stages, protocol version;
- `POST /v1/jobs`: create an idempotent job from a content hash and pipeline request;
- `GET /v1/jobs/{id}` or server events: real stage/progress/resource state;
- `POST /v1/jobs/{id}/cancel`: cancel the entire supervised process tree;
- `GET /v1/health`: bounded health response without loading a model.

Transport MUST use TLS outside a trusted loopback connection. Authentication uses a revocable bearer token stored in
the OS credential store. Tokens MUST NOT appear in logs, operation metadata, exported diagnostics, or renderer state.

Audio is streamed or uploaded once per content hash. The worker may cache encrypted temporary input for the job, but it
MUST delete it on completion/cancellation according to a visible retention policy. Remote results include hashes so the
desktop can verify that they belong to the requested recording.

### 5.2 Remote capability test

`Test connection` MUST verify network reachability, authentication, protocol compatibility, and the capabilities needed
by the selected engine. Success copy includes the observed host and device. A health response alone MUST NOT mark an
engine ready.

## 6. Permanent pipeline correction

### 6.1 Worker isolation

- PyTorch, ONNX embedding, ASR, diarization, and other large model runtimes MUST NOT execute inside Electron's main or
  renderer process.
- Local workloads run in supervised sidecars with explicit memory, CPU, priority, cancellation, and idle-unload policy.
- The Electron main process remains the coordinator and persistence boundary.
- Model sidecars unload after a configurable idle period or immediately under system memory pressure.

### 6.2 Stage checkpoints

Every stage writes a durable checkpoint before the next stage begins. The transcript-producing critical path runs
before optional identity enrichment when the selected provider can produce speaker-separated text:

```text
queued -> VAD -> transcription -> timestamp validation -> transcript available
                                                       -> analysis -> embeddings -> graph/wiki
                                                       -> optional speaker/voice enrichment
```

A valid provider transcript is checkpointed before timestamp validation. If validation fails, the app retries only the
repair/validation path using the saved provider response. It MUST NOT resend the audio unless the user explicitly asks
for a new transcription.

Optional speaker linking that is disabled, unavailable, exceeds its resource budget, or times out records `degraded`.
It MUST NOT delay a provider transcript by hours. A provider that requires local diarization as input may run the stage
on the critical path only with the same resource ceiling and a visible time budget. Corrupt output, cancellation, or an
explicit fail-closed privacy condition remains blocking.

### 6.3 Retry policy

- Automatic retries are stage-specific, bounded, and classified by error type.
- Paid provider calls default to zero automatic whole-audio retries after a response is received.
- Network failures before a confirmed provider response may retry with an idempotency key when the provider supports
  it; otherwise the operation pauses for explicit user action.
- Deterministic validation failures, local timeouts, unsupported hardware, missing dependencies, and out-of-memory
  failures are not automatically repeated.
- The UI states whether retrying may resend audio or incur provider usage.

### 6.4 Operation truth

`processing_runs` (or its successor operation ledger) is the persistent source of truth for all direct, queued,
automatic, local, and remote execution paths. Queue state is a projection of that ledger.

An operation remains `running` only while the supervisor owns a live local process tree or a confirmed remote job. The
renderer receives a snapshot plus monotonic revisioned events. It MUST never show `Transcription in progress` while the
authoritative snapshot reports zero running operations.

On startup, the coordinator reconciles each running operation:

- live owned local child: reattach when supported, otherwise mark interrupted;
- reachable remote job: resume observing it;
- no live owner: mark interrupted and expose Resume/Restart;
- completed checkpoint: continue from the next incomplete stage.

### 6.5 Device sync isolation and backpressure

Device sync is a main-process streaming operation. The renderer receives bounded progress/state events and never owns
the recording bytes.

1. Set the durable item to `downloading` **before** issuing `CMD_TRANSFER_FILE`.
2. Stream Jensen bodies directly into a uniquely named `.partial` file in the recordings directory while tracking the
   received length and incremental hash. Do not retain the full recording in renderer memory or send it back over IPC.
3. On the proven protocol byte boundary, flush and close the stream, verify expected length, apply the original
   recording timestamp, then atomically rename. A failure or cancellation removes only the partial file.
4. Coalesce progress to at most 4 renderer updates per second and always deliver the terminal update. Use one progress
   path; do not emit a second update for the same bytes from both raw USB receive and data-batch handling.
5. The UI store updates only when the visible percentage, byte count bucket, stage, or ETA changes. Progress events do
   not trigger database exports or full-library refreshes.
6. Device sync and transcription may coexist only under the global resource coordinator. Sync reserves the main
   process, disk/IPC budget, and at least half of the machine's logical processors for foreground work. A local model
   already constrained to 50% need not be killed, but the scheduler may pause between model stages.
7. Auto-transcription for a newly downloaded recording starts only after the file is atomically visible and the sync
   commit is durable. It never causes the same bytes to be copied through renderer IPC.

## 7. Operations UI

The Operations panel shows one row per recording with:

- current stage and real progress evidence;
- engine and model;
- execution location and observed device;
- applied CPU budget and process priority for local work;
- elapsed time and latest checkpoint;
- remote host when applicable;
- Pause/Resume/Cancel and failure details;
- retry consequence: `local only`, `uses saved response`, or `resends audio / may incur usage`.

Settings and Operations use the same vocabulary. `Provider`, `engine`, `worker`, and `brain` MUST NOT be used
interchangeably.

## 8. Failure behavior

| Condition | Required outcome |
|---|---|
| Unsupported or changed GPU | select supported accelerator or CPU; preserve bounded operation |
| System load exceeds threshold | pause between stages; do not interrupt device playback or an atomic database commit |
| Local worker timeout | terminate full process tree; record diagnostics; degrade optional stage or pause required stage |
| Remote worker unreachable before upload | pause; no local fallback unless enabled |
| Remote disconnect after job creation | reconnect by job id; never create a duplicate job blindly |
| Provider transcript received, validation fails | retain response; retry validation/repair only |
| Memory pressure | stop dequeuing, unload idle models, keep UI responsive, expose reason |
| App restart | reconcile durable operations and checkpoints before scheduling new work |
| User changes CPU budget | apply next stage or explicitly restart the current stage |
| Device sync begins during local inference | retain the CPU ceiling, prioritize sync/UI work, and coalesce progress |
| App exits during device transfer | mark interrupted on next boot, remove stale partial, and offer/resume one transfer |

## 9. Migration and defaults

- Existing installs migrate to `cpuPercent: 50`, `priority: below-normal`, `maxConcurrentRecordings: 1`,
  `accelerator: auto`, and local execution.
- Existing `speakerLinkingTimeoutSeconds` becomes a stage safety ceiling, not a performance control.
- Existing Ollama URL remains the text/embedding endpoint and is not copied into the audio worker URL.
- The first launch after migration displays a one-time explanation when a previous CUDA runtime now resolves to CPU.

## 10. Acceptance criteria

1. On a 24-logical-processor Windows machine, 50% resolves to 12 and every local transcription worker is constrained to
   the same budget and below-normal priority.
2. Swapping from an NVIDIA GPU to an unsupported accelerator selects CPU without a startup or transcription failure.
3. While a representative one-hour recording is processed locally, the UI remains interactive and the configured
   resource ceiling is observed at the process-tree boundary.
4. Cancelling a job terminates all descendants and leaves no running operation, orphan process, or automatic retry.
5. A local speaker-linking timeout degrades to provider diarization without requeueing the whole recording.
6. A timestamp-validation failure after a provider response does not make a second paid audio request.
7. A remote job runs on the advertised remote device, survives a desktop reconnect, returns verified results, and leaves
   no temporary audio beyond the configured retention window.
8. Queue/Operations state matches the persistent ledger for manual reprocessing, automatic work, and remote jobs.
9. Switching embeddings to remote Ollama prevents the Nemotron model from loading in Electron; idle local model memory
   is released.
10. Settings remain keyboard-operable, expose resolved processor counts, announce test/save results, and meet WCAG 2.1
    AA contrast and focus requirements.
11. A 48 MB device recording streams main-process USB-to-disk without the complete byte array entering renderer memory
    or returning over IPC; progress delivery never exceeds 4 updates per second plus the terminal event.
12. Starting sync while a CPU-only diarization stage runs keeps ordinary desktop interaction responsive, shows both
    operations truthfully, and does not create a second transcription attempt.

## 11. Verification plan

- Unit tests: percentage resolution, clamping after hardware change, retry classification, capability matching, and
  state transitions.
- Process integration: spawn a worker plus descendants, verify priority/affinity/runtime thread limits, cancel it, and
  confirm all descendants exit.
- Database integration: checkpoint/restart reconciliation and revisioned operation snapshots.
- Provider boundary: use one representative paid transcription and force downstream validation failure; verify exactly
  one provider audio request.
- Remote boundary: run VAD, speaker linking, and one ASR sample on the remote RTX host; verify returned hashes,
  cancellation, reconnect, and cleanup.
- UI boundary: exercise engine/location/resource controls and inspect Operations during a live local and remote run.
- Performance boundary: record UI latency, CPU, memory, and process count during a one-hour recording on CPU-only mode.
