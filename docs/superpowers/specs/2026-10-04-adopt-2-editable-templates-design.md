# Editable output templates and pipeline prompts

Date: 4 October 2026. Status: proposed design; documents only.

## Problem

`apps/electron/electron/main/services/output-templates.ts:4` calls its templates hardcoded.
The five entries start at lines 13, 44, 78, 108 and 123.
`output-templates.ts:183` exposes template listing and line 190 exposes lookup.
Editing a prompt currently requires changing a compiled service.
Meeting minutes use `{meeting_subject}`, `{meeting_date}`, `{attendees}`,
`{speaker_map}` and `{transcript}` (`output-templates.ts:16`).
Project status uses `{project_name}` and `{transcripts}` at lines 82 and 101.
Each template therefore has its own substitution contract.

`apps/electron/electron/main/services/pipeline/runner.ts:34` accepts caller messages.
The runner selects a plan and provider; it does not own all prompt text.
`pipeline/runner.ts:13` documents the gate before every provider attempt.
Treating the pipeline directory as a catalog of editable prompts would miss caller-owned text.
The exact caller-to-step inventory is to verify in the implementation PR.
`apps/electron/electron/main/services/config.ts:491` places config in the app profile.
Use that profile boundary for overrides without changing application installation files.

## What the open-source project does

Laya's `engine/laya/llm/prompts/overrides.py` maps known keys to Markdown filenames.
It reads UTF-8 files from `~/.laya/prompts` and ignores unknown names.
Missing, empty or unreadable overrides leave module defaults available.
The reload operation clears and repopulates its cached map.
Take a small allowlisted file registry, cached reads and explicit reload.
Add debounced filesystem watching for HiDock hot reload.
Use atomic snapshots so a partially saved file cannot change an in-flight call.
Keep substitution schemas and provider gates outside editable prose.
No scripting runtime or plugin installation is required.

Laya is Apache-2.0, Copyright 2026 Aayush Chawla (`LICENSE`, `NOTICE`).
Copied or adapted loader code must retain license, notices and modification attribution.
An independently written loader should record inspiration in its design provenance.
No upstream source or license file is added by this document-only task.

## Goals and non-goals

- Edit the five output templates through ordinary profile files.
- Edit allowlisted pipeline prompt prose without restarting Electron.
- Preserve built-in defaults and deterministic fallback on invalid files.
- Preserve source eligibility, privacy policy and structured output validation.
- Show which override revision a generated result used.
- Keep user-authored files intact when disabling the feature.
- Exclude arbitrary JavaScript, dynamic includes and executable templates.
- Exclude provider selection, tool privileges and schema editing through files.
- Exclude a rich template editor, marketplace and third-party plugin engine.
- Expand the prompt inventory only after each caller's contract is tested.

## Design

### Components and file model

Add a proposed main-process registry with built-in text and per-key contracts.
The registry and new settings below do not exist yet.
Keep defaults in `output-templates.ts` and existing prompt-owning call sites.
Expose immutable lookup snapshots through the existing template API.
Each registry entry has ID, kind, default text and revision hash.
Also record allowed placeholders, required placeholders and maximum UTF-8 bytes.
Pipeline entries identify their existing TextStepId and prompt role.
Do not invent a step ID during filesystem lookup.
First implementation PR publishes the verified step/caller allowlist in its review.

Use `<userData>\templates\<template-id>.md` for output overrides.
Use `<userData>\prompts\<registered-step-id>.md` for pipeline prose.
These are proposed directories resolved from `app.getPath('userData')`.
Their roots are fixed; filenames come from the registry, never from renderer input.
Accept UTF-8 with optional BOM, LF or CRLF; normalize line endings before hashing.
Reject blank content, invalid encoding and files over 64 KiB.
Bound the complete active override cache to 2 MiB.
Read only registered regular files; reject links that resolve outside the profile roots.
Ignore backup files, temporary editor files and nested directories.
Read metadata before and after reading; retry once when size or modification time changes.
Atomic rename saves are supported through directory watching and rescan.

### Migration and state

No database migration is required for file overrides.
Use AppConfig defaults to introduce the settings on existing profiles.
Persist settings with the existing config writer, rather than a new config format.
Do not write the effective prompt body into a database audit table.
Result provenance may add a prompt hash to existing generation metadata in a later PR.
The available result metadata field for that hash is to verify before implementation.
Until that field is chosen, expose hash and source through bounded generation diagnostics.
Never include transcript values or API keys in those diagnostics.

### Exact load and call flow

1. Resolve a registered key and return its built-in text immediately at startup.
2. After interactive readiness, asynchronously load recognized override files.
3. Parse placeholder occurrences using the entry's substitution convention.
4. Reject unknown placeholders and missing mandatory placeholders.
5. Treat literal JSON braces as text; recognize only the documented placeholder grammar.
6. Validate pipeline prose against immutable role and structured-output contracts.
7. Publish one immutable cache revision when validation finishes.
8. At generation start, capture the effective text and revision hash once.
9. Substitute caller values once; never re-expand braces found inside transcript values.
10. Keep source content in its existing data role and preserve output-schema enforcement.
11. Recheck eligibility and adoption 8 privacy before any provider attempt.
12. Record only key, hash, built-in/override source and validation state.

Hot reload uses a 300 ms debounce and rescans the recognized filename set.
One reload job runs at a time; another event sets a pending-rescan bit.
Missing or deleted files switch that entry to its built-in default.
Invalid newly saved files also switch that entry to default with a visible error.
In-flight generations retain their captured snapshot.
Other valid overrides remain active when one entry fails.
Manual Reload follows the same validation and snapshot publication path.
Watcher failure exposes a warning and leaves manual Reload available.
Watch handles close on shutdown and when overrides are disabled.

### Settings and owner experience

Add proposed `templates.fileOverridesEnabled`, initially false.
Persist it in `<userData>\config.json` (`services/config.ts:491`).
Keep the directory locations fixed and show resolved paths in Settings.
Add Open folder, Reload and Export default actions for registered entries.
Export default writes a selected file only after an explicit owner action.
If that filename exists, offer another name; never silently overwrite authored text.
Display active/default/error state, hash and placeholder contract per entry.
Avoid displaying source content or resolved prompt values in Settings.
Advanced pipeline overrides share the same toggle but have a separate allowlisted panel.
Mandatory eligibility and privacy instructions remain outside the editable fragment.

## Performance and leanness budget

Targets below require measurement; no current performance numbers were observed.

| Measure | Target | Measurement |
|---|---|---|
| Resident overhead | <=4 MiB, including <=2 MiB text cache | Main RSS/heap delta after all allowed overrides |
| Startup overhead | <=5 ms p95; no synchronous file scan | 20 flag-on/off cold and warm starts |
| Lookup latency | <=1 ms p95 | 1,000 cached lookups while Search is active |
| Hot reload visibility | <=1 second after stable save | Timestamp save event and published revision |
| Disk growth | <=2 MiB defaults exported; no automatic copies | Profile file sizes before/after owner export |
| Added event-loop delay | <=5 ms p95 | Monitor during burst saves and recording download |

Use the full 2,100-recording, 240,000-chunk library while testing responsiveness.
The loader must not read any recording or hydrate any chunk.
Measure large individual overrides and a burst of 100 saves, including rename saves.
Loading runs asynchronously at low priority after interactive readiness.
One job reads at most four files or 256 KiB before yielding with `setImmediate`.
Validation exceeding an 8 ms slice runs in a worker.
Pause rescans during foreground generation setup and active USB operations.
No directory recursion, LLM call, prompt migration or heavy job runs at startup.
Query latency target is <=2 ms added to existing Search IPC p95.

## Test plan

Write the following failing tests first.

- `template-files.default-without-directory`: all five built-ins remain usable.
- `template-files.valid-output-contract`: meeting minutes substitutes required fields.
- `template-files.unknown-placeholder`: invalid override selects default and reports error.
- `template-files.literal-json-braces`: JSON examples survive validation unchanged.
- `template-files.one-pass-substitution`: transcript braces cannot invoke another placeholder.
- `template-files.stable-snapshot`: concurrent save cannot alter an in-flight generation.
- `template-files.atomic-rename`: watcher reloads a file replaced by the editor.
- `template-files.deleted-or-empty`: built-in fallback activates without stale override text.
- `template-files.profile-boundary`: traversal and escaping links are rejected.
- `template-files.manual-reload`: watcher failure still permits explicit refresh.
- `template-files.immutable-gates`: override text cannot disable eligibility or privacy.
- `template-files.no-startup-library-read`: loader never queries or hydrates corpus content.

Use real temporary Windows profile directories and the actual filesystem watcher.
Exercise CRLF, BOM, denied reads, rename saves and oversized files through Electron.
Generate a local-model output and verify the captured prompt revision used by the call.
With a real SQLite library, confirm config changes leave recordings and vectors untouched.
Restart with invalid overrides and verify built-ins work before asynchronous loading finishes.
Compare DB schema and table counts before/after; this feature requires no migration.
Run the performance matrix with the full library open and downloading.

## Rollout

1. PR 1: failing tests, immutable registry and five output-template file contracts.
2. PR 2: asynchronous loader, watcher, manual Reload and profile boundary checks.
3. PR 3: verified pipeline prompt allowlist, immutable wrapper contracts and Settings.

Enable behind the proposed toggle for one profile first.
There is no library backfill; existing generated outputs remain unchanged.
Export defaults only for owner-selected entries.
Rollback disables file reads and watching, then returns all lookups to built-ins.
Retain authored files and config; no file deletion or schema downgrade is required.

## Risks

Placeholder grammar differs across callers; each new entry needs a specific contract test.
Edited prose can reduce model quality even when syntactically valid.
The initial pipeline prompt inventory and result hash storage are to verify.

## Decisions taken

Source: [decision matrix](../../decisions/decisions.json).

2.1 — Fall back to the built-in default for an invalid override. This makes the active text predictable and avoids retained revisions whose text differs from the file on disk.

2.2 — Fixed override folders within the profile. This reduces path validation and the risk of reading outside the profile, including symlink and file-watching cases.

2.3 — Expose pipeline prompts in phases, one caller at a time. Each caller needs its substitution contract and output validation inventoried before edited text is allowed to affect structured output.

## Order and migration

Follow the rollout dependencies above. Schema migration numbers are assigned at merge time; other branches also add migrations. Main is at v72 as of 5 October 2026, and this spec reserves no migration number.
