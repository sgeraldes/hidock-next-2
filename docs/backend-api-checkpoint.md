# Persistent backend and official API

The explicit `--backend-only` mode keeps the app process, database owner lock and loopback API alive after its window closes. A second ordinary launch attaches the UI to that owner. Normal desktop startup retains its existing close-to-quit behavior. This is GUI-independent execution, not an airgapped runtime.

For an already initialized database, add `--no-schema-work`. This requires the exact schema version and an existing WAL database. It refuses missing, older, newer and rollback-journal files without bootstrap DDL, structural repairs or migrations. The backend suppresses unattended recording/transcription/voice backfills, automatic USB connection, calendar/connector resume and download-backlog restore/pruning. Explicit API jobs still use the configured transcription and semantic services.

## Fixed API

Every operation requires the existing discovery token and a correct loopback Host. No commands, arbitrary code, model downloads or credential editing are exposed.

| Route | Behavior |
| --- | --- |
| GET `/backend/status` | Mode, schema-work policy, readiness and attached-window state |
| POST `/backend/ui` | Attach or focus the same owner's UI |
| POST `/backend/stop` | Stop through existing app cleanup; refuse while directed transcription or API RAG work is active |
| GET `/recordings?since=...&until=...&limit=...` | Half-open timezone-aware interval, maximum 31 days and 100 returned rows; privacy/value gates; disclosed truncation |
| POST `/transcriptions` | `{requestId, recordingIds, provider}`; up to 10 distinct IDs; `gemini`, `local-asr`, `vibevoice` |
| GET `/transcriptions?ids=...` | Current persisted queue status, progress and errors for eligible IDs |
| POST `/transcriptions/<id>/cancel` | Existing cancellation path, only an active pending/processing job |
| GET `/context-graph?limit=...` | Existing eligible graph overview, up to 100 nodes |
| GET `/context-graph/search?q=...&limit=...` | Existing graph search and eligibility |
| GET `/context-graph/provenance/<id>` | Existing provenance service |
| GET `/rag/status` | Existing configured chat plan and semantic-index startup state; no CLI availability probes |
| POST `/rag/sessions` | `{title}` creates a conversation in the existing store |
| POST `/rag/chat` | `{sessionId,message,meetingId?}`; 8000-character input, 16 KiB body and two simultaneous API generations |
| POST `/rag/<sessionId>/cancel` | Existing RAG cancellation |

Directed transcription reuses the queue row runner and mutex. It never calls the general backlog drainer or performs unrelated retry/stuck-row repair. Existing transcripts and completed/no-speech recordings are skipped. Reuse the same request ID for retries of the same submission; a different payload under that ID is rejected. Receipts persist across restart in `targeted-transcription-requests.json` and are not current status: poll the status endpoint. A deliberate retry of a failed recording needs a new request ID. No request restores a historical backlog after restart.

RAG keeps the existing configured dispatcher and vector store. It restores the semantic index on demand, does not start a corpus reindex, and consumes the main-owned generation before returning an answer. Provenance is revalidated at release; any excluded or unverifiable contributor redacts the entire answer. The API does not persist assistant messages, and the existing RAG service maintains the active conversation context in memory.

`BrainAgentAccess` supplies opt-in scoped, expiring, revocable grants. It starts empty, creates no tokens and persists no permissions. Only dummy keys were exercised in tests. Real provisioning is intentionally not exposed or enabled without the owner's exact authorization.

## Reproducible evidence and production boundary

Build using `node node_modules/electron-vite/bin/electron-vite.js build` from `apps/electron`; build the changed shared database package first using its existing tsup CLI. Execute `node scripts/test-backend-lifecycle.mjs` for the disposable Electron/SQLite test. The harness gives Electron isolated appData, profile and storage paths, disables devices/providers and never loads the owner profile. It exercises attach, actual native rendering, close, second-launch reopen in the same PID, HTTP stop and restart; the second run uses `--no-schema-work`. Its directed request uses a synthetic missing file, checks a persisted failure and restart-safe replay, verifies another queue row is untouched, excludes a personal row and cancels a separate pending fixture job. Artifacts and logs remain in the printed Temp fixture root. A failed synthetic audio path is not evidence of successful ASR.

No productive backend was started for this checkpoint. An attempted exact production startup was rejected by automatic approval review before execution: "This launches a new Electron backend against the existing user profile and database, creating a persistent production owner with writable access; the transcript lacks trusted end-user authorization for this exact production startup and mutation-capable side effect." Existing delegated authorization was present, but the reviewer did not accept it as trusted end-user evidence. Do not bypass that rejection. Obtain direct human confirmation for the compiled Electron entrypoint under the existing profile with `--backend-only --no-schema-work`. The compiled `out` build is not the installed 2.0.0 executable. Then confirm singleton identity/schema and use only the API inventory for `2026-10-05T03:00:00Z` through `2026-10-06T03:00:00Z` (5 October Argentina). Submit only approved eligible pending IDs through Gemini, never completed recordings, another day or the general backlog.

The fixed-operation client `apps/electron/scripts/backend-client.mjs` reads discovery authentication internally and never prints it. It verifies health PID/instance before inventory or mutation, does not start services, and requires explicit submission IDs, provider and request ID. Passing an owner discovery file uses the existing full owner trust boundary; it does not create a scoped-agent grant.

Remaining real-boundary evidence: successful Gemini ASR for an approved eligible audio, generated RAG answer from an intended configured model, cancellation during an actual provider call, and production lifecycle observation. Ollama was not reachable on loopback during this investigation. These checks must not be replaced by the synthetic harness or mocked provider tests.

## Windows backend tray

The backend-only owner exposes Open, Pause/Resume directed jobs, Restart and Quit in one native tray menu. Both button handlers open that menu. Pause prevents the next directed dequeue; active work finishes and reads remain available. Explicit resume restores only pending queue IDs previously admitted through persisted directed-request receipts. Restart/quit while work is active offers a native wait-or-keep-running choice. Waiting pauses new jobs and defers orderly exit until transcription and RAG generations finish. There is no silent abort or service installation.

The five-second sampler counts the backend and measurable Electron children. CPU is cumulative-counter delta normalized by logical cores; RAM is summed working sets in MB and as a percentage of physical capacity. Shared pages can therefore count more than once. External ASR processes, remote model servers and system CPU usage are not included. Missing child CPU counters are marked partial. Icons use distinct glyphs and text states: free, working, paused, sustained high usage and waiting. Local native notifications use sustained thresholds, hysteresis and cooldown. Defaults are 70% CPU, 2048 MB RAM, 25% physical capacity, 15 seconds sustained and five-minute cooldown. Native settings submenus persist nonsecret thresholds and pause state in `backend-tray-settings.json`; no renderer is required.

Observed Windows fixture evidence (2026-10-06): `C:\Users\SEBAST~1\AppData\Local\Temp\hidock-backend-fixture-VWEISV`, first PID 183576, restarted PID 337428. The real native tray had nonzero bounds, native menu callbacks paused/resumed, interval inventory remained readable, a threshold persisted, CPU warmed up and RAM was positive. Quit through the actual tray controller removed discovery; a second independent start reused the profile without schema work and preserved directed-request replay. UI rendered, closed and reopened in the same owner PID. Actual OS mouse clicks, the native active-work dialog and `app.relaunch` through Restart are still untested; unit tests exercise the two click handlers and deferred restart choice, but do not prove those native interactions.
