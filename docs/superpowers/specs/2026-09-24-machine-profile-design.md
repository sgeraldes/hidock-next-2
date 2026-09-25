# Machine profile, hardware signature and execution profiles

Date: 24-sep-2026. Status: draft for approval.
Replaces the GPU-only fingerprint in `apps/electron/electron/main/services/hardware-profile.ts`
and extends `2026-09-16-resource-aware-transcription-execution.md` from transcription to every
heavy job in the app.

## Why

HiDock today assumes a big machine. On the reference workstation (AMD RX 6600 XT, no NVIDIA)
voice separation falls back to the CPU: 7 minutes for a 16-minute recording, and a 97-minute
recording running alongside other work froze the machine on 24-sep. The local embedder holds
~4 GB of RAM. Nothing measures the machine, so nothing adapts to it, and a normal user with
8 GB of RAM and integrated graphics gets the same plan as a workstation.

## 1. Machine profile (measured, not guessed)

On first launch, and whenever the signature changes, the app measures:

| Area | What is recorded | How |
|---|---|---|
| CPU | model, physical and logical cores, base clock | `os.cpus()`, WMI `Win32_Processor` |
| CPU speed | single-thread and all-core score | 3-second fixed workload in a worker, below-normal priority |
| RAM | total, free at measurement time | `os.totalmem()`, `os.freemem()` |
| GPU | every real adapter: vendor, name, dedicated VRAM, driver, which one drives the display | WMI + DXGI adapter list |
| GPU usability | per adapter and per runtime (CUDA, DirectML, CPU): does a probe model load, and how long one small call takes | tiny ONNX probe, batch 1 |
| Storage | drive holding the library: type (SSD/HDD/USB), free space, sequential read/write MB/s | 256 MB temp file, deleted by literal path |

The measurement runs at low priority, one step at a time, and takes under 30 seconds. It never
runs while a recording job is active.

## 2. Hardware signature

The signature is a hash over the parts that change what the app can run:

- CPU model and logical core count
- RAM total, rounded to the nearest 4 GB
- each GPU: vendor, model, VRAM rounded to 1 GB
- library drive: type and capacity bucket

Driver versions, free RAM and free disk space are not in the signature, so a driver update or a
full disk never triggers re-profiling. Measured speeds are not in it either, since they are
noisy.

The signature exists so startup stays silent. On every launch the app recomputes it from the
hardware inventory only (under 1 second, no benchmark, no disk test). If it equals the stored
one, nothing is measured and nothing is asked, ever. If it differs from the stored one, the app re-runs the measurement, shows what changed ("GPU added: RTX 4090"), and
proposes the profile that fits. A hardware change never goes unnoticed and never silently changes
the user's choice. The user confirms.

Stored in the settings table: `machine.signature`, `machine.measurement` (JSON, with date), and
`machine.profile` (the choice) together with the signature it was chosen under.

## 2b. Enablers: hardware is not enough

A GPU is usable only when the software it needs is present and works. For each runtime the app
checks, separately from the hardware:

| Runtime | Enablers checked |
|---|---|
| CUDA (NVIDIA) | driver version meets the minimum; CUDA runtime and cuDNN libraries the bundled ONNX Runtime / torch build expects; `onnxruntime-gpu` or CUDA torch actually loads |
| DirectML (AMD, Intel, NVIDIA) | Windows 10 1903+; DirectX 12 feature level of the adapter; `onnxruntime-directml` loads and creates a session on that adapter |
| CPU | Python runtime and model files present; ONNX Runtime CPU loads |
| Cloud | API key present and one test call succeeds |
| Remote host | host paired, reachable, and reports its own enablers |

Enabler state is part of what the startup check reads (file and version checks only, no model
load), so a removed CUDA install or a broken driver is noticed the same way a hardware change is.
It is not part of the hardware signature; it has its own stored state.

**Installing enablers.** When a profile needs something missing, the app says what and how big
("GPU profile needs the DirectML runtime, 180 MB") and installs it itself, into the app's own
folder: ONNX Runtime packages, Python wheels, and model files, downloaded from their official
sources with checksums. What the app cannot install (a GPU driver, a CUDA toolkit that needs
admin rights) it links to with exact instructions, and the profile stays unavailable until the
next check finds it.

**Switching rule.** A profile can be selected only when its hardware and all its enablers are
present. Otherwise it shows as unavailable, with the reason and the fix.

**Verify before switching.** Selecting a profile runs a qualification test before it becomes
active:
1. load each model the profile uses, on the runtime it will use;
2. run a bundled 30-second sample through every job (speakers, voice ID, embeddings,
   transcription if local);
3. check that the results match the reference output within tolerance, and that each GPU call is
   within the 50 ms limit on a display GPU.

If every step passes, the profile becomes active and the result is stored with the signature. If
any step fails, the previous profile stays active, and the app shows which step failed and why.
The same test runs again after an enabler install and after any detected change.

## 3. Execution profiles

One profile decides where each heavy job runs. Jobs: transcription, speaker separation,
voice ID, search embeddings, summaries and analysis.

| Profile | When it is proposed | Transcription | Speakers | Embeddings | RAM ceiling |
|---|---|---|---|---|---|
| Light | under 16 GB RAM, or no usable GPU and a slow CPU | cloud | cloud (Gemini speaker labels) | cloud or small local model (~100 MB) | ~1.5 GB |
| Balanced | 16 GB+, usable CPU, no usable GPU | cloud | local CPU, capped, short recordings first | small local model | ~3 GB |
| GPU | a GPU that passes the probe (AMD/Intel via DirectML, NVIDIA via CUDA) | cloud or local | local GPU | local GPU | per measurement |
| Remote host | a model host on the LAN is paired | on host | on host | on host | ~1.5 GB local |
| Custom | user overrides any single job | chosen | chosen | chosen | chosen |

Every local job, in every profile, follows the same rules:
- one heavy job at a time;
- below-normal priority and a CPU cap (the existing `cpuPercent`, default 50);
- on the GPU that drives the display, no single call may take longer than 50 ms. The job cuts
  audio and batches to stay under that, and falls back to the CPU for the rest of that job if a
  call goes over twice.

Settings shows the active profile, what was measured, and the observed execution per job
("Speakers: DirectML · RX 6600 XT, 38 ms per call").

## 4. The AMD GPU, specifically

The RX 6600 XT has to run speaker separation and embeddings through ONNX Runtime + DirectML.
Current state: branch `feat/short-lane-and-onnx` exports pyannote 3.1 (segmentation + WeSpeaker
ResNet34) to ONNX. DirectML fails on the framing Conv in the embedder.

Plan:
1. Move the feature-extraction front end (fbank framing) out of the ONNX graph into numpy on the
   CPU. It is cheap, and it is the layer DirectML rejects. The graph then starts at the features.
2. Export with a fixed-size window (10 s) and batch 1–4 so each call has a known cost.
3. Measure per call on the RX 6600 XT. Pass criterion: every call under 50 ms, results within
   tolerance of the CPU pyannote output on 5 real recordings (same speaker count, DER delta < 2%).
4. Embeddings: the same DirectML path for the embedding model, or a smaller model if the 1B
   model cannot stay under 50 ms per call.

## 5. Backup (in the app, any machine)

- The app backs up after idle, only when data changed.
- It saves only what cannot be rebuilt: transcripts, summaries, speakers, edits, contacts,
  settings. It excludes embeddings, indexes and caches.
- One compressed file, three versions kept, with a size cap. Location defaults to the app data
  folder; the user can pick any folder, such as OneDrive.
- On a new install, the first launch offers "Restore from a HiDock backup".
- One pre-upgrade copy, deleted after a successful migration.
- Replaces `scripts/backup-db.py` and the `HiDock-DB-Backup` scheduled task, both removed.

## Delivery order

1. Machine profile + signature + change detection (PR 1).
2. Execution profiles and the per-job router, Light as the default without a usable GPU (PR 2).
3. AMD DirectML path for speakers and embeddings (PR 3), verified on the RX 6600 XT.
4. In-app backup, then removal of the script, the task and the 81 GB of old copies (PR 4).

Each PR is tested on the reference machine with heavy models off, then on.
