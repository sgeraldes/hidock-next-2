# Model Host: Clef and Clef-Flash decisions on the gamestation

Asked by Sebastián on 4-oct-2026. He wants both models in the host package, with HiDock
choosing between them, starting with a generic route. How HiDock uses it comes later.

## What Clef is

Cloudflare's decision models (Apache-2.0, public, not gated):

| | Clef | Clef-Flash |
|---|---|---|
| Repo, pinned revision | `Cloudflare/clef` @ `2f3de3dd85f379784083b0814d997ab627200f0c` | `Cloudflare/clef-flash` @ `17f0b0ad64efb65d273590632833508766b2aae6` |
| Backbone | Qwen3.8-27B, 64 layers | Qwen3.5-9B |
| Download | 54,989,894,057 bytes | 19,083,377,402 bytes |
| On the RTX 4090 (23,028 MiB) | 4-bit NF4 (bitsandbytes), `lm_head` and the vision tower kept in BF16 | BF16 as published |
| Published median latency (H200) | 209 ms | 39 ms |

A request is a state plus typed questions (`noul`, `choice`, `score`); the answer is a
probability for every option, in one forward pass. The body is the same as Jev's
`POST /v1/systemone`, which HiDock already calls (`jev-client.ts`), so the host serves that
route with that body and `model` picks the variant.

The joint schema head is code in the repo (`joint_schema_model.py`). The host only runs it at
the pinned revision. GGUF and NVFP4/MXFP4 builds do not apply: llama.cpp has no schema head and
the 4090 is not Blackwell.

## Host

- `POST /v1/systemone`, paired clients only, body up to 1 MB. `model` is `clef` or
  `clef-flash`. Text and JSON state only for now; `images` and `videos` are refused with 400.
- The first request for a model that is not on disk starts its download into
  `models\<name>@<revision>` and answers 503 with the progress. One download at a time.
  `/health` (paired) reports each model: absent, downloading with bytes, on disk, loaded.
- One resident Python process (`src/decide_worker.py`) holds one model on the GPU. Loading takes
  tens of seconds and a decision tens of milliseconds, so it stays loaded between requests and
  exits after 10 minutes without one, which frees the VRAM. A request for the other variant
  unloads the first. Requests go to it one at a time.
- Decisions do not take the diarization lane: they are short, and the voice backlog keeps
  running. Whether both fit in VRAM at once is measured on the 4090 before this ships.
- Stepping aside kills the whole Job Object, this process included, as it does pyannote.
- `setup.ps1` installs `transformers` 5.10.2 (the version Cloudflare tested), `accelerate` and
  `bitsandbytes`, pinned in `constraints.txt`. A failure there leaves diarization working and
  the host without the `decide` capability.

## HiDock

`model-host-client.ts` gets `decideOnModelHost(settings, request)` and an IPC channel
`model-host:decide`. Which feature asks which variant is decided later.

## Evidence before merge

On the gamestation: download time, load time, VRAM, the latency of one decision for each
variant, and a decision while a diarization job runs.
