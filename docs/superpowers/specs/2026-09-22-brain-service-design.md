# Second brain, available without being resident

**Status:** design, 2026-09-22
**Owner decision it implements:** "Arranca solo bajo demanda, avisa que lo hace, el proceso de
arranque tiene un check para no correr dos veces. Si algún agente quiere abrirlo y ya está, el
proceso no deja abrirlo y se delega a la copia corriendo. Como alternativa, un servicio muy light
headless que lee la base directo a través de la API, es lo que idealmente debería haberse hecho.
Incluso si está funcionando, que ese servicio no se levante. Lo importante es no consumir recursos
extra. Si la app no es necesaria, no se levanta." Plus: replace port 9222 with an authenticated
read-only local API.

## What the second brain is today

It is the running HiDock Next app. Agents reach it through
`dfx5-sdm-ops/scripts/hidock_bridge.mjs`, which connects to the Chrome DevTools Protocol on port
9222 and evaluates JavaScript against `window.electronAPI`. `nexo/INDEX.md` calls that "the durable
bridge for morning/weekly what-do-I-owe pulls".

### Why agents find it off

Four separate reasons, each verified on 2026-09-22.

1. **Nothing is running.** HiDock is not in `HKCU\...\CurrentVersion\Run` nor in the Startup folder,
   and it was not running when this was written. The brain exists only while the owner happens to
   have the app open.
2. **The only door is a debugger port.** CDP 9222 has no authentication, executes arbitrary
   JavaScript in the renderer, accepts any process on the machine, and lights a red security banner
   in the app. It is opened by `ENABLE_REMOTE_DEBUGGING`, a **user-wide** environment variable, so
   it applies to every Electron program the owner runs, not just this one.
3. **Nothing stopped a second copy** (fixed 24-sep-2026: one HiDock per OS user now, whatever the
   profile; see `apps/electron/CONTRIBUTING.md`). The packaged app held a single-instance lock, so a
   second packaged copy only focused the first. A `npm run dev` instance was a different matter: it
   used its own profile, `is.dev` turns CDP on unconditionally, and each one loads its own vector store
   (~1.3 GB, and up to ~4 GB more if the local embedder wakes). That is the memory the owner
   describes: sessions starting their own.
4. **The contract lives in one repo.** The bridge is a script in `dfx5-sdm-ops`, and the way in is
   "evaluate this JavaScript". Any agent that wants the brain has to know the trick.

## What it should be

A **headless brain service** that reads the database directly, serves a small read-only HTTP API on
loopback, starts only when something asks for it, and goes away when nobody does.

### The rules that decide the design

- **Nothing resident.** No autostart, no tray, no idle process. The owner's complaint was memory,
  and a service that is up all day fails the request whatever it costs.
- **Never two.** Starting is guarded, and a start request that finds something already serving
  returns that instead of launching.
- **The app wins.** If HiDock is already running and serving the same API, the service does not
  start at all. One door, no second process, no divergence.
- **Read only.** The brain answers questions. Nothing on this path writes to the database.

## The pieces

### 1. `apps/brain` — the headless service

A Node process, no Electron, no renderer, no models. It opens `hidock.db` **read-only** (`mode=ro`),
which WAL makes safe to do while the app has the same file open, and serves HTTP on `127.0.0.1`.

Expected footprint: tens of megabytes. `better-sqlite3` plus a request handler, nothing else. This is
the "servicio muy light" from the decision, and the reason it can afford to be started on demand.

**Lifetime.** It exits after `BRAIN_IDLE_TIMEOUT_MS` (default 10 minutes) with no request. A morning
pull costs one startup and ten idle minutes, then nothing.

**Single instance.** A lock file under the data directory holds `{pid, port, startedAt, token}`.
Startup reads it, probes the port, and if something answers `/health` with a matching instance id it
prints where that instance is and exits 0 without binding. A stale lock (nothing answers) is
replaced. This is the "check para no correr dos veces": the second starter does not fail, it
delegates.

### 2. The same API inside the app

The Electron main process serves the identical routes when the app is running, off by default, with
a Settings toggle. It registers itself in the same lock file, so `apps/brain` sees it and stands
down.

This is what makes "si la app no es necesaria, no se levanta" true in both directions: the service
never duplicates the app, and the app is never started just to answer a question.

### 3. Authentication, reusing what is already hardened

`apps/model-host` already solved this exact problem and was hardened on 2026-09-22. The brain reuses
its shape rather than inventing one:

- a pairing code exchanged once for a long token (`auth.mjs`, `PairingStore`)
- constant-time comparison that does not leak length
- the code dies after 5 wrong attempts
- **Host header checked**, not just the socket address, so a DNS-rebinding page cannot reach it
- bound to `127.0.0.1` only

The token lives in the data directory with the lock, readable by the owner's account, which is the
same trust boundary as the database file itself.

### 4. The bridge, rewritten

`hidock_bridge.mjs` stops speaking CDP and speaks the brain API. It:

- reads the lock file, finds whoever is serving, and uses it
- starts `apps/brain` when nothing is
- **never launches the Electron app**
- says plainly what it did, because the decision asks it to announce itself: `[brain] started the
  headless service on 127.0.0.1:<port>` or `[brain] using the running app`

### 5. Port 9222 goes away

Once the bridge no longer needs it: `ENABLE_REMOTE_DEBUGGING` is deleted from the user environment,
and the app's production path stops reading it. `is.dev` keeps CDP for development, which is what it
is for.

## The API

| Route | Replaces | Reads |
|---|---|---|
| `GET /health` | — | nothing; returns instance id, kind (`app` or `service`), uptime |
| `GET /meetings?since=<iso>` | `meetings-since` | `meetings` |
| `GET /actionables?since=<iso>&status=pending` | `actionables-pending` | `actionables` |
| `GET /knowledge?ids=a,b,c` | `knowledge` | `knowledge_captures` |
| `GET /knowledge/<id>` | `summary` | `knowledge_captures` |
| `GET /actionables/<id>` | `actionable` | `actionables` |
| `GET /capabilities` | `api` | nothing; lists the routes this instance serves |

### What does not survive, on purpose

- **`raw`** — evaluating arbitrary JavaScript in the renderer is the security hole this replaces.
  Anything it was used for becomes a route or does not happen.
- **`recording-now`** — it calls `jensen.listFiles()`, which needs the USB device. A database reader
  cannot answer it. That question already has a home: the `mcp-hidock-storage` MCP server talks to
  the device directly. The split is clean: device questions to the device server, knowledge
  questions to the brain.

## Testing

- lock-file arbitration: cold start; start with a live service; start with the app serving; start
  with a stale lock whose pid is gone; start with a stale lock whose port now belongs to something
  else
- idle exit fires, and a request during the countdown cancels it
- read-only enforcement: the connection rejects a write
- concurrent read while the app holds the database open in WAL
- auth: no token, wrong token, wrong Host header, attempt limit
- each route against a seeded database, including the empty case
- the bridge: picks the app when both could serve, starts the service when neither does, reports
  which one it used

## Out of scope for the first cut

Semantic search and RAG. Those need the vector store and an embedder, which is exactly the 1.3 GB
this design exists to avoid loading. The structured reads above are what the bridge actually does
today. If semantic recall is wanted later it belongs in the app, where the vectors already live, and
the brain can proxy to it when the app happens to be up.

## Should the app use the service as its backend? No — and here is the measurement

The question is whether the headless process should be the data layer and the app a client of it,
which would make the two-layer split real instead of having the service stand down when the app
opens.

**The app makes 1,527 synchronous database calls in its main process** (1,004 `run(`, 293
`queryOne<`, 230 `queryAll<`), on a `better-sqlite3` engine whose entire contract is synchronous —
`get`, `all`, `run` return values, not promises. Putting HTTP between the app and its own database
means converting all 1,527 call sites to async, adding a round trip to every read the UI does, and
introducing a process that can be down while the app is up. An earlier design in this repo already
took the opposite constraint as a requirement: "los 8 métodos síncronos quedan síncronos, 11 call
sites intactos."

**The model-host precedent does not transfer.** That service is headless for a physical reason: the
GPU is on another machine, this one has an AMD card, and every `cuda:0` in the diarization worker
needs hardware that is not here. The layering buys access to something otherwise unreachable. A
SQLite file sitting on the same disk as the app offers nothing in return for the same split.

So the two-layer split is refused on cost, not on taste.

### But the concern behind the question is right

If the service and the app each write their own version of "meetings since this date", they drift,
and the brain starts answering differently depending on which one happened to be up. That is a real
defect waiting to happen, and it is the actual risk in the design above.

**The fix for duplication is a shared module, not a shared process.**

- `packages/brain-queries` holds the read queries as plain SQL against the schema. One
  implementation.
- The app serves the API from its own process, importing that package, with no HTTP in between.
- The headless service serves the same routes from the same package when the app is closed.
- Divergence becomes impossible because there is only one copy to diverge from.

### What the gamestation pattern is worth copying

Not the process split — the **hardened local-service skeleton**. `apps/model-host/src/auth.mjs` is
117 lines that already solve pairing codes, long tokens, constant-time comparison, the attempt
limit, and the Host-header check against DNS rebinding, all reviewed on 2026-09-22. Three things now
need exactly that: the model host, the brain service, and the app's own API.

`packages/local-service` takes it, and all three import it. That is the part of the pattern that
earns its keep: one copy of the security code, reviewed once.

## Stepping down when the app opens

The service exists because the app is closed. The moment the app serves the API, the service is
redundant and goes away, leaving the app fully responsible.

Two independent paths, so neither is a single point of failure:

1. **Told.** The app claims the lock file and calls the service's authenticated `/step-down`. The
   service stops accepting connections, finishes the requests already in flight, and exits.
2. **Noticed.** The service re-reads the lock on a timer and on every request. If the owner is now
   `app`, it steps down on its own. This covers the app failing to reach it.

**Ties go to the app.** Both starting at once is resolved by an atomic create of the lock file
(`wx`), and if the service wins that race the app takes ownership anyway and the service steps down.
The app is never the one that yields, because the app is the one a person is looking at.

**In-flight requests are never dropped.** Stepping down drains; a client mid-question gets its
answer, and the next question goes to the app.

## What was built, and where it departs from the above (2026-09-22, night)

Building it turned up a fact that changed the shape. The IPC handlers the old
bridge reached through `window.electronAPI` do not just read rows: they run
them through the app's **eligibility gate** — `applyCaptureEligibility`,
`gateActionables`, `filterEligibleRecordingIds` — which keeps recordings the
owner marked personal, deleted or value-excluded, and everything derived from
them, away from assistants. A separate `packages/brain-queries` with its own SQL
would have been a second copy of a privacy rule, and a second copy drifts.

So the headless brain is **the app's own binary**, launched as
`HiDock Next.exe --brain-only`, instead of a separate `apps/brain` service:

| Planned | Built | Why |
|---|---|---|
| `apps/brain`, a separate Node service | `--brain-only` mode of the app (`brain-host.ts`) | same code, same gate, nothing to keep in sync |
| `packages/brain-queries` | `services/brain-queries.ts`, calling the gate and mappers moved to `services/capture-read-model.ts` and `services/actionable-read-model.ts` | the gate had lived as private functions in two IPC handler files; moved unchanged so both callers share it |
| `packages/local-service` shared with model-host | the token compare and Host check live in `brain-server.ts` | model-host is a separately installed product with its own pairing flow and its own installer; sharing ~30 lines would have meant vendoring a workspace package into that installer |
| pairing code | token written to the lock file | the only clients are processes of the same Windows account, so reading the lock file is already the proof of identity |

**Measured.** The headless brain runs in about 190 MB of working set across three
processes. On the installed build of 2026-09-23: main 109 MB, network utility 41, GPU 38.
Hardware acceleration is off in that mode, but Chromium still starts a GPU process for
software compositing; that switch saved about 7 MB, not the process. The full app runs in about
1.7 GB. Against the owner's real database, read-only, with the app open:
answers came back for pending actionables (86), meetings (37), a meeting's
recordings with coverage ranking, and a transcript; `recording-now` answered 503
because the device state lives in the app; a second `--brain-only` saw the first
and exited 0; after 90 s idle (`HIDOCK_BRAIN_IDLE_MS`) it logged
`{"event":"stopped","reason":"idle"}`, removed the lock and exited 0.

**Privacy, measured.** Two recordings in the owner's library are soft-deleted
and linked to meetings. Through the brain, both transcripts return `null`, and
the meeting that has two other recordings returns those two and not the deleted
one. The old bridge's callers used `recordings.getForMeeting`, which gates
nothing because it serves the owner's own meeting page; its brain counterpart
gates, and the owner's page is unchanged.

**Not served.** `raw` is gone, by design. `recording-now` needs the app open.
Semantic search and RAG stay in the app, as stated above.

**Port 9222, closed.** An installed build no longer opens the debugging port
under any setting. `ENABLE_REMOTE_DEBUGGING` is not read anymore, and the red
banner that announced it went with it. Development builds keep the port, which
is what it is for. Until this landed the port was still open on the owner's
machine, and any local process could reach `recordings.getForMeeting` through it
and skip the gate this work adds.

**Review of PR #29, fixed.**

| Finding | Fix |
|---|---|
| A path with a bad escape (`/transcripts/%E0`) threw before the `try`: an uncaught exception in the main process | parsing moved inside its own guard, answers 400 |
| On Windows, renaming over `brain.json` fails with EPERM while another process reads it. The app's first write then left it unreachable for the whole session | `writeBrainLock` retries EPERM, EBUSY and EACCES with short waits. The app arms its watchdog before the first write and treats a failed write as one to retry |
| The lock's `exe` came from `process.execPath` even in dev, and the bridge launched it from a dead lock | `exe` is written only by an installed build, and the bridge never launches a dead lock's `exe` |
| A headless brain on its way out read the lock, then deleted it; the app's new lock could land in between | it removes its lock while its server still answers. The app writes only after that server stops answering |
| Quitting while the app was still displacing a headless brain left a server running after the database closed | a start that finds the app quitting closes its server and returns |

## Upgrading the database when the app is closed (2026-09-25)

**What broke.** The headless brain opened the database read-only and refused a file on an older
schema than its code. Installing a build with a new migration left the file one schema behind until
the owner opened the app window. On 2026-09-24 the daily SDM sweep ran with the app closed, and
every bridge command (`actionables-pending`, `recording-now`, `ingest.py all`) failed with
`The database is on schema v57 and this code needs v58`. Agents were locked out until someone
opened the app by hand, which is what the headless brain was supposed to make unnecessary.

**What it does now.** On that refusal (`SchemaBehindError`, typed so no other failure takes this
path) the brain asks for the lock every HiDock of this user competes for (`requestSharedInstanceLock`
in `single-instance.ts`, the lock from PR #37). It holds the lock only while it upgrades, then
releases it and opens the file read-only as on any other start (`brain-upgrade.ts`).

| Situation | What happens |
|---|---|
| Lock free: no app running or starting | the brain runs the app's own `initializeDatabase()`: the fail-closed pre-migration backup (the hourly copy hard-linked when identical, otherwise an online backup), then the migrations. Then it closes the file, releases the lock and serves read-only |
| Lock taken: the app is open or starting | the brain does not touch the file and exits 1, saying the app upgrades it when it starts |
| The owner opens the app during the upgrade | the launch finds the lock taken and quits, as any second instance does. The brain notes it and, once the lock is back, starts the app (installed builds only). The app then takes over the brain API as usual |
| The upgrade fails | the lock is released, the error goes to the log, and the app still opens if the owner asked for it |

While the lock is held no app can start against the file, so the upgrade never runs beside a
writer. The brain writes to the database only during this upgrade.

A refused lock request always reaches the holder as a `second-instance` event, which the app
answers by coming to the front. The brain's request carries `{hidockBrainLockProbe: true}`, and
the app and an upgrading brain ignore events that carry it. Without the marker an open app would
jump forward whenever an agent's brain met an old schema, and a second brain racing the first
would make the first open the app.

**Measured on 2026-09-25**, packaged build, on a copy of the owner's 2.9 GB database from the
v57 backup of 24-sep:

| Case | Result |
|---|---|
| Another HiDock holds the lock | exit 1 with the message above; file modification time, size and schema v57 unchanged; the holder got the probe marker |
| App closed, through the bridge | backup, v57 to v59, read-only serve: 97 pending actionables in 6.5 s (backup to a local SSD) |
| Backup | `hidock.db.bak-2026-09-25` present, schema v57 |
| After the upgrade | the lock is free while the brain serves |


**The launcher waits.** The brain logs `{"event":"upgrading"}` and throttled `upgrade-progress`
lines. The bridge in `dfx5-sdm-ops/scripts/hidock_bridge.mjs` normally gives the brain 30 s to
come up. When it sees `upgrading` it extends that to 30 minutes and says so on stderr, since a
backup of the 2.9 GB library can take minutes.

**`recording-now` with the app closed** still answers `{"recording": null, "error": ...}`,
because the device state lives in the app. What changed is that the bridge gets that answer
instead of a brain that never started.
