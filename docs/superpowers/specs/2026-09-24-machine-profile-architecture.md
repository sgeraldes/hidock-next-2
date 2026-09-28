# Design: Machine profile, execution profiles and in-app backup

- Date: 24-sep-2026
- Implements: `docs/superpowers/specs/2026-09-24-machine-profile-design.md` (the SPEC; R and A numbers refer to it)
- Plan: `docs/superpowers/plans/2026-09-24-machine-profile.md`

## 1. Where it lives

Everything runs in the Electron main process or in utility processes it owns. There is no
Python in the new paths. All new modules go in `apps/electron/electron/main/services/machine/`.

```
machine/
  inventory.ts        read hardware from the OS (R1, R4)
  signature.ts        canonical JSON + SHA-256 (R2)
  enablers.ts         per-runtime enabler checks, file/version only (R10, R11)
  enabler-install.ts  download + checksum + unpack into app data (R12)
  measure.ts          CPU/GPU/storage timing, run in a utility process (R6-R9)
  profiles.ts         profile table, availability, proposal (R15-R17)
  qualify.ts          qualification run against the bundled sample (R19-R21)
  machine-state.ts    stored state, startup check, change detection, notice (R3, R13, R14)
  job-gate.ts         one heavy job at a time, priority, CPU cap, GPU call budget (R22-R25)
backup/
  backup-plan.ts      which tables go in, change detection, retention (R31, R33, R34)
  backup-writer.ts    snapshot, compress, manifest (R32)
  backup-restore.ts   verify + import + queue re-embed (R37)
  backup-scheduler.ts idle trigger (R33)
speakers-onnx/
  features.ts         fbank front end on CPU (R27)
  onnx-diarizer.ts    segmentation + embedder through onnxruntime-node (R26)
```

`hardware-profile.ts` and `speaker-setup.ts` stay as thin adapters over `machine/` during the
migration, then keep only the speaker-engine ordering.

## 2. Data model

State lives in the existing config (`config.ts`, `getConfig`/`updateConfig`), under a new
`machine` section. No new database tables.

```ts
interface MachineConfig {
  signature: string | null              // R2
  inventory: Inventory | null           // last good read
  enablerState: EnablerState | null     // R11
  enablerStateHash: string | null
  measurement: Measurement | null       // R9, includes signature it belongs to
  profile: ProfileId                    // active profile, default 'light'
  custom: Partial<Record<JobId, RuntimeId>>
  qualification: QualificationResult | null  // with signature + enablerStateHash
  dismissedChange: string | null        // `${signature}|${enablerStateHash}` (R14)
}
type ProfileId = 'light' | 'balanced' | 'gpu' | 'remote' | 'custom'
type RuntimeId = 'cpu' | 'directml' | 'cuda' | 'cloud' | 'remote'
type JobId = 'transcription' | 'speakers' | 'voiceId' | 'embeddings' | 'analysis'
```

Backups add `backup: { folder, capMb, lastAt, lastFile, lastSize, lastDataVersion }` to config.

## 3. Startup flow

```
app ready
  -> window paints (no machine work before this)
  -> utility: readInventory()           <1 s, off main thread (R5)
  -> readEnablerState()                 file/version/checksum only (R11)
  -> compare with stored signature + enablerStateHash
       equal          -> done, log "machine unchanged" (R3, A1)
       read failed    -> keep profile, flag error in Settings (R4)
       different      -> wait for no running job (R7)
                         -> measure() in utility process
                         -> requalify active profile (R13.1)
                              pass -> keep
                              fail -> fall back to best qualified, else light
                         -> propose(measurement, enablers)
                         -> notice unless dismissed for this pair (R13.2, R14)
```

## 4. Inventory

Windows, one PowerShell call, JSON out, 8-second timeout. This replaces today's
`Win32_VideoController` query:

- `Win32_Processor`: Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed
- `Win32_ComputerSystem`: TotalPhysicalMemory
- `Win32_VideoController`: Name, AdapterCompatibility, DriverVersion, AdapterRAM. AdapterRAM
  caps at 4 GB, so dedicated VRAM comes from the registry key
  `HKLM\SYSTEM\ControlSet001\Control\Class\{4d36e968-...}\*\HardwareInformation.qwMemorySize`
- `Get-PhysicalDisk` joined with `Get-Partition -DriveLetter <library drive>`: MediaType, BusType, Size.
  A Storage Spaces or striped volume reports its virtual disk. The design stores what the
  first physical disk reports, and records `striped: true` when there is more than one.

The display flag: a GPU drives a display when `Win32_VideoController.CurrentHorizontalResolution`
is non-null for it (Windows fills it only for adapters with an active output). If the value is
missing or the query fails, every GPU counts as a display GPU, the safe side of C1.

The existing `NOT_A_GPU` filter and `vendorOf` move to `inventory.ts` unchanged.

## 5. Signature

```ts
canonical = {
  cpu: `${model}|${logical}`,
  ramGb: Math.round(totalBytes / 2**30 / 4) * 4,
  gpus: gpus.map(g => `${g.vendor}:${g.model}:${Math.round(g.vramBytes / 2**30)}`).sort(),
  library: `${mediaType}:${busType}:${Math.round(sizeBytes / 1e11)}`,
}
signature = sha256(JSON.stringify(canonical))
```

The change description (R13.2) is a diff of two canonical objects, field by field, so the
notice can say "RAM: 32 → 64 GB" without storing anything extra.

## 6. Enablers

`enablers.ts` returns, per runtime, `{ present: boolean; items: EnablerItem[] }` where each item is
`{ id, required, found, version?, installable, sizeMb?, fix? }`. The checks:

| Runtime | Check without loading |
|---|---|
| cpu | `onnxruntime-node` package resolves; model files exist and match the SHA-256 in `models.lock.json` |
| directml | `os.release()` ≥ 10.0.18362; `onnxruntime-node` binary folder contains `DirectML.dll`; adapter has DX12 (from inventory feature level); model files |
| cuda | `nvidia-smi --query-gpu=driver_version`; CUDA/cuDNN DLLs present in the app's `runtimes/cuda` folder at pinned versions |
| cloud | key present in config; `lastCloudCheckAt` < 24 h |
| remote | pairing present; last health result < 24 h |

The enabler state hash is SHA-256 over the sorted `id@version|found` list.

"Loads and creates a session" (R10) belongs to qualification, not to the startup check.

### Installing (R12)

`models.lock.json` in `resources/` lists every downloadable item: `id`, `url` (official source
only: Hugging Face model repos, the ONNX Runtime GitHub releases, NVIDIA redistributables),
`sha256`, `sizeMb`, `dest` relative to `<app data>/runtimes` or `<app data>/models`.

The installer downloads to `<dest>.part`, streams SHA-256, renames on match, and on mismatch
deletes `<dest>.part` by literal path. A crash leaves a `.part` file, which startup removes by
literal path when it is older than 1 hour.

`onnxruntime-node` 1.24.3's Windows x64 build ships the DirectML execution provider (`dml`). The
first task of the AMD work verifies this on the reference machine. If it is missing, the plan
switches to the `onnxruntime-node` build that includes it, in that same task.

## 7. Measurement (utility process)

- CPU: single-thread score is iterations of a fixed float loop in 1 s. All-core score runs the same loop
  on N workers where N = floor(logical / 2).
- GPU: for each runtime with enablers present, it creates a session for the probe model
  `probe-conv.onnx` (bundled, ~200 KB, a few conv layers), then records the load time and the median
  of 20 batch-1 calls.
- Storage: it writes 256 MB in 4 MB blocks with `fsync`, reads the file back, and deletes it by literal path.
  The temp file name is fixed (`<library>/.hidock-disk-probe.tmp`) so a crash can be cleaned up by name
  (R8).
- The process starts with `priority: below normal` (Windows `SetPriorityClass` via
  `os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`) and at most half the cores.

## 8. Profiles and proposal

`profiles.ts` holds the table in SPEC R15 as data:

```ts
const PROFILES: Record<Exclude<ProfileId,'custom'>, Record<JobId, RuntimeChoice>> = {
  light:    { transcription: 'cloud', speakers: 'cloud', voiceId: 'cloud', embeddings: 'cloud-or-small-cpu', analysis: 'cloud' },
  balanced: { transcription: 'cloud', speakers: 'cpu',   voiceId: 'cpu',   embeddings: 'small-cpu',          analysis: 'cloud' },
  gpu:      { transcription: 'cloud', speakers: 'best-gpu', voiceId: 'best-gpu', embeddings: 'best-gpu',    analysis: 'cloud' },
  remote:   { transcription: 'remote', speakers: 'remote', voiceId: 'remote', embeddings: 'remote',       analysis: 'cloud' },
}
```

`best-gpu` resolves to `cuda` if its enablers are present, then `directml`. Availability for a profile
is the conjunction of its resolved runtimes' enablers plus a hardware check:
- balanced needs RAM ≥ 16 GB;
- gpu needs a GPU for the runtime.

`propose()` implements R16. The Balanced CPU threshold is an all-core score equal to 60% of the
reference workstation's. The plan records the measured reference number in `profiles.ts` in
Task 6.

## 9. Qualification

The bundled sample is `resources/qualification/sample-2spk-30s.wav`: 30 s, 16 kHz mono, two
speakers, CC0. The reference outputs sit next to it:
- `sample.rttm`: speaker turns;
- `sample-embeddings.f32`: the CPU embedder output for 5 fixed windows;
- `sample-text-embedding.f32`: the text embedder output for 3 fixed sentences.

`qualify(profileId)` runs each local job on its runtime through the same code the jobs use, with
`job-gate` enforcing the 50 ms budget and reporting every call time. It returns
`{ passed, steps: [{ job, runtime, step, value, limit, passed }] }`.

## 10. Job gate

The single entry point for heavy local work:

```ts
runHeavyJob<T>(job: JobId, fn: (ctx: JobContext) => Promise<T>): Promise<T>
```

- A FIFO queue with one slot (R22).
- `ctx.runtime` is the runtime the active profile assigns to `job` (R25).
- `ctx.callBudgetMs` is 50 when the runtime is a GPU that drives a display, and unlimited otherwise.
- `ctx.recordCall(ms)`: after two calls over the budget, it sets `ctx.degradedToCpu = true`. The job's code
  switches its session to CPU for the rest of the run (R24).
- Thread cap: `intraOpNumThreads = max(1, floor(logical * cpuPercent / 100))`. This reuses the
  existing `cpuPercent` config.

Existing heavy entry points move behind the gate:
- speaker linking (`speaker-linking.ts`);
- the local embedder (`local-embedder-runtime.ts`);
- diarization in `transcription.ts`.

## 11. AMD speaker path

The pyannote 3.1 pipeline, reimplemented in Node:
1. `features.ts`: 16 kHz mono → the segmentation model's input takes raw waveform windows of 10 s
   (the segmentation model has no fbank). The WeSpeaker embedder takes 80-bin fbank features,
   computed on the CPU in TypeScript (25 ms window, 10 ms hop, Kaldi-compatible). This removes
   the framing Conv that DirectML rejected on branch `feat/short-lane-and-onnx`.
2. Segmentation: 10 s windows with a 1 s step, batch sized so one call is ≤ 50 ms on the measured GPU.
3. Embeddings per (window, local speaker), masked. Batch sized the same way.
4. Clustering: agglomerative clustering with the pyannote 3.1 threshold (0.7045654963945799, centroid
   linkage) in TypeScript. This produces the same output shape the speaker-linking code consumes
   today (`segments`, `voices`, per-voice embedding).
5. Exported graphs: `segmentation-3.0.onnx` as already exported, and
   `wespeaker-resnet34-lm-fbank.onnx`, re-exported to start at fbank features, with dynamic batch.
   Both are listed in `models.lock.json` with checksums.

Reference comparison (R28) uses 5 library recordings chosen by the plan (one short, one 90+ min,
three between). The CPU pyannote output is stored as fixtures outside the repo, on the dev
machine only. The test is a dev script and does not run in CI.

## 12. Backup

### What goes in (R31)

The backup copies every table except those on an exclude list kept in `backup-plan.ts`:
`vector_embeddings`, the FTS and index tables, `*_cache` tables, and derived scores that the
pipeline recomputes. The plan lists them from the schema in Task 12. A new table is included by
default, so forgetting to classify one errs on the safe side. Measured on the reference library,
the result is about 150 MB before compression.

### How it is written (R32)

1. `VACUUM INTO '<app data>/backups/.staging.db'`. This takes a consistent snapshot with no lock held on the live database.
2. The job opens the staging copy, drops the excluded tables, and runs `VACUUM`.
3. It writes the file with the manifest as a JSON header, followed by the staging database compressed with zstd
   (Node `zlib` brotli if zstd is unavailable in the shipped Node).
4. It writes `hidock-backup-<stamp>.hdbk.part`, fsyncs it, renames it to the final name, and deletes the staging file by
   literal path.

### When (R33)

`dataVersion` is the sum of `PRAGMA data_version` changes observed by the app plus the max
`updated_at`/`created_at` over the included tables, stored after each backup. The scheduler checks
every 15 minutes. It runs when the app has been idle for 10 minutes, no heavy job is running, the last backup is ≥ 24 h old, and
`dataVersion` differs from the stored value.

### Retention (R34)

After a successful backup, the app lists the folder, keeps the 3 files defined in R34, and deletes the rest by literal
path. It also deletes more files while the total size is over the cap, but never the newest one.

### Restore (R37)

1. The app reads the manifest and checks the checksum and the schema version. A newer schema than the app is refused
   with "Update HiDock first."
2. It decompresses the file to staging and runs migrations on the staging copy.
3. It swaps the live database with the staging copy (the app restarts), then queues a re-embed of all
   transcripts behind the job gate.

### Pre-migration copy (R38)

This replaces `backupOnBoot` and `externalBackups` in `packages/database/src/engine.ts`. The engine takes
one `VACUUM INTO` copy before migrations and keeps it until the next successful start.

## 13. UI

Settings gets a new section, "Esta computadora / This computer", with:
- the inventory summary and the last measurement;
- the profile selector: available profiles as radio buttons, unavailable ones greyed out with the reason and the fix button;
- the qualification result per step;
- per job, the runtime used on the last run and its speed (R18);
- "Measure again".

The change notice (R13) is a non-blocking banner, not a modal.

The Backup section shows the last backup, the folder picker, the size cap, "Back up now" and
"Restore…". The first-launch restore offer is a step in the existing onboarding.

## 14. Risks

| Risk | Mitigation |
|---|---|
| DirectML provider missing from the `onnxruntime-node` 1.24.3 build | Verified in Task 9 step 1; switch build in the same task |
| WeSpeaker fbank graph differs from pyannote's internal fbank | Reference test R28 on 5 recordings; tolerance defined in R19 |
| VRAM from registry missing on some drivers | Signature uses 0 GB and says so in Settings |
| Display-GPU detection wrong | Default is "drives a display" (the safe side) |
| Restore across schema versions | Migrations run on staging before the swap |

## 15. Decisions taken here

- No Python in new paths. The Python venv is unusable for a normal user because it lives at `process.cwd()`.
- Config holds the state, with no new tables. This keeps backup and restore simple.
- The 50 ms budget is enforced in the gate, not trusted to each job.
- A GPU that does not drive a display is preferred for heavy work. The reference machine has one:
  the Ryzen 7900X3D's integrated "AMD Radeon(TM) Graphics" drives no monitor, while the RX 6600 XT
  drives the screen. If the iGPU passes qualification, jobs run there and the display GPU is never
  loaded. The RX 6600 XT is used only if it meets the 50 ms budget and the iGPU does not qualify.
- Backups are excluded by table, not included by table, so new tables are safe by default.
