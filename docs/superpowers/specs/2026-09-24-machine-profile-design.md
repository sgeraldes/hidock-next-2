# SPEC: Machine profile, execution profiles and in-app backup

- Date: 24-sep-2026
- Status: draft, awaiting Sebastián's approval
- Design: `docs/superpowers/specs/2026-09-24-machine-profile-architecture.md`
- Plan: `docs/superpowers/plans/2026-09-24-machine-profile.md`
- Replaces: the GPU-only fingerprint in `apps/electron/electron/main/services/hardware-profile.ts`
  and `apps/electron/scripts/backup-db.py` together with the `HiDock-DB-Backup` scheduled task.
- Extends: `2026-09-16-resource-aware-transcription-execution.md` and
  `2026-09-24-speaker-engines-design.md`, from speakers to every heavy job.

## 1. Problem

HiDock is built for one workstation and fails on ordinary machines.

Measured on the reference workstation (24 logical cores, 63 GB RAM, AMD RX 6600 XT
driving the display, no NVIDIA, library on a striped SSD) on 24-sep-2026:

| Fact | Value |
|---|---|
| Local speaker separation on CPU | 6 min 50 s for a 16.5-minute recording |
| Machine freezes caused by HiDock work | 2 on 24-sep; forced power-off at 13:33, hard reset at 16:38 |
| Local embedder resident memory | ~4.2 GB, 1B-parameter model, fp32 |
| Database size | 2,919 MB, of which 2,462 MB (84%) is `vector_embeddings`, which can be rebuilt |
| Hourly backup output | 25 × 2.72 GB = 68 GB, plus 13 GB of other copies, all on the same striped SSD as the database |
| AMD GPU use | none: torch in the Python venv is a CUDA build; the ONNX path fails on DirectML |
| Python runtime for speakers | `process.cwd()/.venv-speaker-linking`, which exists only on the developer machine |

Nothing in the app measures the machine, so nothing adapts to it. A user with 8 GB of RAM and
integrated graphics gets the same plan as the workstation.

## 2. Goals

- G1. HiDock runs on an ordinary Windows laptop (8 GB RAM, 4 cores, integrated GPU, one SSD)
  without freezing it or needing anything installed by hand.
- G2. The app knows the machine it runs on: its hardware and the software each runtime needs.
- G3. The app notices hardware or runtime changes without re-checking or asking on every startup.
- G4. The user chooses among execution profiles. A profile can be selected only when it works,
  and it becomes active only after a test on this machine passes.
- G5. The AMD RX 6600 XT is used for speaker separation and embeddings.
- G6. The app protects the user's data with a small backup that a reinstall or a new PC can
  restore, with no setup outside the app.

## 3. Non-goals

- Linux and macOS profiles. Detection returns "CPU only" there, as it does today.
- Installing GPU drivers or anything that needs administrator rights.
- Local transcription models. Transcription stays cloud or remote host in this spec.
- Automatic cloud upload of backups. The user may point the backup folder at a synced folder.

## 4. Definitions

- **Inventory**: the list of hardware parts, read from the OS. Cheap, under 1 second.
- **Measurement**: timed tests of CPU, GPU and storage. Takes up to 30 seconds.
- **Signature**: a hash of the inventory fields that change what the app can run.
- **Runtime**: a way to execute a model. The values are `cpu`, `directml`, `cuda`, `cloud` and `remote`.
- **Enabler**: software a runtime needs, such as ONNX Runtime with the DirectML provider, the CUDA libraries, model files, or an API key.
- **Enabler state**: what is installed and at which version. Cheap to read; no model is loaded.
- **Job**: one kind of heavy work. The values are `transcription`, `speakers`, `voiceId`, `embeddings` and `analysis`.
- **Profile**: a named assignment of a runtime to every job.
- **Qualification**: the test a profile must pass on this machine before it becomes active.

## 5. Requirements

Each requirement has an ID. The acceptance criteria in section 7 refer to these IDs.

### 5.1 Inventory and signature

- R1. At every startup the app reads the inventory: CPU model, physical and logical cores, total
  RAM, each real GPU (vendor, model, dedicated VRAM, whether it drives a display), and the drive
  that holds the library (media type SSD/HDD, bus type, capacity).
- R2. The signature is SHA-256 over this canonical JSON: CPU model, logical cores, RAM rounded to
  the nearest 4 GB, sorted GPUs as `vendor:model:VRAM rounded to 1 GB`, and library drive
  `mediaType:busType:capacity rounded to 100 GB`. Driver versions, free RAM, free disk space and
  measured speeds are excluded.
- R3. When the signature and the enabler state both equal the stored values, startup performs no
  measurement, no qualification and no prompt.
- R4. When the inventory read fails, for example a WMI timeout, the app keeps the stored profile, does not
  treat the failure as a hardware change, and shows "Could not read this computer's hardware" in
  Settings.
- R5. Inventory runs off the main thread and adds no more than 300 ms to the first window paint.

### 5.2 Measurement

- R6. When the signature changes, or on first launch, or when the user presses "Measure again",
  the app measures:
  - CPU single-thread and all-core score (a fixed 3-second workload in a worker);
  - for each GPU and each runtime whose enablers are present: load time and the time of one call
    of the probe model at batch 1;
  - library drive sequential write and read, in MB/s, with a 256 MB temporary file.
- R7. Measurement runs at below-normal priority, uses at most half the logical cores, runs one
  step at a time, and never while a job is running. It waits for jobs to finish.
- R8. Measurement deletes its temporary file by literal path, including after a crash, on the next
  start.
- R9. Results are stored with their date and the signature they belong to.

### 5.3 Enablers

- R10. For each runtime the app checks its enablers:

| Runtime | Enablers |
|---|---|
| cpu | ONNX Runtime CPU loads; the job's model files are present and their checksums match |
| directml | Windows 10 1903 or later; the adapter supports DirectX 12; the ONNX Runtime DirectML provider loads and creates a session on that adapter; model files present |
| cuda | NVIDIA driver at or above the version the bundled runtime requires; the CUDA and cuDNN libraries that runtime needs; the runtime loads; model files present |
| cloud | an API key is configured for the job's provider; one test call succeeded in the last 24 h |
| remote | a model host is paired, answers its health check, and reports its own enablers |

- R11. The startup check reads enabler state from files, versions and checksums only. It loads no
  model and makes no network call. A change in enabler state triggers the same flow as a
  signature change (R13).
- R12. When a profile needs a missing enabler the app can install, it shows the name, the
  download size and the source, and installs it into the app's data folder after the user
  confirms. It verifies the checksum and removes partial downloads by literal path. What needs
  administrator rights, such as a driver or a CUDA toolkit, it does not install: it shows the exact
  steps and a link.

### 5.4 Change detection

- R13. When the signature or the enabler state differs from the stored one, the app:
  1. keeps the current profile active if it still qualifies (checked by re-running its
     qualification); otherwise it falls back to the best qualified profile, and to Light as
     the last resort;
  2. shows one notice that names the change ("GPU added: NVIDIA RTX 4090", "RAM: 32 → 64 GB",
     "DirectML runtime removed") and the profile it proposes;
  3. never switches to a new profile without the user's confirmation, except for the fallback
     in step 1.
- R14. "Decide later" hides the notice for this signature and enabler state. Settings still shows it.

### 5.5 Profiles

- R15. The profiles:

| Profile | Transcription | Speakers + voice ID | Embeddings | Analysis |
|---|---|---|---|---|
| Light | cloud | cloud (speaker labels from the transcription provider) | cloud, or the small local model on CPU | cloud |
| Balanced | cloud | local CPU, capped | small local model on CPU | cloud |
| GPU | cloud | local on the best qualified GPU runtime | local on the same GPU | cloud |
| Remote host | remote | remote | remote | cloud |
| Custom | chosen per job from the runtimes that qualify | | | |

- R16. Proposed default: Remote host if paired and qualified; else GPU if a GPU runtime
  qualifies; else Balanced if RAM ≥ 16 GB and CPU all-core score ≥ the Balanced threshold;
  else Light.
- R17. A profile whose hardware or enablers are missing is shown unavailable, with the reason and
  the fix. It cannot be selected.
- R18. Settings shows, per job, the runtime actually used on the last run and its measured speed,
  for example "Speakers: DirectML · RX 6600 XT · 0.04 × real time".

### 5.6 Qualification

- R19. Selecting a profile runs qualification before the profile becomes active:
  1. load every model the profile runs locally, on its runtime;
  2. run the bundled 30-second two-speaker sample through each local job;
  3. compare with the stored reference output: same speaker count, speaker time overlap ≥ 95%,
     embedding cosine similarity ≥ 0.99 against the CPU reference;
  4. on a GPU that drives a display, every single call takes ≤ 50 ms.
- R20. On success the profile becomes active and the result is stored with the signature and
  enabler state. On failure the previous profile stays active and the app shows the step that
  failed and its measured value.
- R21. Qualification is re-run after an enabler install and on every detected change (R13).

### 5.7 Running jobs

- R22. At most one heavy local job runs at a time, across all jobs.
- R23. Local jobs run at below-normal priority with the configured CPU cap (default 50% of
  logical cores).
- R24. On a display GPU, the job cuts its input so each call stays under 50 ms. If two calls in
  one job exceed 50 ms, the rest of that job runs on the CPU and the event is recorded in
  `processing_runs.quality_json`.
- R25. A job never loads a model the active profile does not assign to it.

### 5.8 AMD path

- R26. Speaker separation (pyannote 3.1 segmentation + WeSpeaker ResNet34 embedder) runs through
  `onnxruntime-node` with the DirectML provider, in Node, without Python.
- R27. The audio feature front end (framing and filter-bank features) runs on the CPU. The ONNX
  graphs start at the features.
- R28. Results on the RX 6600 XT meet R19 against CPU pyannote on 5 real recordings from the
  library.
- R29. The embedding job runs through the DirectML provider on the RX 6600 XT, or uses the small
  model if the large one cannot meet R24.

### 5.9 Backup

- R30. The app backs up by itself. It uses no scheduled task and no external script.
- R31. A backup contains only data that cannot be rebuilt: all tables except the embedding and
  index tables, caches, and derived scores listed in the design. Audio files are not included.
- R32. The backup is one file, `hidock-backup-<yyyymmdd-hhmm>.hdbk`: a compressed SQLite
  snapshot with a manifest (app version, schema version, table row counts, checksum).
- R33. A backup runs after 10 minutes of idle, at most once per 24 hours, and only if the data
  changed since the last backup. When nothing changed, it writes nothing.
- R34. The app keeps 3 files: the newest, the previous one, and the newest one older than 7
  days. The total size is capped at 1 GB by default, adjustable in Settings. Older files are
  deleted by literal path.
- R35. The location defaults to `<app data>/backups`. The user can choose any folder in Settings,
  for example a OneDrive or Dropbox folder.
- R36. Settings shows the date, size and location of the last backup, with "Back up now" and
  "Restore…".
- R37. On first launch with an empty library, the app offers "Restore from a HiDock backup". Restore
  checks the manifest and the checksum, imports the data, then rebuilds embeddings in the background.
- R38. Before a schema migration the app takes one full safety copy, and deletes it after the
  migration succeeds and the app has started once.
- R39. After R30–R38 ship and a backup and restore round trip is verified on the reference machine:
  the `HiDock-DB-Backup` scheduled task is unregistered, `scripts/backup-db.py` is removed, the
  engine's `externalBackups` hook is removed, and the old copies in `F:\HiDock-Next-Data\backups`
  and `data\` are deleted file by file.

## 6. Constraints

- C1. No single GPU call over 50 ms on a GPU that drives a display.
- C2. One heavy local job at a time. Below-normal priority. At most 50% of logical cores by default.
- C3. Nothing is installed outside the app's data folder. No administrator rights.
- C4. Every deletion goes by literal path. No glob and no recursive delete.
- C5. Downloads come from official sources only, with checksums pinned in the app.
- C6. UI copy in plain Spanish (rioplatense) for Sebastián's build and plain English for the
  default, with no emoji. Errors state what happened and the action to take.
- C7. Windows 10 1903+ and Windows 11. `onnxruntime-node` stays at 1.24.3 unless the DirectML
  work requires a newer one, and then the change goes into the same PR.

## 7. Acceptance criteria

| ID | Criterion | Covers |
|---|---|---|
| A1 | Two consecutive starts with no change: the second start logs "machine unchanged", runs no measurement and shows no notice | R3, R11 |
| A2 | Changing the stored RAM value to simulate a change triggers one notice naming "RAM" and one measurement | R13 |
| A3 | A driver version change alone triggers nothing | R2 |
| A4 | A simulated WMI failure keeps the profile and shows the read error | R4 |
| A5 | Without the DirectML provider, the GPU profile shows unavailable with the reason and "Install (N MB)" | R12, R17 |
| A6 | Qualification failure (forced slow call) leaves the previous profile active and names the step | R19, R20 |
| A7 | On the RX 6600 XT: speakers on DirectML, every call ≤ 50 ms, 5 recordings within R19 tolerance | R26–R28 |
| A8 | While a 90-minute recording is processed under the GPU profile, the desktop stays responsive (UI input latency p95 < 100 ms, measured) | R22–R24, C1 |
| A9 | Light profile on a VM with 8 GB RAM and 4 cores: a 60-minute recording completes with HiDock's resident memory ≤ 1.5 GB | G1, R15 |
| A10 | Backup of the reference library ≤ 200 MB and no write when nothing changed for 24 h | R31–R33 |
| A11 | Fresh install, restore from the backup file: recordings, transcripts, speakers and edits match row counts in the manifest; embeddings rebuild in the background | R37 |
| A12 | After A11 passes: scheduled task gone, script removed, 81 GB of old copies deleted, F: free space up by that amount | R39 |
