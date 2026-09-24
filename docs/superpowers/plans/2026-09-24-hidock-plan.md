# HiDock plan: every open ask, with status and next step

Written 24-sep-2026 at the end of a long session (Claude session `5459dc3e`). It gathers every request
Sebastián made in that session and the open items of the 23-sep inventory
(`G:\Code\_briefing\projects\hidock-inventario-pedidos-2026-09-23.md`). Each row says what is done
with its evidence, or what comes next, with an owner and a date. Owner is Claude unless the row says
otherwise. Dates are proposed; the board card `hidock_inventario_pedidos_20260923` tracks them.

Specs this plan points to:

- `docs/superpowers/specs/2026-09-24-speaker-engines-design.md` (voice recognition on any hardware)
- `docs/superpowers/specs/2026-09-24-recording-checks-design.md` (audio checks, audio index, splits)
- `docs/superpowers/specs/2026-09-23-transcript-integrity-design.md`
- `docs/architecture/feature-gating.md`

## Done this session (merged to main)

| PR | Ask | Evidence |
|---|---|---|
| #35 | Voice recognition setup per hardware, one recommended option, red warning to turn it off, asks only when a GPU is added or removed | Real build on a library copy: dialog at boot with the AMD hardware, unbuilt options disabled. Voice model pinned to the library's (pyannote 3.1), locally and on the Model Host. 6,148 app tests and 43 Model Host tests |
| #35 | Explain community-1 | It never produced a voice: every attempt failed (gated on Hugging Face, timeouts, load errors). Spec section "Voice identity across hardware" |
| #36 | Library showed 0 sources with Device Sync off | 8 FeatureDisabledError per launch before, 0 after; contract in `docs/architecture/feature-gating.md` |
| #37 | "IT SHOULD NOT BE POSSIBLE TO OPEN TWO! BY DESIGN" | Second launch with another profile quits in about 1 s, no window, the running app comes forward. Electron's lock keyed to `%APPDATA%\HiDock Next\instance-lock` |
| #38 | Silent audio flagged useless, noise catalogued, under 10 s left for manual processing, checks on old recordings, labels in the Library | Library copy: 2,109 recordings profiled in about 2 min 40 s (1,993 speech, 94 noise only, 22 silent); Rec56 shows "Silent". Loudness from MP3 frame gains (4 h in about 46 ms), confirmed by decoding before hiding anything |
| #38 | Freeze on first launch after v58 | 2.2 s main-thread stall in the transcript-integrity backfill, now batched: 0.67 s |

Sebastián's real HiDock has not been opened with this build yet (database still v57). The first
launch runs migrations v58 and v59, labels the transcripts and runs the audio pass in the
background (about 3 minutes).

## 1. Voice recognition on any hardware (speaker engines)

| Item | Status | Next step | Date |
|---|---|---|---|
| ONNX engine for the RX 6600 XT and CPU | **Proven 24-sep, not built.** pyannote 3.1's embedding model (WeSpeaker ResNet34-LM) exported to ONNX with the Kaldi fbank rebuilt from plain ops: cosine 1.000000 against pyannote, 28.3 MB. DirectML on the RX 6600 XT: 0.6 ms per second of audio (CPU 5.7 ms), DirectML and CPU agree (cosine 1.00000). Segmentation-3.0 exported too (5.9 MB, max diff 2e-5 against PyTorch): CPU 1.6 ms per second of audio, DirectML 4.0 ms | Build `onnx-local`: exporter script in the repo, models installed under the data folder, segmentation on CPU, embeddings on DirectML with CPU fallback, clustering as pyannote 3.1 does, same `AcousticWorkerResult`. Same weights, so the 242 voices and 12 people carry over with no transfer | 25-sep |
| Voice signatures from the transcript's turns | Designed | Embed a few seconds per transcriber turn with the same ONNX embedder; shares the sampling with model transfer | 25-sep |
| Long recordings must not block short ones; stage and estimate in the Library | Designed (spec "Long recordings stop blocking short ones") | Queue ordering plus a lane for short recordings; stage and ETA from measured speed | 25-sep |
| Canonical voice IDs and model transfer | Designed | `canonical_voice_id` migration, transfer with hold-out validation, model tag in transcripts | 26-sep |
| Model Host on the RTX 4090 | The source defaults to 3.1 and honours the `model=` pin since #35; the only installer built so far (0.1.0, PR #9) predates that and still defaults to community-1 | Rebuild the installer from main, install and pair it on the 4090 box, benchmark | 26-sep |
| Online providers: Gemini, OpenAI, AssemblyAI, Meta Muse, pyannoteAI; compare diarization and cost | Researched (`docs/superpowers/specs/2026-09-24-diarization-provider-apis.md`) | Provider registry, encrypted keys (moving the plain Gemini and HF keys too), one engine per provider | 27-sep |
| Diarization benchmark on the owner's recordings | Designed | 5 to 10 recordings with known speakers; error, cost and time per engine; recommendations follow the numbers | 27-sep |

## 2. Recording checks and the audio index

| Item | Status | Next step | Date |
|---|---|---|---|
| Player waveform from the stored envelope | Envelope stored per recording (#38) | Draw from it; the old peak cache becomes a fallback | 25-sep |
| Transcribe and diarize only the time ranges with sound | Ranges stored (#38). Rec93: 23 minutes of sound in 4 hours | Send ranges to the transcriber and diarizer, map timestamps back | 26-sep |
| Threshold relative to each recording's noise floor | Rec50 shows 95% "sound" from room noise | Median gain plus margin, checked against decoded audio | 26-sep |
| "Run checks..." on a selection and "Re-process" on one recording | Designed | One registry: audio check, integrity, value, re-transcription, voice re-identification | 27-sep |
| Voice re-identification of old recordings (re-diarize, match known speakers) | Designed | After the ONNX embedder: sample turns per speaker, match canonical voices | 27-sep |
| Audio index and split suggestions (long silence plus change of speakers or topics) | Designed | Voices and topics per range, split candidates, decided by the decision model below | 28-sep |

## 3. Decision model instead of an LLM (Jev, mojev)

Measured 24-sep on the owner's PC (Ryzen 9 7900X3D, 12 threads; RX 6600 XT):

| mojev path | Short text | Transcript (about 2,700 tokens) |
|---|---|---|
| PyTorch on CPU (pinned: commit `a74d58cd`, model revision `0c8695b6`, transformers 5.17.0) | 0.2 s | 4.4 s median, 6.1 s p90 |
| INT4 ONNX export, CPU (onnxruntime-node 1.30) | 1.0 s | 150 s |
| INT4 ONNX export, DirectML | 1.6 s after a 4-minute first compile | stopped after 25 minutes without a result; the export runs its recurrent layers one token at a time |

Agreement with the ratings HiDock's LLM already gave (40 recordings, Spanish): all 20 kept recordings
agreed; only 8 of 20 dropped ones did (mojev called 12 of them normal or high, and never "none").

| Item | Status | Next step | Date |
|---|---|---|---|
| A `decide(state, questions)` seam next to the LLM `complete()` | Not built | Choice / score / noul questions, LLM fallback when confidence is low | 26-sep |
| mojev as the local decider | Runs on CPU (above); no useful GPU path on the RX 6600 XT today; the RTX 4090 Model Host is the fast path | Serve it from the Model Host (CUDA) and on CPU for background work; calibrate the value question on the existing ratings before it decides anything by default | 27-sep |
| Jev (TypeSafe API) as the decider | Chosen by Sebastián for split suggestions; API documented in the recording-checks spec | Opt-in with an encrypted key, because it sends text off the machine; compare with mojev on the same questions | 27-sep |
| Images | mojev's image training is on its roadmap, not released | Revisit when a vision checkpoint exists | open |

Today these ask an LLM for a decision: value classification (`value-classification.ts`,
`value-backfill.ts`), knowledge-graph extraction (`knowledge-graph-service.ts`), meeting
disambiguation when several meetings overlap (`meeting-disambiguation.ts`), and speaker naming
(`speaker-inference.ts`, `self-identification.ts`). Splits are silence heuristics and voice matching
is embeddings. Value, disambiguation and naming are choices among given options, so they are the
candidates for the decision model; summaries, notes and extraction stay on LLMs.

## 4. Transcript quality (card `hidock_transcript_integrity_20260923`)

| Item | Next step | Date |
|---|---|---|
| Link each speech-detector run to its transcript, and run it for the ~1,900 older recordings | Part of "Run checks..." (section 2) | 27-sep |
| Text over silence, invented `end` times, chunk seams | Checks in the integrity rules | 27-sep |
| Default transcription provider | **Sebastián decides**; the provider comparison (section 1) gives the numbers | 27-sep |

## 5. Performance and memory (card `hidock_memoria_perf_20260921`)

Last run of main against the 17-sep baseline: window 6.43 s (baseline 0.98 s), settled 27.5 s,
worst stall 0.71 s, peak main 1.65 GiB (`artifacts/compare-20260924-main/compare.html`, local).

| Item | Next step | Date |
|---|---|---|
| `getTranscriptsByRecordingIds` loads every transcript row at Library mount | Load only the fields the list needs | 25-sep |
| Window at 6 s on a launch that migrates (backup before migration) | Back up after the window shows, or in the background | 25-sep |
| Database open 0.46-0.58 s; semantic index restore 0.57 s | Profile and split | 26-sep |
| The 1 GB memory target; vector store out of the main process (design B, already approved by Sebastián) | Build design B, int8 vectors | 28-sep |
| Profile the app in use (downloading, transcribing, scrolling the Library), not only startup | Extend the harness | 28-sep |
| `WmiPrvSE.exe` uses about one core with HiDock closed | Find the WMI client (the activity log does not name it) | 26-sep |

## 6. Housekeeping

| Item | Owner | Status |
|---|---|---|
| Local branches `feat/speaker-engines` and `fix/library-with-device-sync-off` | Claude | deleted 24-sep after their squash merges (#35, #36); phase 2 starts from main |
| Local branch `build/latest-integration` (all its changes are on main through #18, #19, #21, #26, #32) | **Sebastián**: `git -C G:/Code/hidock-next-2 branch -D build/latest-integration` (the safety hook refuses it to Claude) | open |
| 13 stale `remotes/origin/*` tracking refs in hidock-next-2 (the remote only has main) | Claude: `git fetch --prune` | 25-sep |
| Old repo `G:\Code\hidock-next`: 4 modified uncommitted files (`speaker-linking.ts`, its test, `transcription.ts`, `.gitignore`), an untracked `.playwright-cli/`, 5 extra worktrees | Claude: compare with hidock-next-2, keep what is not there, then clean | 26-sep |
| `.gitattributes` against the repeated CRLF flips (proposed 07-14, never added to either repo) | Claude | 25-sep |
| Flaky `temp-db-tracker` test under load (22-sep) | Claude | 25-sep |
| Half-installed `~` and `~ws-sso-sync` folders in the system Python's site-packages | Sebastián, or a reinstall of `aws-sso-sync` | open, harmless |
| Stale `hidock-db-engine-test-*` files in the system Temp break the engine tests | Claude: make the engine tests use and remove their own folder | 25-sep |
| Diarization runs left `running` when the app quits (22-sep and 23-sep rows) | Claude: close stale runs at boot | 25-sep |
| Commit trailers crediting Claude on older main commits | Stopped; squash merges now carry a clean message. History is not rewritten | done |
| Say "the header declares PCM; the content is MP3", never "corrupted" | Recorded in memory | done |

## 7. Open items from the 23-sep inventory

Unchanged by this session. Each keeps its row in the inventory; the date is the proposed one.

| Item | Owner | Date |
|---|---|---|
| Assistant model picker and the quality roadmap (thinking, `maxContextChunks`, query rewriting, intent routing) | Claude | 29-sep |
| 16 purged audios still on disk (re-import proposed, never raised again) | Sebastián decides: re-import or delete | 25-sep |
| The "shorter than transcript" warning is a toast only, not written to the Activity Log | Claude | 25-sep |
| Real-time transcription (#7, #13, #14) never run with the device recording | Claude, with the device connected | 26-sep |
| Truncated-download recovery (#27) never exercised against the device | Claude, with the device connected | 26-sep |
| D-022 self-repair never observed in an installed build (card `hidock_d022_synced_files_20260922`, in review) | Claude | 26-sep |
| Notes (#10, #11): no walkthrough of the UI | Claude | 26-sep |
| Split suggestion and stale auto-link retract (08-25 defect 3): "repairs itself on next launch" never observed | Claude | 26-sep |
| Reader compaction (#26), the 12 px hysteresis and the cost of five stacked `backdrop-blur`: never checked in the app | Claude | 26-sep |
| Boot stalls named on 07-19 and never fixed: synchronous `reconcileOrganization`, ICS fetch with no timeout | Claude (section 5) | 26-sep |
| 07-14 overnight lanes E (incremental calendar sync), G, H, N and M's closing walk, never started | Claude: re-scope against today's code | 29-sep |
| SPEC-013 resource-aware transcription (`docs/superpowers/specs/2026-09-16-resource-aware-transcription-execution.md`, moved from the archived repo on 24-sep): process priority, stage checkpoints, download backpressure (the CPU-percentage thread budget is built) | Claude: re-scope against today's code | 29-sep |
| Signing the Model Host installer (certificate) | **Sebastián** decides and buys | open |
| Whether the file name always shows in the Library row | **Sebastián** decides | open |
| `ENABLE_REMOTE_DEBUGGING` still present (empty) in the user environment | Claude | 25-sep |
| Shared MCP HTTP server proposal (`geraldes-plugins` `950e300`; the plugin was disabled on 18-sep) | Sebastián decides whether it is still wanted | open |
| Card `hidock_frozen_20260918` (blocked) | Claude: close or reopen with today's evidence | 25-sep |
| Cards `ops_hidock_bridge_down_20260819`, `ops_hidock_sin_link_20260827`, `hidock_deps_vitest5_electron44_20260916` | Claude | 26-sep |
