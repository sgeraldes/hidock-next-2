# Speaker engines: voice recognition on any hardware

Date: 2026-09-24
Status: design, building in phases on `feat/speaker-engines`.
API reference: `2026-09-24-diarization-provider-apis.md` (official docs, read 23-sep-2026).

## The request

Sebastián, 23-sep, after a 4-hour recording spent 80 minutes in local diarization on the CPU:

> we definitely cannot rely on CPU diarization for users that don't have a GPU.

> Automatic Voice recognition is a MAJOR feature that is distinct from other solutions. So disabling
> it should come with a big red warning, and only run once per hardware change (not on every launch,
> only when a new gpu is detected or removed). And a set of configuration options by hardware, plus a
> recommended one, should exist. Let's not build only one option, let's build all 4. And provide
> capabilities to use any of the services you mentioned.

## Goals, in Sebastián's words (do not drop any)

1. CPU diarization cannot be the path for users without a GPU; give them a real alternative.
2. Voice recognition is a major, distinguishing feature. Turning it off comes with a big red warning.
3. The hardware check runs once per hardware change (a GPU added or removed), never on every launch.
4. A set of configuration options per hardware profile, with one marked as recommended.
5. Build all four options, not one: hardware-aware local engine, voice signatures from the
   transcriber's turns, the remote Model Host (RTX 4090), and online services.
6. Support every online service named: Gemini, OpenAI, Meta Muse, AssemblyAI (and pyannoteAI, the
   only one with reusable voiceprints). Compare them on diarization quality and cost.
7. A person's voice identity must survive hardware changes (added 24-sep, see below).
8. Every optimization round ends with a benchmark compared against the baseline.
9. Changing the voice model must not lose known voices. When a model is needed or a change is
   detected, offer a model transfer: take samples of every recorded voice from its speaker turns, run
   them through the new model, and keep an equivalence table per model (added 24-sep).
10. Each voice has one canonical ID, whatever model recognized it, so several models can run side by
    side. Labels from different models never collide, or the transcript says which model produced
    them. pyannote 3.1 is the default and the backward-compatible reference; only other models get
    a model tag (added 24-sep).

## Voice identity across hardware (measured 24-sep)

The ID depends on the embedding model, not on the device. The library's voices were built with
`pyannote/speaker-diarization-3.1` (pyannote.audio 4.0.7): 58 recordings on the RTX 4090 (CUDA, 24-aug
to 04-sep) and 125 on the CPU (since 15-sep). 35 voices were matched in recordings from both periods,
including all 6 anchored to a contact. Changing GPU, moving to the CPU, or moving to the Model Host does
not change a voice ID as long as the model is the same.

The latent risk: the configured model is `community-1` with 3.1 as fallback, locally and on the Model
Host. It falls back to 3.1 today because community-1 does not load here. It never produced a single
voice: every attempt failed (24-aug invalid worker output; 25-26-aug `transformers` errors; 27-aug
unauthenticated Hugging Face download and "paging file too small"; 15-16-sep and 22-sep 600 s
timeouts; 21-sep "accept user conditions": the model is gated and the conditions were never accepted
on the owner's Hugging Face account). community-1 shipped with pyannote.audio 4.0.0 on 29-sep-2025:
VBx clustering instead of agglomerative, an "exclusive" one-speaker-at-a-time output that lines up
with transcript timestamps, and lower DER than 3.1 on every published benchmark (AMI IHM 18.8 → 17.0,
AliMeeting 24.5 → 20.3, DIHARD 3 21.4 → 20.2, MSDWild 25.4 → 22.8). Whether its embedding weights
equal 3.1's is not published; the compatibility check below answers it on the owner's audio. If it ever loads (here or on
the 4090), new embeddings land in a different space and stop matching every known voice, silently.
Rule, from phase 1: **the model that writes voice evidence is pinned to the library's cluster space**
(the model and version of the existing clusters). A different model is allowed only through the
compatibility check and re-embedding pass described under "Keeping known voices". The Model Host must
use the same pinned model; the client sends it and refuses a result from another model.

The Model Host exists: `apps/model-host`, installer built as `HiDock-Model-Host-0.1.0-Setup.exe` (PR #9,
22-sep). That build predates phase 1: it defaults to community-1 and ignores `model=`. The source on main
defaults to 3.1 and honours the pin, so the installer has to be rebuilt before it is installed and paired
on the 4090 machine (phase 5).

## What exists

- Transcription providers: `gemini` (default, `gemini-3.5-transcribe`, speaker labels per 20-minute
  chunk), `local-asr`, `vibevoice`. A hard-coded three-way choice in about seven places.
- Voice recognition ("speaker linking"): before the provider runs, `worker.py` runs pyannote over the
  whole recording (torch; CUDA if present, else CPU), returns speaker segments and one 256-dimension
  embedding per speaker. `persistMatches` compares each embedding with stored `voice_clusters`
  (cosine ≥ 0.72, margin ≥ 0.08) and gives every voice a stable `Voice XXXXXX` label across
  recordings; a voice anchored to a contact names that person in every future recording.
- The seam: every engine returns `AcousticWorkerResult {model, modelVersion, device, segments,
  speakers[{label, embedding, speechSeconds}]}`. The remote Model Host already returns the same shape.
- `speakerLinkingEnabled` exists only in config.json. Off means no stable labels, no automatic naming
  of known people, and stale evidence left on re-transcribed recordings.
- The owner's library: 244 voice clusters, 6 anchored to contacts, all `pyannote/speaker-diarization-3.1`
  embeddings (WeSpeaker ResNet34-LM, 256-d). Clusters only match within the same model and version.
- Hardware on the owner's PC: AMD Radeon RX 6600 XT (RDNA2, gfx1032) plus an iGPU, Ryzen 9 7900X3D, no
  CUDA. ROCm on Windows does not support RDNA2 officially. `onnxruntime-node` 1.24.3 already ships
  `DirectML.dll`; nothing uses it.

Measured cost of the current CPU path: diarization runs at ~0.33× the audio length (80 min for 4 h).

## The five engines

Every engine produces an `AcousticWorkerResult`; `persistMatches` and everything after it stay as
they are.

| Engine | Where | What it runs | For |
|---|---|---|---|
| `pyannote-local` | this PC | today's worker.py (torch) | NVIDIA GPUs; slow on CPU |
| `onnx-local` | this PC | sherpa-onnx: pyannote segmentation-3.0 + WeSpeaker ResNet34 embeddings, ONNX Runtime with DirectML or CPU | AMD/Intel GPUs, and a faster CPU path |
| `signatures-from-turns` | this PC | no diarization; takes the transcriber's speaker turns and embeds a few seconds per speaker with the same ONNX embedding model | any hardware; seconds instead of minutes |
| `model-host` | a PC on the LAN | today's remote host (GPU) | a home GPU box, e.g. the RTX 4090 |
| `pyannoteai` | online | pyannoteAI Precision diarization + voiceprints | CPU-only machines that want the best diarization |

`signatures-from-turns` changes the order of the pipeline: transcription first, then embeddings, then
matching and relabelling. The other engines keep today's order (acoustic first, then the provider,
then `reconcileProviderSpeakers`).

### Keeping known voices

Clusters match only within one embedding model. A new model would start every voice from zero and
lose the 6 people already anchored. Rule:

1. `onnx-local` and `signatures-from-turns` use WeSpeaker ResNet34-LM in ONNX, the same network as
   pyannote 3.1. Before either may write to the existing cluster space, a compatibility check runs on
   the owner's recordings: embed the same segments with both, and require cosine ≥ 0.95 on average.
   Pass: they share `model` family and clusters. Fail: they get their own model id, and a one-time
   **re-embedding pass** rebuilds every anchored cluster in the new space from the stored segments of
   recordings where it was observed (audio is on disk), so anchored people carry over.
2. `pyannoteai` voiceprints are opaque and matched only by their `/identify` endpoint. They live in a
   separate table keyed by contact; they never mix with local clusters.

### Canonical voice IDs and model transfer

Goals 9 and 10. The existing `voice_clusters` rows are all `pyannote/speaker-diarization-3.1`; they
become the canonical voices, so every `Voice XXXXXX` label and every contact anchor stays exactly as it
is today. pyannote 3.1 stays the default model when nothing is chosen.

Data model (one migration):

- `voice_clusters.canonical_voice_id` (nullable, FK to `voice_clusters.id`). NULL on a 3.1 row: the
  row is itself canonical. On a row from another model it points to the canonical voice it
  represents. A row per (canonical voice, model, model_version) is the equivalence table.
- A voice first heard by a non-default model, with no match in its space, gets a new cluster that is
  its own canonical voice. Its label comes from its own id, so it cannot collide with a 3.1 label.
  The next transfer into 3.1 gives it a 3.1 row pointing at it.
- `recording_voice_clusters.model` records which model made each match. The label shown is always the
  canonical one; the transcript shows a small model tag only when the model is not pyannote 3.1.
- Contact anchors live on the canonical row. Matching in any model resolves to the canonical voice
  and reads the contact from there.

Model transfer, offered when a new model is chosen, or when a result arrives from a model that has no
rows yet (for example community-1 finally loading, or a Model Host running another model):

1. For each canonical voice, collect samples from its speaker turns: the transcript turns whose label
   `recording_voice_clusters` maps to that voice, one speaker only, no overlap, 2 to 15 s each, up to
   60 s per voice from at least two recordings when there are two. Audio is on disk (MP3 inside a
   WAV header: decode by content, not by the header).
2. Embed the samples with the new model and store the mean as the voice's row in that model's space.
3. Validate before the new model may write: hold out one recording per voice, re-embed it, and
   require that it maps back to the same canonical voice with the usual thresholds (cosine ≥ 0.72,
   margin ≥ 0.08). Report per voice; a voice that fails stays usable in 3.1 and is marked
   `needs_review` in the new model. The run fails as a whole if any anchored voice fails.
4. Until the transfer passes, the pin rule holds: results from the new model are not written.

Several models can then run side by side (for example `onnx-local` on the AMD GPU and 3.1 on the
Model Host) because both resolve to the same canonical voice. `signatures-from-turns` (engine 3) uses
the same sampling code as step 1, which is why the two ship together.

## Online transcription providers

Transcription (text plus speaker turns) and voice recognition are separate choices. Any transcriber
feeds any engine; `signatures-from-turns` needs a transcriber that returns speaker turns.

| Provider | Model | Price/h | Max per request with speakers | Turns | Notes |
|---|---|---|---|---|---|
| Gemini (today) | gemini-3.5-transcribe | ~$0.30 | 30 min | per word | ≤ 8 speakers, 3+ experimental |
| OpenAI | gpt-4o-transcribe-diarize | $0.36 | 25 MB | per segment | `diarized_json`; no prompt |
| AssemblyAI | universal-3-5-pro | $0.23 | 10 h | per word | trains on data unless opted out |
| Meta Muse | ASR `mode: DIARIZATION` | $0.18 | 10 min, PCM WAV | per turn | retention undocumented |
| pyannoteAI | precision + `transcription: true` | €0.14–0.17 | 24 h | per segment | also voiceprints |

Implementation: a provider registry replaces the three-way ternary. Each provider declares id, label,
key name, price per hour, max chunk, whether it returns speaker turns, whether it accepts a prompt,
and a `transcribe(audio, options)` that yields the shared `TranscriptSegment`. HiDock audio is MP3 in
a lying WAV container: providers get the MPEG payload as `audio/mpeg`; Meta gets a decoded PCM WAV.
Chunked providers keep speaker continuity by relabelling each chunk's turns through the voice
signatures (the same matching as across recordings), not by provider label id.

Keys are stored encrypted (safeStorage), never in plain text; the renderer receives only whether a
key is set. The existing plain-text Gemini and HF keys move to the encrypted store in the same change.

## Hardware profiles

A **hardware fingerprint** is the sorted list of real GPUs as `vendor:name` (WMI
`Win32_VideoController`, virtual displays excluded; `nvidia-smi` marks the ones CUDA can drive).
Driver versions are left out on purpose: a driver update must not ask again (goal 3). CPU and Model
Host pairing shape the options but are not part of the fingerprint. It is stored in config. At launch
the fingerprint is computed (cheap, no model loading); only when it differs from the stored one does
the app open the **Speaker setup** dialog. Launches with the same hardware never show it. "Decide
later" stores the fingerprint it was answered on, so the dialog stays closed until a GPU is added or
removed. A GPU query that fails (PowerShell missing, WMI error) is not read as "no GPU": the dialog
does not open on it, and a choice cannot be saved until detection works.

| Detected | Recommended | Also offered |
|---|---|---|
| NVIDIA GPU with CUDA | `pyannote-local` on CUDA | onnx-local, signatures, model-host, pyannoteai |
| AMD or Intel GPU | `onnx-local` on DirectML | signatures, model-host, pyannoteai, pyannote-local (CPU, slow) |
| CPU only, Model Host paired | `model-host` | signatures, onnx-local (CPU), pyannoteai |
| CPU only | `signatures-from-turns` | onnx-local (CPU), pyannoteai, pyannote-local (slow) |

The dialog shows what was detected, the options for this hardware with an estimate per hour of audio
(the median of this computer's own past runs on the same device and model, shown once there are at
least three runs of five minutes or more; nothing is shown rather than a guess), the cost for online
options,
and the recommended one preselected. The same panel lives in Settings under "Speakers & voices".

Only engines that are built appear. Until an engine ships it is not listed at all, not even greyed out:
a choice nobody can pick or fix is noise (Sebastián, 24-sep). An engine that is built but needs a step
(the Model Host before pairing) stays, with the step written under it.

**Turning voice recognition off** is an option in the list, never the default. Choosing it shows a
red warning, and needs a second, explicit confirmation:

> Voice recognition is what lets HiDock name the people in your recordings. With it off, speakers stay
> "Speaker 1, Speaker 2" in every recording, known people are no longer named automatically, and
> voices you already identified stop being matched.

## Long recordings stop blocking short ones

Measured on 23-sep: one 4-hour recording held a 21-minute one for over an hour. The queue orders by
remaining work: a recording waiting behind a job that will take more than 10 minutes longer than
itself goes first. The Library shows the stage (preparing, voices, transcribing, labels) and an
estimate from the engine's measured speed.

Built on 24-sep as a second lane (`maybeStartShortLane` in `transcription.ts`). A job can not be paused
halfway through Gemini, so instead of reordering, a waiting recording runs beside the long one when the
long one's remaining estimate exceeds the waiting one's by more than 10 minutes. Estimates: 0.12 s per
second of audio for Gemini plus 0.35 s for the local voice step (measured 24-sep: 1 h in about 2 min,
4 h in 14 min, pyannote at the 40% thread budget about 0.3). One short job at a time, and none while the
long job is in its local voice step, so two pyannote workers never share the CPU. The queue state
carries `shortLaneId`; the dock lists both rows as processing.

## Phases

Each phase: spec section, tests, adversarial review by a separate agent, merge, and a benchmark
compared with the baseline (`scripts/perf/compare.py`).

1. **Engine seam, hardware profiles, Speaker setup, red warning, model pin.** Engine interface around
   the two existing engines (`pyannote-local`, `model-host`) plus `off`; fingerprint; dialog; Settings
   panel; the voice model pinned to the library's cluster space (local and host: the client sends
   `model=` on every job, the host runs only that model from an allow-list, and a host from before
   pinning that answers in another model is ignored in favour of this computer); pyannote 3.1 as the
   default everywhere, including the Model Host installer.
1b. **Long recordings stop blocking short ones.** Queue ordering and a lane for short recordings
   while a long one runs; stage and estimate in the Library. Its own PR, right after phase 1.
2. **Canonical voice IDs, model transfer, `onnx-local` and `signatures-from-turns`.** The
   `canonical_voice_id` migration and model tag; turn sampling shared by the transfer and by
   `signatures-from-turns`; sherpa-onnx with DirectML and CPU; the compatibility check; transfer with
   hold-out validation; speed measured on this PC against pyannote. community-1 becomes a transfer
   target once its Hugging Face conditions are accepted and it loads.
   **`onnx-local` built 24-sep:** pyannote 3.1 keeps its chunking and clustering; its two models run
   through ONNX Runtime (`worker.py --engine onnx`, exports from `export_voice_onnx.py`, created once in
   `<data>/models/voice-onnx-pyannote-3.1-v2`). Same voice space, no transfer. Measured on Rec54
   (5 m 30 s): pyannote on the CPU 129 s, ONNX with the embedder on the RX 6600 XT 31 s, identical
   segments and embeddings (cosine 1.000000, 100% same speaker per 0.1 s). The RX 6600 XT also draws
   the screen, and a GPU call cannot be interrupted, so DirectML has to be proven before it is used:
   a probe of 20 single-chunk calls (10 s of audio each) must stay under 50 ms per call on that exact
   GPU (RX 6600 XT: 6.9 ms worst), the verdict is stored per GPU fingerprint, and until then the engine
   runs on the CPU. In a run every call carries one chunk; a call over 50 ms, or any DirectML failure,
   moves the rest of the recording (and later ones) to the CPU. One local voice job runs at a time in
   the process (queue lanes, export, probe), at below-normal priority with the thread budget. The
   export goes to a staging folder, fails on any mismatch with PyTorch, and is published with a
   manifest only when complete. A 32-chunk batch froze the machine on 24-sep; that path does not
   exist any more. `signatures-from-turns` is still to build.
3. **Provider registry and online transcribers.** OpenAI, AssemblyAI, Meta Muse, pyannoteAI; the
   existing Gemini moved into the registry; encrypted keys; chunk relabelling by voice.
4. **`pyannoteai` engine and voiceprints.** Separate voiceprint table, identify on each recording.
5. **Model Host on the RTX 4090.** Rebuild the installer from phase 1 code (the 0.1.0 build still
   defaults to community-1 and ignores `model=`), install, pair and validate against the same
   benchmark.
6. **Diarization benchmark on the owner's recordings.** 5 to 10 recordings with known speakers;
   speaker-attribution error, cost and time per engine and provider; the recommended defaults follow
   the numbers.
