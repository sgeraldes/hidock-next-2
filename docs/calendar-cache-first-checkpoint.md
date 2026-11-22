# Calendar cache-first: implemented, active, and verified

Updated 2026-10-06, 23:43 UTC. Calendar behavior was checked in the real local
development app, beyond compilation and fixtures. The cause of other intermittent
freezes remains unconfirmed.

## Runtime and scope

The change is integrated into G:\Code\hidock-next-2, based on main HEAD 9214358.
Existing modifications were preserved; the shared database.ts change used a
different hunk. The final Electron process is PID 13192, using the original
hidock-universal-knowledge-hub profile and the rebuilt apps/electron/out files.
The executable is the repository's Electron development binary, not an installed
installer/package. No installer was produced or replaced.

The backend retains --backend-only --no-schema-work. No unattended transcription,
backfill, schema work or queue repair was enabled. The UI is attached and visible;
Microsoft 365 was resumed silently with existing credentials. No new sign-in,
OAuth scopes, app registration, calendar permissions, external event writes,
infrastructure or Internet exposure was introduced. The temporary main-process
diagnostic listener bound only 127.0.0.1 and was closed after verification.

## Causes and changes

The refresh button previously deleted all saved meetings before fetching remotely.
An unbounded Layout read also transferred every meeting before Calendar requested
its visible range. Graph ingestion scanned the full meeting table for recurrence
remapping despite stable, account-scoped IDs and processed large batches without
enough opportunities for other IPC to run.

During live activation, an additional backend-specific delay was found: backend
mode starts no boot scheduler, while the calendar waited up to 45 seconds for that
absent drain. Backend calendar requests now skip that wait. Desktop boot gating
continues to apply, with two regression tests covering the backend exception.

The renderer now reads the visible local-day, week, workweek or month range,
including month edge cells and midnight overlaps. Compatible reads join; a refresh
bypasses an old read, and responses from older range requests cannot replace newer
data. Existing events remain displayed through refresh, slow reads and errors.
The last successful sync remains visible beside the refresh state or error.

Manual refresh and the compatibility clear-and-sync IPC preserve saved meetings.
Successful ICS passes retire missing events only inside the sync window, while
retaining historical rows and their foreign-key links. Failed fetch/parse leaves
the snapshot intact. ICS requests with differing URLs serialize.

Graph ingestion yields between batches of 20 and skips recurrence remapping for
batches containing only stable M365 IDs. Deletion/cancellation applies to the exact
account-scoped ID, retaining history; recreation restores visibility. A failed
persistence step prevents advancing the delta cursor. Compatible syncs join, while
differing requests serialize per account. Repeated sync does not create duplicate
IDs. This does not establish semantic deduplication between two separately enabled
feeds that happen to describe the same appointment.

## Measurements and observed UI

Initial read-only native SQLite measurements on the live database:

| Scope | Rows | Query | JSON encoding | Payload |
| --- | ---: | ---: | ---: | ---: |
| All saved meetings | 6,661 | 28.38 ms | 17.17 ms | 11,956,382 bytes |
| Visible week overlap | 137 | 2.55 ms | 0.55 ms | 282,022 bytes |

The latter is approximately 97.6% smaller. It is a query/payload comparison,
not a before/after full application startup benchmark. Later real renderer IPC,
after remote updates, returned 143 rows, 292,898 bytes in 28 ms, with no repeated IDs.

Real UI/API evidence in the task workspace:

- real-calendar-results.json: two actual Refresh calendar button passes against
  outlook.office365.com. Each took about 15–16 seconds, advanced the persisted
  freshness timestamp and retained at least 128 event buttons, with saved freshness
  visible throughout. No refresh error remained.
- native-outlook-results.json: two real Graph calendar-only delta reads, 437 ms
  and 258 ms, retained 128 events and completed connected. An earlier real Graph
  pass ingested 322 events; subsequent reads reported no changes. Contacts were
  not pulled, and no interactive authentication was requested.
- renderer-reopen-results.json: the real renderer was reloaded using the same
  persisted cache. DOM readiness took 52 ms, then saved events appeared in 823 ms
  while the real background sync was still active, with freshness visible and no
  empty loading screen. All 128 events remained after sync. Warm navigation measured
  inside the renderer took 685 ms. Separate agent round-trip measurements involving
  Today navigation took 4.5–5.7 seconds and include main-process/Today work; they
  should not be presented as the calendar's DOM appearance time.
- Real calendar screenshots were captured and their pixels inspected, including
  saved events and freshness while startup refresh was active. The user's workweek,
  hide-empty and calendar/list preferences were restored after the tests.

One quiet final main-process sample used 0 CPU seconds over 1.224 seconds and
187 MiB working memory, compared with an earlier busy old-process sample using
1.281 CPU seconds over 1.2 seconds and about 2.45 GiB. Those different workloads
and a fresh process prevent attributing the difference solely to this fix.
Five final authenticated local health reads returned 200 in 4, 1, 1, 1 and 1 ms.

## Automated and fixture verification

- Focused actual-checkout application suite: 13 files, 262 tests passed before
  adding the backend exception. Its two affected files then passed 66 tests,
  including two new regressions: 264 unique selected application tests overall.
- Actual connector host: registry 12 tests and account instances 9 tests passed.
- TypeScript node/web, ESLint for changed application and connector files,
  connector ESM/CJS/types build, and Electron main/preload/renderer build passed.
- Existing Vite warnings about mixed static/dynamic pipeline imports remain.
- Isolated actual-Calendar/Electron/SQLite fixture: six scenarios passed, with
  inspected screenshots. Covers cold empty cache, cached startup with a 2.5-second
  remote wait, offline failure preserving events/freshness, repeated refresh with
  deletion/update, persistent renderer reopening, and warm mounting with slow IPC.
  Saved fixture events appeared at 39 ms and warm cached mounting at 7 ms; these
  are fixture observations, not timings of the user's full app.
- Real Outlook success and startup/reopening were observed. Slow/error/offline,
  deletion/recreation, request races and account separation used fixtures; production
  credentials or connectivity were not changed to inject those failures.

The two original Library PNG references could not be materialized by the Windows
helper because os.setxattr was unavailable. Their original files were not inspected
and are not claimed as evidence. The inline user screenshot and newly captured
local UI pixels were available.

## Hardware versus software recording: retain this distinction

HiDock records autonomously in its hardware. Restarting or disconnecting the app's
USB client does not stop that autonomous recording. device.isRecording is
informational and must not automatically veto a software restart.

Protect operations that actually belong to the software process: PC/loopback
capture, live streaming into a local file, a download/transfer or database write,
and active processing jobs. On quit, index.ts closes local live files, stops the PC
recorder and disconnects USB; it does not issue a stop-autonomous-recording command.
See ipc/jensen-handlers.ts finishLiveRecording and jensen:disconnect,
ipc/pc-recorder-handlers.ts stopPcRecorderBeforeQuit, and index.ts quit cleanup.

Activation used the authenticated graceful stop endpoint, which refuses active
processing work. No process was force-killed. The old residual transcription row
from the previous day remains processing at 28%, attempt 1, while the runtime
processor is idle with zero pending work. Its row and processing-run records
compare exactly equal before and after. It was not cancelled, retried, repaired,
requeued or advanced.

## Deliverables and recovery

Changed application paths include the store, Calendar page/header, calendar-range,
calendar/database IPC, calendar-cache/calendar-sync/database services, connector
ingestion and M365 parsing, plus corresponding regression tests. Shared host changes
are in packages/connectors/src/registry.ts and its tests.

The task workspace contains calendar-cache-first.patch and calendar-recovery:
a manifest with guarded source hashes, original affected sources, old electron/out
and old connectors/dist. Rollback must reverse only this patch after a check or
restore guarded copies; do not reset/stash the checkout, restore the live database,
or overwrite concurrent changes. No commit or PR was created.

final-verification.json records the actual loaded build module hashes, process,
mode, UI visibility, connected Outlook state, restored preferences, closed
diagnostic listener, unchanged residual queue/runs and authenticated health checks.

The development app already runs the change; no further install is needed for
that instance. An independently installed/package build will need rebuilding and
installation separately. Other intermittent freezes have not been established as
resolved and require attribution if they recur.
