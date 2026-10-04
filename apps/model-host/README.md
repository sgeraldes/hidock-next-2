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

One capability: **diarization**. It is the most expensive thing the client does
on CPU and the only one with a settled input and output contract.

A host that is off, paused, in use or unreachable changes nothing: the recording
diarizes on the client, exactly as it does on a machine that never had a host.
Nothing fails because of the host.

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
die together, and the client gets no answer and diarizes locally.

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
| `%LOCALAPPDATA%\HiDock Model Host\models` | downloaded weights |
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

- ASR and embeddings over the same protocol.
- A resource governor that admits jobs by free VRAM.
- Signed pack manifests, resumable model downloads, atomic activation.
- A durable job queue.
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
checks the installer payload. CI runs all of them on every pull request.
