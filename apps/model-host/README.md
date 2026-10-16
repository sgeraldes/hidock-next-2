# HiDock Model Host

Runs the speaker models on the machine that has the GPU, and lends them to
HiDock Next over the local network.

The client machine has an AMD card, so every `cuda:0` in the diarization worker
quietly falls back to its CPU and a backlog takes hours. This host runs the same
`worker.py` on the gamestation's RTX card and hands the result back unchanged.

HiDock is in charge. The gamestation only helps: it has no settings of its own,
and nothing of the host runs while the machine is being used (design:
`docs/superpowers/specs/2026-10-04-model-host-tray-design.md`).

## What it does today

Two capabilities:

- **diarization**, the most expensive thing the client does on CPU;
- **decisions** with Cloudflare's Clef (27B, loaded in 4-bit) and Clef-Flash
  (9B, BF16), from 0.4.0. The body and the answer are Jev's
  `POST /v1/systemone`, and `model` picks one. Each model downloads the first
  time HiDock asks for it, at a pinned revision (19 GB and 55 GB), and stays on
  the GPU between requests until 10 minutes pass without one. Design:
  `docs/superpowers/specs/2026-10-04-model-host-clef.md`.

A host that is off, paused, in use or unreachable does not trigger local model execution by default.
The client reports the unavailable stage. Local fallback requires the user's explicit setting and retains the
local CPU and memory limits. Optional speaker enrichment can degrade while preserving a cloud transcript.

## SPEC-013 upgrade and pairing

The new durable job API uses HTTPS on port 8766 by default. Port 8765 remains a loopback-only
control channel for the tray. An existing client using `http://gamestation:8765` must be migrated:

1. Run `HiDock-Model-Host-0.4.1-Setup.exe` on GAMESTATION. Setup preserves existing models, configuration,
   pairing and an existing TLS identity. Wait for setup to finish successfully.
2. Copy only `%LOCALAPPDATA%\HiDock Model Host\tls\host-certificate.pem` from GAMESTATION to the client.
   Leave `host-private-key.pem` on GAMESTATION. Setup prints the public certificate fingerprint in its log.
3. In the updated client's Model Host settings, use `https://gamestation:8766` and import that public certificate.
   Use the host name printed by setup; its certificate does not cover arbitrary IP addresses.
4. Test the connection. An existing paired token is retained; pair again only if the host reports it is unpaired.
   Verify the host reports the required model capability before submitting work.
5. Verify a real job in the processing monitor: remote host, observed device, completion and retained result hash.

This installer is unsigned. The upgrade is not considered deployed or GPU-validated merely because the installer builds.
Durable audio jobs support diarization and VAD. ASR engines are advertised only after a spoken test succeeds on
this host and its runtime fingerprint still matches. A paired client can request optional ASR preparation with
`POST /runtime/prepare-asr` over HTTPS and an allowlisted model. The idle host exits through its tray, prepares
the private runtime, records `logs/prepare-asr.log`, and restarts. Active work rejects preparation with HTTP 409.

## Install it on the GPU machine

Build the installer on a machine that has zig on PATH (or `ZIG_PATH`) and has
built the client once, because that is what puts NSIS in electron-builder's
cache:

```bash
npm --prefix apps/model-host run build:installer
```

That compiles the tray icon, runs its tests, and writes
`apps/model-host/build/HiDock-Model-Host-<version>-Setup.exe`, about 48 MB: the
tray icon, the service, a copy of Node, the client's `worker.py`, and the
client's ffmpeg (`ffmpeg-static`). The worker decodes every recording through
ffmpeg, WAV included, and a GPU machine bought for games has none on PATH. In a
git worktree without its own `node_modules`, point the build at one with
`FFMPEG_PATH`. It is **not code-signed**, so SmartScreen warns on first run.

On the GPU machine: double-click it. Nothing else. Per-user, no administrator, no
Windows service, no system Python, PATH, CUDA toolkit or Ollama touched. It:

1. copies the program to `%LOCALAPPDATA%\Programs\HiDock Model Host`;
2. runs `setup.ps1` with no questions, in a console that shows progress and
   closes by itself: the GPU and driver it found, a private Python 3.11, the CUDA
   12.6 build of torch (about 2.5 GB) and pyannote at the versions in
   `installer/constraints.txt` (a freeze of the client's working venv; without
   the pins pip swaps in PyPI's CPU torch; regenerate with
   `uv pip freeze --python <venv python>`, minus the `+cuNNN` tags). With a GPU it
   then checks that torch sees CUDA and, if not, reinstalls the CUDA build once.
   Its output also goes to `logs\setup.log`;
3. starts the tray icon and registers it to start with Windows (`HKCU\...\Run`).

The first time the service listens, Windows Defender Firewall asks whether
`node.exe` may accept connections. Allow it on **private** networks.

## The tray icon

`tray/tray.c`, C against the Win32 API, compiled with zig (`npm run
build:tray`): 93 KB, no .NET, Node or Python in it. It is the only thing that
stays running. Measured on the main PC: 336 KB working set and no CPU while a
game keeps the service down.

It starts the service (`node.exe src\main.mjs --ready`) inside a Job Object with
kill-on-close, and ends the job to stop it: Node, the Python worker and ffmpeg
die together. The client reports the interrupted remote work; local fallback is opt-in.

Nothing polls. The thread sleeps in `GetMessage`; Windows wakes it for a menu
click, a foreground window change (`SetWinEventHook`), a game process exiting
(`RegisterWaitForSingleObject`), and, only when HiDock chose "any use", a 60 s
timer that reads `GetLastInputInfo`.

When to step aside is HiDock's one setting for the gamestation
(Settings → Transcription → Model host → "When the gamestation is in use"):

| Position | The service stops for |
|---|---|
| Whenever it is used | a game, a full-screen window, or a key or mouse press in the last 5 minutes |
| Only for games (default) | a game or a full-screen window |
| Never | nothing; only Pause in the tray |

A game is a program installed under `steamapps\common`, `XboxGames`,
`Epic Games`, `GOG Galaxy\Games`, `GOG Games`, `Riot Games`, `EA Games` or
`Ubisoft Game Launcher\games` **whose window comes to the front** (launchers and
helpers that live there and run all day in the background never do), or a
window without a title bar that covers its monitor, apart from the desktop and
the lock screen. A maximized window keeps its title bar and is not a game. The
tooltip names the program it took for a game. 0.3.0 also swept every running
process at start, and on the gamestation a background helper in a game folder
kept the service down with no game open; 0.3.1 looks only at windows. Work starts again 5 minutes after the last game closes. With no
monitor attached (the KVM on the other PC) no window is full screen and nothing
fires. Another program using CUDA does not stop the service: noticing it means
polling nvidia-smi.

Menu: the state in words; Start or Pause (Start during a game keeps it working
until that game ends; the next one steps aside again; a Pause made here waits
for Start); Pairing ▸ Show a pairing code, Cancel or Resume automatic pairing,
Disconnect HiDock and start again; Quit. The icon is green while working, amber
while stepping aside, grey when paused by hand.

## Pairing

For five minutes after the service first starts with nobody paired, it accepts
the first HiDock with no code: in HiDock, Settings → Transcription → Model host,
type `gamestation:8765`, leave the code empty and press **Pair**. The tray can
cancel that window, resume it while nobody has connected, or disconnect every
HiDock and open it again. The 8-digit code from Pairing ▸ Show a pairing code
still works, five minutes, five wrong guesses.

Pairing also provisions the host: HiDock sends its Hugging Face token
(`PUT /secrets/hf-token`) and when to step aside. The host keeps the token in
`secrets.json`, runs the voice model once on a synthetic clip, and offers
`diarize` only after that. **Check** in HiDock sends the token again to a host
still waiting for it. The person never types a token on the gamestation.

## The wire

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone; detail to a paired client | version and state; to a paired client also GPU, driver, paired count, `setup`, `stepAside`, `pairing` |
| `POST /pair` | anyone | trades a code, or nothing during the automatic window, for a token |
| `POST /jobs/diarize` | paired | audio in the body, the worker's result back; 503 until the model has run once |
| `POST /v1/systemone` | paired | Jev's body (`state`, `questions`) with `model` `clef` or `clef-flash`, up to 1 MB, text and JSON state only; Jev's answer back. 503 with each model's state while it downloads; 404 where setup did not install the decision runtime |
| `PUT /secrets/hf-token` | paired | HiDock's Hugging Face token; answers 202 and validates in the background |
| `PUT /settings/step-aside` | paired | `any-use`, `games` or `never`, written to `config.json` for the tray icon |
| `GET /diagnostics` | paired | the end of `setup.log`, `service.log` and `repair.log`, and what torch says about CUDA |
| `POST /runtime/repair` | paired | reinstalls the pinned torch and torchaudio from the CUDA index (`--force-reinstall --no-deps`), then tests the model again; answers 202, `/health` shows `repairing` |
| `PUT /update` | paired | a Model Host installer; the service keeps it and exits with code 75, and the tray icon runs it with `/S` outside its job and quits; the installer starts the icon again |
| `POST /control?format=json` | this machine only | the tray icon: `status`, `pair-code`, `pair-open`, `pair-cancel`, `pair-reset` |

The last three exist because nobody sits at the gamestation and Windows does not
let the main PC read its files (the account saved there is not the one the host
runs as). A paired HiDock is therefore trusted to run a new version of the host:
that is what being in charge of it means, and the reason pairing is limited to
the first HiDock in the automatic window or one holding the code. The service
keeps only a Windows executable; HiDock sends only a file named
`HiDock-Model-Host-<version>-Setup.exe`. In HiDock, the status line offers
**Repair** when the host has an NVIDIA GPU and still ran the model on its CPU.

The installer is 32-bit NSIS, and Windows redirects a 32-bit process's
`System32` to `SysWOW64`. It runs `setup.ps1` through `Sysnative`, the 64-bit
PowerShell: the 32-bit one cannot find `nvidia-smi`, and 0.3.0 and 0.3.1
installed the CPU build of torch on the RTX 4090 for that reason.

There is no page. `/control` answers only from this machine, checked on both
the socket address and the `Host` header. The address alone is beaten by DNS
rebinding: a page in a browser here can be pointed at an attacker domain that
resolves to 127.0.0.1, and its POST then arrives from loopback like any other.

The `ext` query parameter on a job is matched against `^\.[a-z0-9]{1,8}$` and
dropped otherwise, in the route and again where the file is written. It reaches
a filename and the body is whatever the caller sent, so an unchecked value is an
arbitrary file write, and the job's own cleanup would not remove the result
because it would land outside the temp directory that gets deleted.

The `model` query parameter pins the voice model. The client sends the model its
voice library was built with (`pyannote/speaker-diarization-3.1` today), and the
host runs that model alone, with no fallback: an answer from another model would
land in a different embedding space and stop matching every known voice. Only
the models in `PINNABLE_MODELS` (`src/server.mjs`) are accepted; anything else
gets 400 before the lane is taken, so a paired client cannot make the host
download an arbitrary repository.

One heavy job at a time. The lane is taken in the same tick as the admission
check, before the body is read, so two clients uploading at once cannot both be
admitted; the second gets 429 and goes local rather than queueing behind
something it cannot see. Audio is written to a temp file and deleted when the
job ends, including when it fails, times out or is cancelled. A client that
hangs up aborts the job instead of holding the lane for an hour.

## Where things live

| Path | What |
|---|---|
| `%LOCALAPPDATA%\Programs\HiDock Model Host` | the program and the tray icon |
| `%LOCALAPPDATA%\HiDock Model Host\config.json` | port, model, runtime paths, validated flag, `stepAside` |
| `%LOCALAPPDATA%\HiDock Model Host\secrets.json` | the Hugging Face token HiDock sent |
| `%LOCALAPPDATA%\HiDock Model Host\tokens.json` | paired clients, and whether automatic pairing was cancelled |
| `%LOCALAPPDATA%\HiDock Model Host\runtime` | private Python and torch |
| `%LOCALAPPDATA%\HiDock Model Host\models` | downloaded weights; Clef in `clef@<revision>` and `clef-flash@<revision>`, each with a `.complete` marker once fully on disk |
| `%LOCALAPPDATA%\HiDock Model Host\logs` | `setup.log`, `service.log` |

Uninstalling closes the tray icon (which ends the service), removes the program,
the shortcuts and the start-with-Windows entry, and leaves the second group,
because a 2.5 GB download and a paired token are the person's, not the
installer's. The uninstaller says so and names the folder. If the stored
installation path does not end in `\HiDock Model Host`, has a reparse-point
attribute such as a junction or symlink, or cannot have its attributes read, it
leaves that directory in place and says so.

## What is not here yet

The full design is `docs/performance/native-windows-model-host-spec.md`. Not in
this build:

- Embeddings over the worker protocol (Ollama remains a separate service).
- Real GAMESTATION acceptance of the new ASR engines; they are not advertised until their preparation test succeeds.
- A resource governor that admits jobs by free VRAM.
- Signed pack manifests, resumable model downloads, atomic activation.
- More than one concurrently admitted heavy job (durable single-job admission is implemented).
- Code signing.
- A pairing window that is hard rather than merely expensive to brute-force.
  Eight digits, five wrong guesses and five minutes, and a 5-minute automatic
  window after install, is a home-LAN threat model, written down here so it is
  a decision rather than an oversight.

## Tests

```bash
npm --prefix apps/model-host run build:tray
npm --prefix apps/model-host test
```

`build:tray` compiles the icon with `-Werror` and runs `tray/decide_test.c`
(when to step aside, what counts as a game). Unit tests drive the service's
handler directly; `tests/smoke.test.mjs` starts the real service on a real
socket; `tests/tray.e2e.test.mjs` runs the real icon with a fake game started
from a `steamapps\common` folder and checks the service stays down, comes back
after the quiet period and leaves nothing behind; `tests/installer.test.mjs`
checks the installer payload; `tests/decide-worker.test.mjs` runs the real
`decide_worker.py` against a stand-in for the model's code, and
`tests/decide.test.mjs` drives downloads, loading, idling and timeouts with a
fake worker. CI runs all of them on every pull request.

## SPEC-013 upgrade and optional ASR

This build exposes authenticated durable `/v1/jobs` for VAD, diarization and prepared ASR engines.
The control page stays on loopback HTTP port 8765. Remote clients use HTTPS port 8766.
After installing on GAMESTATION, copy only `%LOCALAPPDATA%\HiDock Model Host\tls\host-certificate.pem`
to the desktop and import it in HiDock's remote-host settings. Never copy `host-key.pem`.
Use `https://gamestation:8766` and test the selected engine, not just health.

ASR is optional. Quit the host tray, then open **Prepare Cohere ASR** or **Prepare VibeVoice ASR**
from its Start menu folder. Preparation installs into the host's private Python, downloads model
weights and transcribes a synthetic spoken sample with the normal bounded worker supervisor.
It may download several GB. The validation job has a 15-minute deadline, a 50% default CPU budget
and a memory limit. Failed preparation does not advertise the engine. A runtime/worker change
invalidates the successful-test fingerprint and requires preparing again. Then start the host tray.
Cohere requires an explicit language (for example `es`); VibeVoice permits automatic language.
These steps have not yet been exercised on GAMESTATION with this release.

If the preparation process was forcibly terminated, its `asr-preparing.lock` may remain in the host
root. Confirm preparation and its worker have exited before removing that specific lock. Ordinary
exit removes the lock automatically. The host refuses model work while it exists.
