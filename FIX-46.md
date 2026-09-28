# FIX-46 plan

Branch `fix/library-file-name-and-purge`, PR https://github.com/sgeraldes/hidock-next-2/pull/46.

Product rule (owner, 25-sep-2026): a RECORDING's file name is never shown to the user anywhere
except the reader's Metadata section (SourceReader.tsx, the 'Filename' field). Use getDisplayTitle
or, for database Recording rows, their title or a neutral label with the date. Imported
documents/images/notes may keep their file name. Search may still match file names. The device
view is exempt.

## Steps

1. `electron/main/services/database.ts` clearPurgeTombstones: delete all name variants atomically
   (single `DELETE FROM purged_files WHERE filename IN (?, ?, ?, ?)` or runInTransaction); errors
   throw, no swallowing. In `electron/main/services/download-service.ts`, where it is called after
   a completed download, a thrown error must fail the download result with a clear message instead
   of reporting the restore as done. Add an injected-failure test in the existing style.
2. Remove recording file names from user-visible UI:
   - `src/pages/Calendar.tsx` (grid/checkbox aria-labels ~905, ~1046; compact row ~1068-1071)
   - `src/components/calendar/CalendarTooltips.tsx` ('File:' line ~73-77)
   - `src/pages/MeetingDetail.tsx` (recording list ~893-899)
   - `src/features/library/components/SourceDetailDrawer.tsx` header fallback ~131-135
     (use getDisplayTitle)
   - grep `apps/electron/src` for other user-visible renders of a recording's `.filename`
     (JSX text, aria-label, title= tooltips), fix except device view and SourceReader Metadata.
   - Update tests that looked rows up by file-name text to use titles or data-testid.
3. `docs/superpowers/specs/2026-09-22-unassigned-recording-titles-design.md`: at the sections that
   prescribe filename fallback, row tooltips, the Settings preference and their tests (~65-109,
   ~135-164) add a short note that they are superseded by the 25-sep decision. Do not rewrite
   history.
4. From apps/electron: `npm run typecheck` passes; `npx eslint <each changed file>` clean. Run the
   touched test files plus `src/features/library` and `src/pages/__tests__/Library.trash.test.tsx`
   with `--maxWorkers=2`.

## Log

- Plan written. Starting step 1.
- Step 1 done: `database.ts` clearPurgeTombstones is now one atomic
  `DELETE ... WHERE filename IN (...)`; errors throw. `download-service.ts` wraps the call and
  rethrows as `Failed to restore purged recording <name>: <reason>`, so the outer catch marks the
  download failed instead of reporting a restore that did not happen. Tests: injected-failure via a
  BEFORE DELETE trigger in `database.test.ts` (throws, nothing removed); injected mock failure in
  `download-service-session-c5.test.ts` (result fails, item failed, no recordings row).
  `npx vitest run database.test.ts download-service-session-c5.test.ts download-service-cancel.test.ts
  download-service-c004.test.ts --maxWorkers=2` → 4 files, 107 tests, all pass.
