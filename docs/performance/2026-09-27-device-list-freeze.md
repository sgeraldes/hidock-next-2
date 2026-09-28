# Device file-list freeze (27-sep-2026)

Symptom: the whole window froze while the app read the HiDock's recordings list,
before any audio download. Library at the time: 2,139 sources.

## Root cause

Everything below ran synchronously on the Electron main thread, so every window
stopped painting until it finished.

| Where | Work per connect at 2,139 files |
| --- | --- |
| `DownloadService.getFilesToSync` (`download-service.ts`) | 4 purge-tombstone SELECTs per file (about 8,500), one to three `synced_files` SELECTs and up to four `existsSync` stats on the recordings drive per file, and an upsert per file, each its own WAL commit. New files also ran calendar enrichment. About 20,000 statements and thousands of commits in one IPC handler, two or three times per connect. |
| `deviceCache:saveAll` (`device-cache-handlers.ts`) | DELETE plus 2,139 INSERTs, each auto-committed, after every scan. |
| `saveDeviceFilesCache` (`database.ts`) | Same DELETE plus per-row INSERT pattern. |
| `DevicePipelineService.scanFiles` (`device-pipeline.ts`) | Copied and broadcast the whole growing list on every USB packet. The service is registered but no screen drives it yet. |

## Fix

- The reconcile runs in chunks of 100 files, one transaction per chunk, with a
  `setImmediate` yield between chunks (same pattern as
  `backfillTranscriptIntegrity`). The IPC handler awaits the batched variant.
- Purge tombstones load once per reconcile into a Set.
- Both device-cache writes run in one transaction.
- The pipeline publishes the first streamed packet at once, then at most every
  250 ms; the full list is still emitted when the scan returns.

Expected effect: commits drop from thousands to about 22 per reconcile, purge
lookups from about 8,500 to 1, and the main thread is never blocked for more
than one 100-file chunk.

## Tests

- `electron/main/services/__tests__/download-service-reconcile-batch.test.ts`
- `electron/main/ipc/__tests__/device-cache-handlers.test.ts`
- `electron/main/services/__tests__/device-files-cache.test.ts`
- `electron/main/services/__tests__/device-pipeline.test.ts` (streaming throttle)

## Pausing the pipeline

The same change adds one control for the whole pipeline. "Pause" in the Library
header (and in the Operations overlay) stops new downloads and new
transcriptions; the item in flight finishes. Both queues keep their own flag in
the main process (`DownloadService.state.isPaused`, the transcription
processor's `queuePaused`), and `src/services/processing-pause.ts` flips both.
The pause lives in memory: restarting the app resumes processing.

## Operations history

Operations and the titlebar bell show the latest attempt per recording, and only
this app session's failures count in their badges. Failures from earlier
sessions (download rows reloaded at boot, transcription rows stamped before the
process started) sit in a collapsed "Earlier failures (N)" group with one Clear
button. Rows are named by the recording's display title, never the device file
name.
