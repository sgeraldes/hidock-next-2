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

(to be filled during step 1)

## Changes

(to be filled during step 2)

## Tests added

(to be filled during step 3)

## How to verify

(to be filled at the end)
