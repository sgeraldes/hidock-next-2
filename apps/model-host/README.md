# HiDock Model Host

Runs the speaker models on the machine that has the GPU, and lends them to
HiDock Next over the local network.

The client machine has an AMD card, so every `cuda:0` in the diarization worker
quietly falls back to its CPU and a backlog takes hours. This host runs the same
`worker.py` on the gamestation's RTX card and hands the result back unchanged.

## What it does today

One capability: **diarization**. It is the most expensive thing the client does
on CPU and the only one with a settled input and output contract.

A host that is off, paused, busy or unreachable changes nothing: the recording
diarizes on the client, exactly as it does on a machine that never had a host.
Nothing fails because of the host.

## Install it on the GPU machine

Build the installer on a machine that has already built the client once, because
that is what puts NSIS in electron-builder's cache:

```bash
npm --prefix apps/model-host run build:installer
```

That writes `apps/model-host/build/HiDock-Model-Host-<version>-Setup.exe`, about
26 MB. It is **not code-signed**, so SmartScreen warns on first run.

Copy it to the GPU machine and run it. Installation is per-user, needs no
administrator, installs no service, and touches no system Python, PATH, CUDA
toolkit or existing Ollama.

Setup runs after install, or later from the Start Menu. It:

1. reports the actual GPU, driver, RAM and free disk, and says plainly when
   there is no NVIDIA driver instead of implying acceleration that is not there;
2. puts a private Python 3.11 under `%LOCALAPPDATA%\HiDock Model Host\runtime`;
3. installs the CUDA build of torch (about 2.5 GB) and pyannote into it;
4. asks for a Hugging Face token, because the pyannote weights need one and
   their licence is accepted by the person, not by the installer;
5. diarizes a synthetic two-tone clip and reports the model, the device and the
   turns it found. A green light that never ran the model is not a result.

## Run it

Start Menu → **HiDock Model Host**. It opens `http://localhost:8765/` and starts
**stopped**: installing something is not permission to hold a GPU.

On that page: **Start**, **Pause**, **Stop**, and **Show a pairing code**.

## Pair the client

On the host, press **Show a pairing code**. The code is eight digits and lasts
five minutes.

In HiDock Next: Settings → Transcription → **Model host**. Type the host address
(`gamestation:8765`), press **Check** to confirm it answers and see what GPU it
found, then type the code and press **Pair**.

## The wire

| Route | What it is |
|---|---|
| `GET /health` | version and state to anyone; GPU, driver and paired count only to a paired client |
| `POST /pair` | trades a code for a token, five wrong guesses and the code dies |
| `POST /jobs/diarize` | audio in the body, the worker's result back |

`/` and `/control` answer only from this machine, checked on both the socket
address and the `Host` header. The address alone is beaten by DNS rebinding: a
page in a browser here can be pointed at an attacker domain that resolves to
127.0.0.1, and its POST then arrives from loopback like any other.

The `ext` query parameter on a job is matched against `^\.[a-z0-9]{1,8}$` and
dropped otherwise, in the route and again where the file is written. It reaches
a filename and the body is whatever the caller sent, so an unchecked value is an
arbitrary file write, and the job's own cleanup would not remove the result
because it would land outside the temp directory that gets deleted.

One heavy job at a time. The lane is taken in the same tick as the admission
check, before the body is read, so two clients uploading at once cannot both be
admitted; the second gets 429 and goes local rather than queueing behind
something it cannot see. Audio is written to a temp file and deleted when the
job ends, including when it fails, times out or is cancelled. A client that
hangs up aborts the job instead of holding the lane for an hour.

The host advertises `diarize` only after setup has run the model once on that
machine. A runtime that installed and then failed validation leaves a host that
says it cannot diarize, rather than one that accepts every job and fails it.

## Where things live

| Path | What |
|---|---|
| `%LOCALAPPDATA%\Programs\HiDock Model Host` | the program |
| `%LOCALAPPDATA%\HiDock Model Host\config.json` | port, CPU share, model, validated flag |
| `%LOCALAPPDATA%\HiDock Model Host\secrets.json` | the Hugging Face token, ACL narrowed to the installing account |
| `%LOCALAPPDATA%\HiDock Model Host\runtime` | private Python and torch |
| `%LOCALAPPDATA%\HiDock Model Host\models` | downloaded weights |
| `%LOCALAPPDATA%\HiDock Model Host\tokens.json` | paired clients |

Uninstalling removes the program and leaves the second group, because a 2.5 GB
download and a paired token are the person's, not the installer's. The
uninstaller says so and names the folder. If the stored installation path does
not end in `\HiDock Model Host`, has a reparse-point attribute such as a junction
or symlink, or cannot have its attributes read, it leaves that directory in
place. It names the retained path, says the uninstaller remains inside it, and
still removes the Start Menu shortcuts and HKCU registration.

## What is not here yet

The full design is `docs/performance/native-windows-model-host-spec.md`. This is
its first slice. Not in it:

- ASR and embeddings over the same protocol.
- A Windows tray. There is a local control page instead, because a tray needs a
  GUI toolkit and the only way to test one is to look at it.
- A Win32 supervisor with Job Objects. Killing the host process should take the
  Python worker with it; without a Job Object a hard kill can orphan it.
- A shared resource governor. There is a CPU share and one heavy job at a time,
  and no VRAM or memory admission.
- Signed pack manifests, resumable model downloads, atomic activation.
- A durable job queue, gaming mode that survives a reboot, start with Windows.
- Code signing.
- A pairing window that is hard rather than merely expensive to brute-force.
  Eight digits, five wrong guesses and five minutes is a home-LAN threat model,
  written down here so it is a decision rather than an oversight.

## Tests

```bash
npm --prefix apps/model-host test
```

Unit tests drive the handler directly; `tests/smoke.test.mjs` starts the real
server on a real socket, because a fake request cannot catch a listener that
never binds.
