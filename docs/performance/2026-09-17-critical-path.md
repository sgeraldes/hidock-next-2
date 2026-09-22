# HiDock performance incident: measured paths and hardware adaptation

Status: the local embedding main-process stall is addressed and exercised on this PC. Complete
hardware adaptation and unrestricted sync/transcription are not yet verified or implemented.

## Measurement scope

The benchmark launches a built Electron application, not Vite's development watcher. It uses an online
SQLite backup of the 2.87 GB production database and the installed Nemotron model assets. Writes go to
isolated library/profile directories. USB, transcription jobs, calendar network sync and connectors
are disabled; normal startup services and the 123,272-vector active partition remain enabled.

An external supervisor samples the owned process tree every 500 ms. Main and renderer heartbeat
intervals are 250 ms. V8 samples main-process stacks every 2 ms. Boot task durations and embedding
worker phases are recorded. Chrome trace JSON, V8 CPU profiles, raw observations, an HTML waterfall
and a rendered PNG are retained under ignored `artifacts/startup-*` directories.

The supervisor restricts the entire test tree to six logical CPUs at below-normal priority. The
50% embedding budget therefore produces **three ONNX threads** in this test; normal operation on a
24-logical-CPU machine produces twelve. These are controlled runs, not unrestricted hardware scores.
There is a 150-second run limit, a sampled 8 GiB process-tree working-set threshold and a 5 GiB
system-free-memory floor. These sampled limits are not hard OS reservations. Summed working sets
can count shared pages more than once. No provider billing conclusions follow from these tests.

## Findings

| Measured path | Observation |
| --- | --- |
| Initial main window | 0.82–0.98 s in representative controlled runs |
| Restore 123,272 vectors with existing cache | 1.3–1.7 s |
| Restore without vector cache | 2.41 s; peak app working set 2.09 GiB |
| Prior cache-validation query, same snapshot | 3,203.8 ms; indexed table access plus temporary GROUP BY tree |
| Replacement count query, same snapshot | 9.3 ms; covering-index-only count, with dimensions subsequently validated per row |
| Previous in-process local search | Main heartbeat ceased during model initialization and remained absent until the test was terminated; no completed inference |
| Isolated CPU local search | 2,048-dimensional vector generated; five retrieval results; normal process exit |
| Final measured tokenizer loading | 326 ms |
| Final measured ONNX session loading | 22,446 ms |
| Final measured ONNX inference | 76 ms |
| Final measured first search end to end | 23,338 ms |
| Final run peak app working set | 5.09 GiB; main process 1.26 GiB |
| Final run renderer worst heartbeat lateness | 13.9 ms |
| Final run main worst heartbeat lateness | 407 ms, outside the long model-loading interval |

The user's earlier 21,162 ms semantic restore log is useful incident evidence, but it is not a
controlled before/after baseline: the data location, OS cache, competing jobs and CPU policy differ.
The query comparison uses the same snapshot and is a single ordered comparison, not a statistically
controlled cold-storage experiment.

The last measured startup settles at 23.31 s even though the window appears in 0.87 s. About 14.5 s
is intentional scheduler delay (4 s before draining, seven 1.5 s gaps). Backup, reconciliation and
wiki work precede the semantic index. This readiness critical path is distinct from UI blocking.
Model/session construction, rather than the measured single-query inference, dominates first use.

The isolated first-search runs take roughly 21–29 s. The process boundary keeps native library
loading, session construction and inference off Electron's main thread. Remaining 0.2–0.4 s main
stalls occur in bootstrap/module loading, backup completion, reconciliation, capture backfill and
retrieval. They remain optimization targets; the app is not yet uniformly below a 50 ms latency budget.

## Changes exercised

- Vector restoration uses small, yielding pages and indexed count validation. ID, provider and
  dimensions are checked during metadata hydration; a mismatch rejects the cache.
- Production local embeddings run in an Electron utility process, packaged as a separate entry point.
- CPU inference uses 50% of available logical CPUs by default, one inter-op thread, sequential execution,
  and disabled ONNX thread spinning. Settings → AI Brains exposes 25%, 50% and 75%; changes apply after restart.
- Requests enter a parent-side serial queue. Each execution gets its own 90-second deadline after queue wait.
- The parent polls worker memory. Its threshold is the smallest of 8 GiB, one eighth of installed RAM,
  and half of free RAM when the worker starts. A low-free-memory check also stops the worker.
- Timeout, memory stop or unexpected worker exit settles pending callers and prevents automatic
  worker restart for that app session. Resource aborts do not authorize a paid embedding fallback.
- Normal application shutdown stops the worker. Benchmark process exit was followed by a check that
  the measured main and worker PIDs were gone.

The memory check is **best effort**, serviced by Electron's main loop. A hard guarantee needs an
external resource supervisor or Windows Job Object. CPU thread count is an ONNX limit, not a hard
process CPU percentage. GPU acceleration is deliberately not selected by this first containment change.

## Required permanent adaptation design

1. **One resource governor across engines.** Transcription, speaker linking, embeddings, audio conversion,
   indexing and sync housekeeping must lease from one CPU/memory budget. Default CPU share is 50% of
   available logical processors, recalculated after hardware/affinity changes. Reserve responsiveness
   capacity for main/renderer/IPC; never apply a UI process affinity that pins unrelated applications.
   Admit one heavy local job initially; queue subsequent jobs without starting their execution deadlines.
2. **Hardware capability selection outside main.** Detect supported runtime providers and adapters in a
   bounded process. Cache results keyed by hardware, driver, runtime and model version, not just model name.
   GPU availability does not imply that its backend supports the model. A GPU failure must terminate its
   worker before a bounded CPU fallback, and must not silently start an oversized CPU workload.
3. **Memory-aware model admission.** Estimate model weights, initialization overhead and batch workspace
   before launch. Prefer a smaller compatible model or an explicitly configured remote backend if the
   local estimate exceeds budget. Recheck available RAM at dispatch. Monitor independently of the UI loop,
   with OS-level limits where supported, and stop only owned workers on breach.
4. **Role-specific remote backends.** Configure endpoint, available model and capability separately for
   transcription, diarization, embeddings and generation. Validate protocol and model compatibility before
   routing. A remote Ollama host is not automatically an ASR/diarization endpoint. Keep embedding provider
   and dimensions consistent with the stored partition; hardware fallback must not mix incompatible vectors.
5. **Explicit states and cancellation.** Show queued, loading model, processing, paused for resources,
   remote unavailable, completed and failed. Report a paused search distinctly from no matching documents.
   Cancel must release leases and terminate stuck owned workers. Do not spin indefinitely or silently move
   a resource-failed job to a paid provider.
6. **Readiness dependencies.** Separate initial library readiness from semantic-search readiness. Hydrate
   the semantic index after required metadata repairs, without awaiting unrelated wiki exports or daily
   backups. Preserve data revision checks while moving expensive work out of the main process.
7. **Adaptive batch sizing.** Start CPU fallback with small batches; increase only within measured time and
   memory limits. Thread limits alone cannot prevent large inference tensors from exhausting RAM.

Settings design: place a shared **Local processing** control beside engine selection, with CPU share,
actual allocated logical CPUs, current backend, memory allowance, queue state and remote endpoint.
Keep per-engine overrides secondary. The current **Local embedding CPU budget** control is explicitly
limited to embeddings until the shared governor is connected to every engine.

## Acceptance evidence still required

- CPU-only, RX 6600 XT and RTX 4090 runs with recorded selected backend and actual worker thread counts.
- Representative long-recording transcription, diarization, sync and embedding work competing under one
  global budget, including cancellation and device disconnect with the repository's USB safety procedure.
- Low-memory admission rejection and live supervised termination, not just mocked memory metrics.
- Remote model host available/unavailable/incompatible and network interruption tests.
- Settings save/restart behavior exercised through the actual UI; current UI evidence is component tests,
  compilation and successful runtime consumption of the configured percentage.
- No main-process stalls above the chosen interaction budget, and no false successful/empty result on a
  model resource failure. Warm-session search latency must also be measured separately from first use.

An independent QA agent reviewed the process boundary and harness. Its findings led to separate queue
and execution deadlines, restart suppression and explicit worker-completion evidence. GPU adaptation,
aggregate resource limits and sampled-memory enforcement limitations remain open rather than hidden.
