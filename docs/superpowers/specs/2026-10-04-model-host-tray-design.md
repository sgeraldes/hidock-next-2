# Model Host: a tray icon, nothing running while the machine is used, HiDock in charge

Approved by Sebastián on 4-oct-2026. Replaces the control page and the Node game mode of host 0.2.0
(PR #140), which kept Node and a PowerShell probe alive while "paused".

## What Sebastián asked for

- The machine with HiDock is in charge. The gamestation only helps and has no configuration.
- On the gamestation, a tray icon with Start, Pause and Quit. Pause and Quit take everything out of
  memory. A paused host costs zero memory and zero CPU apart from the icon.
- It is a gaming machine: nothing runs while it is being used, unless he says otherwise.
- The only setting is in HiDock, three positions: step aside whenever the gamestation is used, only
  for games, or never.
- Pairing: automatic for 5 minutes, which he can cancel, resume while nobody has connected, or
  undo (disconnect HiDock and start again). The 8-digit code stays as the alternative.
- The Hugging Face token lives in HiDock. The gamestation never asks for it; HiDock sends it.
- Installing is a double click and nothing else.

## The tray icon

`apps/model-host/tray/tray.c`, C against the Win32 API, compiled with zig (`zig cc -target
x86_64-windows-gnu`). No .NET, Node or Python in the icon. One thread asleep in `GetMessage`; Windows
wakes it for menu clicks and for the events below. Nothing is polled except, in the "any use"
position only, one `GetLastInputInfo` call a minute.

Measured on the main PC with a prototype (3-oct): 228 KB resident, 800 KB private, 0 ms of CPU in
50 s after a 31 ms start, one thread, 26 µs per foreground change.

| Concern | How |
|---|---|
| One icon per user | named mutex |
| Run the service | `CreateProcess` of the bundled `node.exe src\main.mjs --ready`, no window, inside a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` |
| Pause, Quit, a game | `TerminateJobObject`: Node, the Python worker and ffmpeg die together; the client gets a refused connection and diarizes locally |
| A game | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`: on each foreground change, the window's process path (`QueryFullProcessImageNameW`) against the game folders, and whether the window covers its monitor; one re-check 3 s later for a window that goes full screen after it comes to the front |
| The game ended | `RegisterWaitForSingleObject` on the game's process handle; the service starts again 5 minutes after the last game exits |
| Any use | a 60 s timer reading `GetLastInputInfo`; input in the last 5 minutes stops the service; 5 minutes without input starts it again |
| Never | no hook, no timer |
| Start with Windows | `HKCU\...\Run`, set by the installer |
| KVM without a monitor | no foreground game and no full-screen window, so nothing fires; `MONITOR_DEFAULTTONULL` gives no monitor and the window is not full screen |

The position (`stepAside`: `any-use`, `games`, `never`; default `games`) is in
`%LOCALAPPDATA%\HiDock Model Host\config.json`, written by the service when HiDock sends it, and read
by the icon at each decision (a file read, at events only).

Game folders, built in: `steamapps\common`, `XboxGames`, `Epic Games`, `GOG Galaxy\Games`,
`GOG Games`, `Riot Games`, `EA Games`, `Ubisoft Game Launcher\games`. Never a game: Epic and Riot
launchers and helpers, Wallpaper Engine, crash reporters. Not configurable on the gamestation.

Menu: Start or Pause (whichever applies), Pairing ▸ (Show the code; Cancel automatic pairing or
Resume automatic pairing; Disconnect HiDock and start again), Quit. The tooltip says the state in
words. The icon talks to the service over loopback (`POST /control?format=json`).

## The service

Removed: the page at `/`, `/control` as a form, `game-mode.mjs`, `probe.mjs`, `probe.ps1`,
`pause-resume.ps1`, `gameMode` in config.json. The service runs only while the icon wants it, so it
starts ready.

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone; detail to a paired client | version, state; for a paired client also GPU, `setup` (needs-token, validating, ready, failed), `stepAside`, pairing window |
| `POST /pair` | anyone | with the code, or with no code while the automatic window is open |
| `POST /jobs/diarize` | paired | unchanged |
| `PUT /secrets/hf-token` | paired | HiDock's token; the host keeps it and runs the model once on a synthetic clip, then offers `diarize` |
| `PUT /settings/step-aside` | paired | `any-use`, `games` or `never` |
| `POST /control?format=json` | this machine only (socket and Host header) | the icon: `pair-open`, `pair-cancel`, `pair-reset`, `pair-code`, `status` |

Automatic pairing: open for 5 minutes when the service starts with no paired client and the window
has never been cancelled; the first successful pair closes it. `pair-reset` forgets every paired
client and opens it again.

## HiDock

- Settings > Transcription > Model host keeps address, Check, code, Pair, Forget and the status line.
  Pair works with an empty code while the host's automatic window is open.
- New, the only one: "When the gamestation is in use" with three positions, sent to the host on
  change, on pairing and on Check.
- On pairing and on Check, when the host says `needs-token`, HiDock sends its Hugging Face token.
- The status line: working; working on a recording; testing the voice model; could not run the voice
  model (why); not answering (paused, in use or off); not paired; paired but the speaker engine runs
  here.

## Setup

The installer copies the program, runs `setup.ps1` with no questions (hardware check, private Python,
torch cu126 and pyannote at the client's versions), starts the icon and registers it to start with
Windows. No token prompt, no validation in setup: the host validates once HiDock sends the token.

## Out of scope, written down

- Another program computing on the GPU no longer pauses the host: noticing it needs polling
  nvidia-smi, which is not free on a machine someone is playing on.
- A windowed game outside the game folders, under "only games", shares the machine until it goes
  full screen. "Any use" covers it.
