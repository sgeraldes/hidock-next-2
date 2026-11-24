# Live pipeline and false calendar assignment — 7 October 2026

## Observed runtime

The running checkout is `G:\Code\hidock-next-2`, not the tool's default checkout.
The live profile is `hidock-universal-knowledge-hub`; the database was inspected read-only.
At the initial sample, the backend reported one executing job and five pending jobs.
The Library's aggregate “transcribing” count is not a concurrency measurement.

Configured speaker engine: `model-host`, endpoint `gamestation:8765`. Anonymous host health
reported version 0.4.0, capabilities `diarize` and `decide`, and busy/ready state.
Completed diarization runs recorded device `cuda`. This is consistent with remote execution
on the configured NVIDIA host, but the stored run lacks host/job identity: `execution` is
incorrectly hardcoded to `local` even for remote results. Host busy alone cannot prove ownership.
ASR uses Gemini cloud. VAD, application/database work, and ONNX embeddings remain local.
Remote-host failures can still silently fall back to local diarization in the current code.

## Measured stage durations

| Recording | Diarization | Gemini transcription | Summary | Local RAG indexing |
| --- | ---: | ---: | ---: | ---: |
| 15:56 ad-hoc call, `c12fdd56-7e9f-4e7d-8d81-d960321fa789` | 34.85 s | 24.80 s | 9.63 s | 32.53 s |
| `83441c8c-99ec-4b86-84a8-84ef1f7d9127` | 100.76 s | 200.26 s | 10.49 s | 51.47 s |
| `29bb834b-b561-4e1d-a4dd-9982706c5fa0` | — | 105.70 s | 9.00 s | 16.92 s |

These are stage wall times, not CPU-active durations. The UI's 20% is a fixed milestone
before provider transcription, not a measured completion percentage. Some title/meeting
resolution stages have zero measured time because they reuse the summary call.

## Bounded responsiveness sample

`scripts/diagnostics/sample-live-backend.ps1` collected twelve samples approximately three
seconds apart without WMI enumeration, app restarts, USB operations, or model invocations.
Raw output: kept in the local diagnostics folder, outside the repository.

Most main-process backend responses took 1–46 ms. At 16:21:57 local time the request exceeded
the two-second timeout. At that point the host health was `ready`, and the current recording's
Gemini transcription stage was in progress. Its first cloud chunk eventually took 98.293 s
after a 1.851 s upload. Thus the timeout did not coincide with that recording's diarization
or RAG indexing stage. Other local concurrent work and GC remain possible.

Main-process RSS grew from 1,418.5 to 1,663.3 MiB across the sample; maximum sampled main-process
CPU was 3.74% of machine capacity. This excludes renderers, workers, other applications,
system commit, GPUs and IRQs. A main-process timeout is evidence of missed responsiveness,
not proof of a whole-machine freeze or its root cause.

## False “practice meeting · part 2 of 2”

The 15:08 and 15:56 recordings both have the same persisted practice-event ID, correlation
method `ai_transcript_match`, confidence 0.95. The event window is 15:00–16:00 and its attendee
field is null. The stored explanation for the ad-hoc call is shared DFX5 technical work,
architecture, funds and two client projects, contrasted with another school-event candidate.
That is generic topic overlap, not evidence of event identity.

The owner clarified the later call was a separate Slack conversation with two colleagues,
and himself. `withMeetingParts()` groups every shared meeting ID and numbers recordings
by start time; the LLM did not request or generate the part numbers. `getDisplayTitle()` gives
the linked calendar subject precedence over the transcript's content title, amplifying the error.

## Prepared source correction

The meeting-selection prompt now explicitly allows no match and disallows shared employer,
client, project, broad topics and time alone. Automatic linking additionally needs exact
grounded evidence: a spoken event reference, or a concrete non-generic agenda phrase present
in both calendar description and transcript. Missing evidence retains a candidate rather
than automatically assigning it. Common negative/history contexts are rejected conservatively.
This is a precision heuristic, not proof of event identity; paraphrases may require confirmation.

Entity reconciliation, indexing and resolution provenance now read the persisted gated link,
rather than the raw model proposal. Provenance stores the model proposal separately.
Ten targeted tests, 51 existing transcription tests, and the main TypeScript check pass. Independent QA found and prompted
repairs for provenance leakage and overly broad negative-context detection.

The app was subsequently rebuilt and gracefully restarted. The existing authenticated
`recordings.selectMeeting(recordingId, null)` operation cleared the ad-hoc call's meeting
and candidate selection. A readonly database check confirmed `meeting_id=null` and
`correlation_method=user_preassign_standalone`. The real renderer then showed the ad-hoc
content title separately and the practice meeting without part numbering. A subsequent
full reprocessing preserved the explicit standalone decision.

## Required telemetry contract

Both client and host should show the same job ID, recording ID, current stage, execution
location (this PC / GAMESTATION / provider), actual device, attempt/fallback reason, queue
counts and timestamps. Every stage needs trace spans; stage wall time must not be presented
as CPU time. Stale hosts and historical orphan `running` rows must not appear live.

Show measured CPU, RAM/commit pressure, GPU utilization and VRAM with source and last-seen
time. Unsupported/unavailable metrics stay unknown. CPU thread limits are not guarantees
of resource reservation. Host offline should queue work without silently moving it to client CPU.

Tokens already exist for several Gemini stages in `usage_json`; use per-provider usage and
call counts. The native ASR sample reports input tokens but zero output tokens, so an output
tk/s rate cannot be invented. For ASR, audio seconds processed per wall second is also useful.
Expose true output-generation tk/s only where the provider/host measures output tokens and
generation time. A visual waterfall should distinguish queue, loading, uploading, remote
compute, local compute, database/index commits, and cancellation.

## Applied dashboards and bounded real benchmark

The real Electron monitor now renders local CPU, owned Electron working sets, available
system RAM, main-loop delay, queue state, recent processing spans and paired host metrics.
The initial `Monitor unavailable` was caused by a hot-updated renderer using an older
preload/backend without the new IPC method. A complete build and graceful restart restored
the bridge; the real IPC call and rendered monitor were exercised with Playwright.

Model Host 0.4.1 was built and sent through the existing paired update operation. The live
GAMESTATION health response reports 0.4.1. Authenticated telemetry identifies 32 logical
cores and an RTX 4090, including measured utilization and VRAM. On GAMESTATION the simple
read-only page is `http://localhost:8765/`; remote browser login is not implemented. HiDock
obtains remote measurements through its paired client. Sampling is every five seconds,
GPU probes cannot overlap and time out after 1.5 seconds. The host service measured about
65 MiB RSS when idle; this excludes model workers. Unknown token throughput remains unknown.

The seven-minute ad-hoc recording was reprocessed once through the real pipeline:

| Stage | Actual location | Wall time |
| --- | --- | ---: |
| VAD | Client | 0.386 s |
| Diarization | GAMESTATION / CUDA | 13.199 s |
| Transcription | Gemini | 19.106 s |
| Summary | Gemini | 8.028 s |
| Actionables | Gemini | 5.441 s |
| Timeline | Provider managed | 2.077 s |
| Wiki export | Client | 0.103 s |

Both sides recorded host job `54c9463e-7936-407d-9f8b-0bed60222b5a` and recording
`c12fdd56-7e9f-4e7d-8d81-d960321fa789`. Host reported completed / CUDA. Eight five-second
samples returned in at most 40.7 ms; sampled main-loop delay peaked at 15.4 ms. Whole-client
CPU was about 13–21%; available RAM remained above 19.8 GiB. The existing index was reused,
so this run did **not** exercise first embedding-model load or a fresh indexing batch.

A separate real semantic search exercised first local ONNX load: 29.201 s to create the
session, 0.087 s inference, 30.322 s end-to-end for three results. The worker reported CPU
and 12 threads. A memory admission check now runs before forking/loading weights, in
addition to the existing post-load monitor and idle teardown; a resource pause suppresses
cloud fallback. Its insufficient-memory branch passed process-boundary regression tests.
The rebuilt app was restarted before the real semantic search.

Independent QA also found the transient admission pause had no recovery and idle respawns
accumulated shutdown listeners. The final source now rechecks an admission-only pause at
most once per 30 seconds on future requests/status reads, without a retry timer or automatic
model spawn. A worker crash/runtime-limit pause still requires explicit app restart. The
monitor exposes the pause reason. Shutdown cleanup is registered once per service lifetime;
regressions cover recovery without automatic spawning and one listener across idle respawns.

Sixteen samples around startup/first local search returned IPC in at most 44.6 ms,
with sampled loop delay at most 24.4 ms and monitor peak 303.4 ms. Combined Electron
working sets reached 5512.7 MiB; available RAM remained at least 17.28 GiB. The second
boot restored 130222 vectors from binary cache in 7116 ms and reported 15990 ms of
scheduled boot-task wall time. The local model worker unloaded after 60 seconds idle.

## Windows kernel evidence and its limits

A real elevated 60-second WPR CPU capture saved `cpu-kernel.etl`, but dropped 728094
events and did not include DPC/interrupt events. It must not be used to rule out IRQ
or driver stalls. Its sampled CPU report put WmiPrvSE and Teams ahead of HiDock during
that window; the loss prevents treating these percentages as a complete account.

A separate bounded DPC/interrupt capture, without CPU sampling or stack collection,
ran for 11.26 seconds. `xperf -a tracestats` reports zero lost buffers/events. Its
histograms contain 69542 DPCs (all in bins at or below 128 microseconds) and 42319
interrupts (all at or below 64 microseconds). This is a baseline while responsive,
not a capture of the reported intermittent freeze. No long IRQ stall was present
in this particular window. The repeatable elevated diagnostic is
`scripts/diagnostics/capture-kernel-dpc.ps1`; raw and merged traces are retained.

The intermittent whole-computer freeze was not reproduced in these runs. The measurements
do not establish its root cause, guarantee absence of future freezes, or provide a complete
IRQ/driver diagnosis. Decision request admission on the host remains unbounded under an
authenticated burst; the simple dashboard's recent history is capped at 20 jobs.

The user was away from the computer during the technical benchmarks. Human-observed Windows
responsiveness was not checked, and absence of a reported freeze is not UX verification.
A coordinated observation test was subsequently performed with the user present.
The user reported a freeze near its end and could not close the open processing monitor.
This is a failed UX acceptance test. In that window IPC peaked at 50.4 ms, the main-loop
peak was 314.3 ms, sampled system CPU peaked at 36.3%, and available RAM remained above
17.39 GiB. Sampling began after the initial 3.6-second semantic query, so these samples
do not fully cover model loading. They also do not measure renderer scheduling, DWM
presentation or input responsiveness. Backend responsiveness cannot disprove the freeze.
The worker's 60-second idle release is a temporal hypothesis requiring correlation,
not an established cause. Do not report this incident resolved.

A second DPC/ISR baseline recorded 18:10:21–18:10:33 local time without lost events;
it started after the reported freeze and therefore did not capture that event.
Bounded renderer long-task/input/timer measurements and narrow DWM/DxgKrnl presentation
ETW were started separately without restarting the app or initiating model/USB work.
Chromium reports hardware compositing on the RX 6600 XT through ANGLE D3D11,
AMD driver 32.0.21045.5002. This identifies the rendering path, not a driver fault.

The passive 18:14–18:15 window captured 60 renderer samples, maximum response 7.3 ms,
no long tasks/timer gaps, and no user input events. The graphics trace lost no events.
DWM scheduling intervals included long waits, but an idle/static desktop can wait
between redraws; these intervals alone do not establish a compositor stall.

The renderer-only update was built and loaded without restarting the main process or
reconnecting USB. Actual UI automation verified the visible Close button and Escape
dismiss the monitor after its exit animation. The monitor now reports its own foreground
JavaScript scheduling peak as well as the main-loop peak, explicitly distinguishing
these counters from graphics/input stalls. These are usability/diagnostic improvements,
not proof that the reported freeze is fixed. Main-process queue-span boundary changes
remain source-only until a later controlled backend restart.

## Severe recurrence reported at 19:21 local time

The user reports roughly 30 minutes of whole-computer/video/RAM starvation, with
more than ten minutes waiting for HiDock to respond/close before killing it.
The short earlier traces did not cover this entire later interval. Do not use
their responsive samples to dismiss the incident or characterize it as resolved.

Preserved stdout/stderr separately as `severe-freeze-preserved-*.log` in the diagnostics
directory. Stderr records PID 633632 at 19:20:10.420:
`GPU state invalid after WaitForGetOffsetInRange.` This is an actual graphics-path
failure, but occurred near shutdown/recovery and could be a consequence rather than
the initiating fault. Stdout eventually records cleanup. Post-recovery enumeration
found no Electron or command-line-identified HiDock/model/diagnostic workers left.

Windows System records inspected over the preceding two hours contain no logged
Display/WHEA/resource-exhaustion event. Application logs record repeated access-violation
crashes in ElgatoAudioControlServer at 17:52, 18:15 and 18:41, with crash dumps retained.
These are an independent lead, not proven causal. No new LiveKernelReport was found.
C: currently has 14.7 GiB free and had earlier Volsnap insufficient-space events.
Peak memory/VRAM during the actual long freeze is unknown.

An opt-in `run-electron-recovery.bat` was prepared and the main bundle rebuilt without
launching HiDock. It uses `--recovery-mode` / `HIDOCK_RECOVERY_MODE=1` to disable hardware
rendering before windows, prohibit local embedding loads, pause/block transcription,
disable optional feature initiation without writing saved settings, prevent automatic
device connection/connectors and return before background watcher/boot/backfill startup.
Recovery additionally initializes configuration with persistence disabled and opens
only an already compatible database schema, skipping migrations/repairs/backups.
Independent QA confirmed these hooks; incompatible schemas may refuse recovery startup.
Software painting stays available. Recovery-specific failures explain the per-launch
restriction. Focused tests cover software-rendering selection, no model fork despite
available RAM, and feature suppression without saved configuration changes.
The initial build-only status was superseded by the guarded runtime tests below.
The app remains closed; a new full-workload reproduction is deliberately not attempted.
The underlying RAM/graphics freeze remains unresolved.


## Guarded recovery and audio-memory correction, 20:42 local

The user recovered after closing both HiDock and Edge; Claude and Codex also consume
substantial resources. Combined pressure is the scope; no single culprit is established.
Three actual recovery runs used a native Windows Job guard with an adaptive aggregate
committed-memory limit, physical-memory reserve and timed own-family cleanup. The
recovery launcher invokes this protection for five minutes. Normal startup is NOT
protected by it; kernel allocations and VRAM are outside this job limit.

Full job peaks: first recovery 1952.51MiB, five-second audio recovery 746.32MiB,
long-audio recovery 730.21MiB. The third run retained at least 21568.72MiB available
physical RAM. These are complete trace values, not early samples. A memory-allocation
fixture confirmed containment near a configured 192MiB job limit (reported ~197MiB).

First-run renderer increase coincides with coarse waveform cache creation at20:24:05
for d1b91bb8-0d69-4796-8c84-3f9bd8bdc083:3444s,27,553,260-byte WAV.
The old renderer then automatically attempted full PCM refinement of coarse peaks.
The size of encoded audio does not bound decoded PCM. Temporal correlation establishes
a relevant allocation path, not the initiating cause of the severe Windows freeze.

Changes serialize audio read/decode work, discard cancelled queued requests and yield
during peak scanning. Playback uses coarse cached peaks without whole-file PCM decode;
automatic refinement only admits known coarse durations up to120s. Missing previews
are reported unavailable. Five-second deadlines cover metadata, playback start and
both audio-context resume paths. Main-process reads reject >64MiB before Buffer/base64
allocation. Until streaming exists, those recordings cannot play through this path.
The duration gate trusts cached duration; it is not a hard decoded-PCM memory bound.

Actual rebuilt recovery: three rapid selections of the same3444s recording completed
in2.3ms. An existing >64MiB recording returned the limit error via IPC without payload.
A native five-second audio had earlier persisted exact peaks. Attempted read counting
was invalid because the preload bridge is frozen; artifact readCount is null.
Artifacts: recovery-memory.jsonl,recovery-audio-memory.jsonl,recovery-long-audio-memory.jsonl,
long-waveform-real.json,oversized-read-real.json in the diagnostic directory.
29 focused renderer tests and12 storage tests passed; node/web type checks passed.
All runtime tests excluded USB, models and transcription. HiDock is closed again.
No full-workload user-observed acceptance test has passed. Whole-machine freeze remains
unresolved; do not characterize controlled recovery results as a complete correction.
