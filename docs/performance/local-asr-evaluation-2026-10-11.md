# Local ASR evaluation — 11 October 2026

Current measured accuracy and integration status are maintained in
[Observed transcription accuracy](asr-observed-accuracy-2026-10-11.md). Sections below include historical
checkpoints; statements that a candidate was not yet exercised describe their checkpoint, not the latest run.

Scope: speech transcription, separate from Clef / Clef Flash decision extraction. Execution target is
native Windows GAMESTATION, RTX 4090, 32 logical processors and 64 GB RAM. HiDock runs on the client.
No production transcript or Gemini request is needed for the short installation/benchmark tests.

## Recency and selection

The requested two-week window is 27 September–11 October 2026. An updated model card or runtime does
not establish that the weights were released in that window. These are candidates available now,
not a claim that every candidate was released in the last fortnight.

| Candidate | Intended role | Important constraint |
| --- | --- | --- |
| NVIDIA Parakeet TDT v3, ONNX INT8 | Bounded CPU ASR baseline | Batch adapter; window timestamps, no speaker identity |
| Qwen3-ASR 0.6B, ONNX INT8 | Small multilingual CPU baseline | Batch adapter; automatic language detection |
| Moondream Parakeet Ultra | GPU ASR for the 4090 | Released 22 September, outside the strict fortnight; actual native Windows CUDA inference observed |
| Qwen3-ASR 1.7B, Photon | Larger multilingual GPU candidate | Actual native Windows CUDA inference observed; distinct from Qwen Audio 3.1 cloud service |
| Parakeet Redux | Small CPU candidate | Same 22 September family; not installed in this pass |
| Nemotron 3.5 ASR streaming 0.6B | Priority local streaming candidate | Official NeMo-Speech.cpp provides native Windows installation and realtime WebSockets; not yet integrated/tested in HiDock |
| Voxtral Realtime 4B | Realtime candidate | Separate runtime/session integration needed; no HiDock streaming proof yet |
| Phonon-2 | Recent English-only candidate | Released 29 September, inside the fortnight; not a Spanish meeting replacement |
| Orukeet | Additional Parakeet-family candidate | Released 11 September, outside the fortnight; not installed in this pass |

Primary sources:

- https://moondream.ai/blog/introducing-parakeet-redux-and-ultra
- https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- https://huggingface.co/Qwen/Qwen3-ASR-0.6B
- https://github.com/QwenLM/Qwen3-ASR
- https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html
- https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b
- https://docs.mistral.ai/studio/audio/overview
- https://qwenaudio.github.io/qwen-audio-3.1-asr/
- https://www.fermionresearch.com/changelog/
- https://oruk.ai/research/orukeet

Photon live input is not equivalent to subsecond cached streaming: the vendor describes first previews
after four seconds and refreshed transcript snapshots every two seconds. HiDock's current new adapters
return batch results and explicitly report `streaming: false`.

## Measured short Spanish comparison

Fixture: sherpa Qwen example `test_wavs/es1.wav`, 5.15 seconds, 164844 bytes,
SHA-256 `4543f94738445a38306fb80bb0329ef5ca6d81ab1b6c3f15af1de1c3382f4b31`.
Reference: “Esta prenda es amplia, recomiendo elegir una talla menor a la habitual.”

| Actual HTTPS job | Device | Worker wall time | Job creation to completion | Result |
| --- | --- | ---: | ---: | --- |
| Parakeet TDT v3 | CPU | 1.328 s | 1.548 s | Exact reference text |
| Qwen3-ASR 0.6B | CPU | 2.437 s | 2.677 s | Recognition errors; not equivalent to reference |

Evidence: `.diagnostics/bench-parakeet-result.json`, `.diagnostics/bench-qwen-result.json`.
These requests used the authenticated production HTTPS job/upload/result API and installed models.
They did not exercise a recording through the client's full pipeline. One short phrase cannot establish
comparative meeting quality, accent robustness, speaker separation or long-recording reliability.

Both CPU tests enforced 16 threads, 50% CPU budget, below-normal priority and approximately 16 GB maximum
worker memory. They ran on GAMESTATION, not the client. Short health samples can miss peak memory/GPU
usage, so they are not peak-resource benchmarks.

## Admission and correctness

- A model is advertised only after an actual spoken-audio test passes. Worker/runtime changes invalidate proof.
- Remote selection checks capabilities before upload; an unavailable worker/model does not silently run locally.
- Preparation is separate from inference; inference requires prepared local checkpoints.
- Worker input is normalized through bounded ffmpeg work and processed in bounded windows.
- No fabricated speaker identity. Unresolved speakers remain unresolved.
- Clef and audio share admission; a resident decision model must exit before audio starts.
- A real Windows preparation test exposed the embedded interpreter's missing script path. The adapter now
  adds its own directory explicitly. JSON uses ASCII escapes to preserve Unicode across Windows pipe encodings.
- Photon requires CUDA runtime 12.8+; the existing host torch is 2.13.0+cu126. Its adapter uses a separate
  pinned torch 2.9.1+cu128 overlay, retaining the existing diarization/Cohere torch installation.
- The new adapters prefer quiet boundaries with at most two seconds read for split selection. Continuous
  speech can still require a hard cut; this is not a claim of seamless longform accuracy.

## Real client service and GPU evidence

Final installed-worker comparison, same 90-second Spanish meeting excerpt:

| Model | Execution on GAMESTATION | Client wall time | Worker wall time |
| --- | --- | ---: | ---: |
| Parakeet TDT v3 | CPU | 4.091 s | 3.125 s |
| Qwen3-ASR 0.6B | CPU | 12.178 s | 11.375 s |
| Qwen3-ASR 1.7B | RTX 4090 CUDA | 9.161 s | 7.266 s |
| Parakeet Ultra | RTX 4090 CUDA | 6.110 s | 4.235 s |

All four were advertised together after explicit final readiness tests; the host finished ready with no active
jobs. Final evidence: `.diagnostics/asr-client-boundary/final-summary.json`, `final-capabilities.json`,
`final-health.json`, and the individual `report.json` files. The final Ultra run is in
`ultra-final-meeting-90s/`; the Qwen CPU runs are `qwen06-final-short/` and `qwen06-final-meeting-90s/`.
Qwen 0.6B's final short phrase still contains recognition errors after fixing Windows JSON encoding.
It is an available smaller baseline, not a demonstrated quality winner.

Parakeet Ultra processed a 90-second slice of a real Spanish meeting through the original client services
(`resolveAudioRoute`, authenticated HTTPS transport, `runRemoteWorkerJob`, checkpoints and result validation).
The client routed to GAMESTATION CUDA and returned 11 segments / 1004 characters in **6.162 seconds**;
worker inference took **4.203 seconds**. Original profile/configuration hashes remained unchanged.
Evidence: `.diagnostics/asr-client-boundary/ultra-meeting-90s/report.json`.
This exercises actual client-to-host integration, not the production window's complete processing pipeline.
There is no human reference for this excerpt, so speed is measured but WER/quality ranking is not.

Qwen3-ASR 1.7B processed the same 90 seconds in **9.161 seconds** through the real client services;
its worker took **7.266 seconds**, returning 4 audio-window segments / 1042 characters. The 5.15-second
Spanish reference phrase was exact (8.146 seconds client / 5.953 seconds worker). Both ran CUDA and left
the original profile unchanged. Evidence: `.diagnostics/asr-client-boundary/qwen17-short/report.json` and
`.diagnostics/asr-client-boundary/qwen17-meeting-90s/report.json`.
Qwen's timestamps here describe input windows, not word alignment; Ultra supplies model/word timings.
The first preparation exposed inadequate KV-cache capacity; the bounded single-request cache was increased
to 8192 pages and the actual preparation and both requests then passed.

Parakeet TDT v3 CPU processed the same 90 seconds in **4.091 seconds client / 3.125 seconds worker**,
returning 4 audio-window segments / 942 characters under the 16-thread, 50% CPU resource policy.
Evidence: `.diagnostics/asr-client-boundary/parakeet-meeting-90s/report.json`.
This one-shot comparison includes per-job model loading and client polling;
it is not a steady-state GPU throughput ranking. No conclusion about relative recognition quality follows
from the different character counts.

A real Clef Flash request followed by Ultra ASR completed in **23.718 seconds**. Clef took 17.661 seconds.
Sampled VRAM fell from **18,619 MiB to 319 MiB** before the audio handoff, then rose to 2,065 MiB at completion.
Both decision models reported on-disk, audio returned CUDA and the result hash verified. The remote worker
PID was not directly observed; the evidence is API state, actual GPU memory release and the returned audio result.
Evidence: `.diagnostics/spec013-decisions/clef-ultra-handoff.json`.

## Installation and selection

The current native Windows installer is `apps/model-host/build/HiDock-Model-Host-0.4.3-Setup.exe`.
Model preparation downloads the explicitly selected checkpoint and runs a spoken-audio readiness test.
Preparation temporarily pauses the host; do it between jobs. A failed test leaves that model unavailable.
Installing a runtime or copying weights alone does not mark a model ready.

In the updated client, prepare the model in Model Host settings, then select **Remote worker** as the
transcription provider and choose the explicit ASR model. Test the connection after selection finishes saving.
Parakeet TDT v3 and Qwen 0.6B run bounded CPU inference on the remote host; Ultra and Qwen 1.7B use its CUDA GPU.
The client does not automatically replace the user's current provider. If the host/model is unavailable,
capability validation fails instead of silently starting inference on the workstation.

The client update is staged separately. At this checkpoint the running production HiDock process has not
been restarted or replaced; applying it awaits the user's answer to the normal-idle-restart question.
The selector was exercised in an isolated rendered Electron UI, including save failure and selection/test
ordering. This does not prove it is already available in the user's currently running window.

## Remaining acceptance boundaries

Apply the staged client and observe selection/persistence and processing from its production UI.
Realtime transport/session support remains separate work; faster-than-audio batch execution is not streaming.

## Follow-up: Audio8, Nemotron 3.5 and MAI (11 October)

The findings below preceded the Nemotron implementation; see the subsequent native verification section for its current evidence. Audio8 and MAI remain research candidates.

- **Audio8 ASR Infinite**: open weights, Apache-2.0, native streaming, selectable 240–560 ms configured delay.
  The publisher declares Chinese/English, not Spanish. Its rolling-cache continuous deployment uses a
  customized vLLM/Docker stack; a native Windows continuous-streaming deployment is not established here.
  Keep it as an English/Chinese experiment rather than a Spanish meeting default.
  Sources: https://huggingface.co/Edge0/Audio8-ASR-Infinite and
  https://github.com/Edge0-AI/Audio8-ASR-Infinite .
- **NVIDIA Nemotron-3.5-ASR-Streaming-0.6B**: downloadable weights, cache-aware streaming and Spanish
  es-US/es-ES in the transcription-ready tier. The official NeMo-Speech.cpp runtime supplies Windows
  installation, CPU/CUDA-capable native execution, a local server and realtime WebSocket transcription.
  This materially improves its fit for the native Windows host compared with assuming a NeMo/Python stack.
  Prioritize an isolated bounded Windows test followed by actual incremental/final-event validation.
  Sources: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b and
  https://github.com/NVIDIA/NeMo-Speech.cpp . Published speed figures are vendor measurements, not ours.
- **Microsoft MAI-Transcribe-2**: hosted transcription via Foundry; no downloadable local weights found
  in the official sources checked. Supports Spanish, diarization, word timestamps and keyword biasing.
  Advertised introductory rate: USD 0.10/audio-hour. Its model card is dated September 3.
  **MAI-Transcribe-2-Streaming** launched October 1, inside the requested fortnight, and is a distinct
  cloud/public-preview integration. Advertised introductory rate: USD 0.54/audio-hour; the comparison
  explicitly excludes diarization, word timestamps and keyword biasing for this variant. Do not inherit
  batch capabilities into a streaming adapter. No billable request was made in this investigation.
  Sources: https://microsoft.ai/models/mai-transcribe-2/ ,
  https://microsoft.ai/pdf/MAI-Transcribe-2-Model-Card.pdf ,
  https://microsoft.ai/news/our-first-streaming-transcription-model/ and
  https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming .

Integration priority from these findings: Nemotron for local Spanish realtime; MAI as a separately configured
cloud candidate; Audio8 conditional on English/Chinese requirements. Benchmark all candidates on the same
audio with a human reference before selecting by accuracy. Actual streaming acceptance also requires
incremental results before end-of-audio, bounded memory, cancellation and disconnect cleanup.

## Nemotron native Windows verification (11 October, evening)

Model Host 0.4.3 is deployed on GAMESTATION with the pinned official NeMo-Speech.cpp 0.2.0
Windows CUDA runtime and the Q8_0 Nemotron checkpoint. The actual client HTTPS/job services returned
the 5.15-second Spanish reference phrase correctly (ignoring punctuation/case) in 1.053 seconds client
wall time / 0.531 seconds worker time. Original production profile hashes remained unchanged.

The native realtime boundary also passed with a five-second English speech sample: binary PCM sent at real-time speed produced its first
nonempty partial after 466 ms, before the input ended; commit returned a final result. A second session
acknowledged cancellation, produced no final after clearing, and both sockets closed. The bounded
server process exited after the harness terminated it. Evidence: `.diagnostics/nemotron-streaming/native-proof.json`.
This is a runtime WebSocket proof, not a claim that HiDock's live microphone UI is implemented.

The 90-second meeting exposed a native alignment defect: in a 44.79-second chunk, the last word was
reported at 45.04–45.12 seconds. The original adapter rejected the entire result. A correction is being
validated: preserve the text, fall back explicitly to real input-window bounds for that chunk, and omit
unreliable word timings rather than clamp or invent alignment. The initial failed job is
`49e65fca-57e6-4225-863e-e99f1a80a01a`; the numeric diagnostic reproduction is
`7849953b-2f56-4ad8-9e80-835f7627729b`. Long-audio acceptance remains pending at this checkpoint.


### Corrected long-audio result

After deploying the corrected 0.4.3 package, the same 90-second real Spanish meeting completed through
actual client services in **3.098 s client / 2.453 s worker**, on GAMESTATION CUDA. It returned two segments
and 913 characters; one chunk explicitly uses audio-window bounds with a 0.33-second native-tail warning,
while the other retains native word timings. No published timestamp exceeds its audio window.
Evidence: `.diagnostics/asr-client-boundary/nemotron-meeting-final/report.json`, job
`acfb71e4-bff7-47fd-ae66-64932a134433`. The short reference phrase passed again after this patch:
1.053 s client / 0.578 s worker, job `603483e4-a0c8-4fb3-902b-c63a3c2f2ee2`.
Both runs preserved original profile hashes. There is no human reference for the meeting excerpt;
these timings do not establish a recognition-quality winner.

Eleven adapter tests and seventeen host ASR/readiness tests passed. Independent review also found and
corrected segment end containment for overlapping native word intervals, and renamed configured thread
budget so it is not presented as measured native thread count. Final native WebSocket preparation passed
again (`nemotron-streaming-1791765452313.json`). The host finished ready with no active jobs and continued
advertising Cohere, Parakeet TDT v3, Qwen 0.6B, Ultra and Qwen 1.7B alongside Nemotron.

The client selector/build remains staged: the running production app was not restarted or changed.
Its pending normal-restart authorization and the separate full live-capture UI remain outstanding.

## Added candidates: MOSS, Nemotron diarization, Meta Muse (11 October)

Verified primary sources; none of these three additional engines has been deployed or benchmarked here.

| Candidate | Role | Execution evidence / integration implications |
| --- | --- | --- |
| OpenMOSS-Team/MOSS-Transcribe-Diarize 0.9B | Joint ASR, anonymous speaker labels, segment timestamps | Apache-2.0 downloadable weights; publisher declares 50+ languages and reports Spanish in multilingual evaluation. Reference Python/Transformers path exposes SDPA. Native Windows compatibility and peak GPU/RAM use remain untested. Long-form capability is not evidence of incremental realtime audio support. |
| nvidia/Nemotron-3-Diarization | Diarization only, not an ASR model | 100M parameters, up to eight speakers, offline and streaming. Publisher documents a native NeMo-Speech.cpp route as well as NeMo/Transformers. Candidate to reuse installed native runtime, but exact installed binary/model compatibility still needs testing. Distinct from Nemotron-3.5-ASR-Streaming-0.6B. |
| muse-voice-transcribe-1.0 | Hosted ASR plus diarization and realtime audio | Meta API, 25 languages including Spanish, advertised 20+ speakers and USD0.18/audio-hour. No local weights found in the checked sources. Turn timestamps only; file endpoint max10minutes/32MB. Speaker labels are session-scoped, so chunk labels must never be globally merged by their literal label. API credentials and actual paid boundary test remain outstanding. |

Priority: evaluate MOSS on completed Spanish meetings and Nemotron diarization paired with existing ASR.
Treat Muse as a separately configured cloud candidate. Preserve the existing selected engines until actual
representative benchmarks establish accuracy and resource fit. Generic speaker labels are not verified identities.

MOSS reference implementation explicitly warns that eager attention memory grows quadratically with audio
length. First tests must use bounded clips, SDPA, isolated runtime and one job at a time; the 0.9B parameter
count alone is not a peak-memory guarantee. Do not copy example service settings reserving80%VRAM and
16concurrent requests into this host.

Release dates: MOSS July9; Nemotron diarization September23; Muse September1. These initial releases are
outside the September27–October11 fortnight; newer repository activity must not be presented as a new model release.

Sources checked:
- https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize
- https://github.com/OpenMOSS/MOSS-Transcribe-Diarize
- https://huggingface.co/nvidia/Nemotron-3-Diarization
- https://research.meta.ai/blog/introducing-muse-voice-transcribe
- https://dev.meta.ai/models/muse-voice-transcribe
- https://dev.meta.ai/docs/speech-to-text
