# FREEZE.md — device file-list freeze diagnosis and fix

Branch: fix/device-list-freeze (worktree .claude/worktrees/device-freeze)
Symptom (owner, 27-sep-2026): app freezes while downloading the file list from the
HiDock device over USB, before any audio download. Library shows 2,139 sources.

Constraints for this session: no npm install/ci, no builds, no test runs (deps not
installed in this worktree). Work by reading code. No GPU. No destructive git.

## Plan

1. Trace the device file-list path end to end:
   - USB/jensen protocol list command (packages/jensen-protocol)
   - main-process services (apps/electron/electron/main/services/*jensen*, *device*,
     download-service.ts, reconcile/sync code)
   - DB writes per file (upserts, synced_files, recordings)
   - IPC to renderer (per-file events, full-list pushes)
   - renderer handling (stores, Library, useUnifiedRecordings)
   Identify synchronous work on the main or renderer thread that scales with file
   count. Record file:line and estimated cost at 2,139 files.
2. Fix the boring way: one transaction for the batch of DB writes, batched and
   throttled IPC (summary event instead of per-file), setImmediate yields between
   chunks in long loops, renderer updates coalesced. Behaviour identical otherwise.
   Follow existing patterns (backfillTranscriptIntegrity: batches of 100 with
   setImmediate).
3. Unit tests (vitest, existing style) for batching/transaction/throttling. Cannot
   run them here; make them correct by reading existing tests. List exact test files
   to run.

## Findings

Path traced (device file list, 2,139 files):

1. USB read: `JensenDevice.listFiles` (packages/jensen-protocol/src/jensen-device.ts:2140)
   already parses incrementally (tail buffer + only-new-bytes per packet, "Fix 3").
   Packets are large, so the parse loop is fine. Not a cause.
2. IPC: `jensen:listFiles` (apps/electron/electron/main/ipc/jensen-handlers.ts:418)
   sends one `jensen:scan-progress` event per packet (a few dozen total — fine)
   and returns the full list once as the invoke result (2,139 small objects —
   a few ms of structured clone). Not a cause.
3. Renderer scan wrapper: `HiDockDeviceService.listRecordings`
   (apps/electron/src/services/hidock-device.ts:1009) maps FileInfo[] once and
   caches it. Not a cause.
4. Renderer then hands the whole list to main for reconciliation:
   - `device-sync-actions.ts:184` and `useDeviceSubscriptions.ts:166` call
     `window.electronAPI.downloadService.getFilesToSync(recordings.map(...))`
   - handler `download-service:get-files-to-sync`
     (apps/electron/electron/main/services/download-service.ts:1594) runs
     `service.getFilesToSync(files)` SYNCHRONOUSLY on the Electron main thread.

### Root causes (main thread, scale with file count)

F1. `DownloadService.getFilesToSync` (download-service.ts:497-612) — the freeze.
    One synchronous loop over all 2,139 files on the main thread. Per file:
    - 4 x `isFilePurged` SELECTs (download-service.ts:510-516)
      => 8,556 queries per reconcile.
    - `isFileAlreadySynced` (download-service.ts:439-492): 1-3 `getSyncedFile`
      SELECTs (:407,:445,:451,:457), 1-4 synchronous `existsSync` stats on the
      recordings drive (:409,:416,:464,:475,:484) — the comment at :411-415 says
      recordings live on an external drive, so each stat can cost 1-10 ms
      => up to ~8,500 stats = 8-85 s of blocked main thread.
    - `getRecordingByFilename` (:533) + `upsertRecordingFromDevice` (:534,
      database.ts:6156-6193): SELECT + UPDATE/INSERT + SELECT-by-id per file,
      every write its own auto-commit (~2,139 commits).
    - per NEW unsynced file: `createProcessingRun` + `completeProcessingRun`
      (:537-551) and `enrichRecordingScheduleMetadata` (:562,
      database.ts:12654+): candidate-meeting query, scoring, a candidate DELETE,
      a SELECT+INSERT per candidate, recording UPDATEs — dozens of statements
      per file.
    Total: ~20k+ SQLite statements, thousands of individual WAL commits,
    thousands of sync fs stats, all inside one IPC handler. Electron's main
    thread is blocked for the whole reconcile => every window freezes. This is
    the reported freeze, and it can fire 2-3 times per connect (auto-sync on
    'ready', scanAndReconcile, manual refresh).

F2. `deviceCache:saveAll` (apps/electron/electron/main/ipc/device-cache-handlers.ts:30-62):
    DELETE + 2,139 INSERTs, each statement its own auto-commit, after every scan
    (called from useUnifiedRecordings Phase 3, useUnifiedRecordings.ts:746).
    ~2,140 commits, hundreds of ms on the main thread.

F3. `saveDeviceFilesCache` (database.ts:7876-7897): same DELETE + N auto-committed
    INSERTs pattern (table device_files_cache; no live caller found in main —
    fixed anyway, one wrapper).

### Checked and cleared

- Renderer IPC volume: scan-progress is per-packet, not per-file; `recording:new`
  is already coalesced into one event per snapshot (download-service.ts:589-601);
  the Library rebuild is triggered once via `hidock:downloads-completed`
  (device-sync-actions.ts:231).
- `buildRecordingMap` (useUnifiedRecordings.ts:190) is O(N) via maps. The
  `findMatchByDateTime` fallback (:144) is O(N*M) but only runs for files with
  no exact filename match (normally zero). Not changed.
- `DevicePipelineService.scanFiles` (device-pipeline.ts:365-378) emits
  `[...streamedFiles]` (full-array copy) per packet — O(N^2) — but the service
  is NOT wired into index.ts (grep: no registration). Latent, not changed.

## Changes

(to be filled during step 2)

## Tests added

(to be filled during step 3)

## How to verify

(to be filled at the end)
