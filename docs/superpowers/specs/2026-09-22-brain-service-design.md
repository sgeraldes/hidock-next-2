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
3. **Nothing stops a second copy.** The packaged app holds a single-instance lock, so a second
   packaged copy only focuses the first. A `npm run dev` instance is a different matter: it uses its
   own profile, `is.dev` turns CDP on unconditionally, and each one loads its own vector store
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
