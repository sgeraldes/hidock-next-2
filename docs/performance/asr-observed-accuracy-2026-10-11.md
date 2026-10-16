# Observed transcription accuracy — 11 October 2026

Status: partial evaluation. No production default has been changed. This report separates observed
inference from published claims and source-only integrations. Remote-model benchmark jobs run sequentially
on GAMESTATION; the Gemini baselines invoke the configured cloud API from an isolated client harness.

## 12 October: bounded older-library resource comparison

The user's current boundary excludes processing recordings from **11–12 October** and requires automatic
connection/download to remain off. The active competing recovery profile was inspected with both flags
false; the dormant production profile still had both true and was **not changed**. Do not infer that all
profiles have been disabled. The following comparison processed **zero recent recordings**, made **zero
cloud calls**, wrote no production database rows, and delivered no new audio or transcript for review.

Two sequential paired-HTTPS jobs used the same unchanged five-minute **21 August** library recording:

| Engine / actual worker device | Client wall | Worker wall | Sampled whole-host CPU peak | GPU peak | Used VRAM peak |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen 1.7B / CUDA | 18.440 s | 11.344 s | 8.14% | 100% | 10,509 MiB |
| Parakeet v3 / CPU | 10.104 s | 7.860 s | 36.33% | 0% | 283 MiB |

After host **0.5.2** was applied, a third remote ASR job repeated Parakeet on the same older source:
**10.117 s wall**, worker policy CPU 16/32 threads at 50%, below-normal priority, 16,209 MiB Job memory.
Text matched the pre-update result. Its whole-result hash changed with timing metadata, which is expected.
Host returned to zero active jobs; all eight ASR and semantic/text-generation/realtime capabilities remained
ready. Total new remote ASR jobs were **3**, with **0** cloud calls/recent recordings and no automatic-setting
changes. [Applied update verification](../../.diagnostics/host-052-verification.json).

Telemetry samples were two seconds apart and include unrelated host processes. They are not per-worker
attribution or guaranteed instantaneous maxima. Both final samples had zero active jobs. This proves
execution/resource observations through the host job API, not app-queue, USB or full enrichment acceptance.

No independent reference exists for this clip, so it has **no WER score**. Scalar signal analysis found
56.35–163.87 seconds had very low energy (approximately −67 dBFS RMS); this does not classify every earlier
localized sound as intelligible speech. Qwen emitted repeated short text and CPU Cohere earlier emitted
unrelated repeated boilerplate over low-energy material: these are **possible hallucinations**, not validated
coverage. No Parakeet adapter/window-dropping defect was demonstrated. A segment spanning 0 to the final
timestamp does **not** prove lexical completeness. Prior successful Cohere CLI execution does not establish
transcript accuracy or completeness.

The existing two reviewed excerpts still total **119 normalized words**. Rescoring did not change their
results: Gemini remains best **within that scoped review**, at **1.68% WER**. The production default was
not changed. Neither these two reviewed excerpts nor the unscored older clip supports a global winner claim.

Evidence: [resource comparison](../../.diagnostics/remote-long-resource-20261012/report.json) and
[coverage investigation](../../.diagnostics/remote-long-resource-20261012/coverage-investigation.json).
## Earlier rollout evidence

Host 0.4.7 was installed on GAMESTATION and its HTTPS health response confirmed ready, eight available
ASR engines, native Nemotron diarization and no active jobs. Post-install spoken-audio validation passed
for Audio8 on RTX 4090 and native Nemotron diarization on CUDA. Installed worker and server hashes match
source. Client changes were applied on 12 October to the running checkout application after an idle-queue,
graceful shutdown. Actual settings interactions verified eight ready remote ASR choices, unavailable
VibeVoice disabled, native Nemotron diarization selectable and MAI/Muse credentials shown as unconfigured.
Gemini remains selected. MAI/Muse credentials and broader meeting accuracy remain outstanding.
Evidence: `.diagnostics/asr-final047-health.json`, `asr-deployment-manifest.json`, and
`.diagnostics/asr-client-rollout-ui-*.json`.

The matching Windows client installer was then built, passed packed-Electron SQLite loading, and was
installed successfully. The normal desktop executable is running with the existing profile. Its
authenticated brain health matched the launched PID/instance, and the main window finished loading.
Active packaged bundles match those exercised in the checkout settings UI. No additional model calls
were needed for this rollout. Evidence: `.diagnostics/asr-installed-client-verification.json`; installer
SHA256 `7c18674821199530f4ff74da35175459d221c6f2f40f6827dff608cb30233842`.

## Spanish comparison

### Follow-up using the user's actual library

Six distinct library recordings were read without database writes. Fixed 120–150 second excerpts were
frozen before new model output: four tagged Spanish, two tagged English, 180 seconds total. Seven local
ASR engines completed all six; Audio8 completed the two English clips; Gemini completed six cloud calls
without retries. All **50/50 requests succeeded**. Original recording and fixture hashes remained unchanged.
Initially these runs established execution only. The user subsequently reviewed two excerpts, whose
scoped accuracy is recorded below; the other four remain unscored. Gemini remained selected. Existing
AI-generated library transcripts were not accepted as ground truth without user review.
MAI/Muse remain blocked by absent credentials. The user requested no additional audio/text review deliveries.

Evidence and audio-backed review: `.diagnostics/asr-library-evaluation/manifest.json`, `local-results.json`,
`gemini/hypothesis.json`, `verification.json`, `comparison.html`, and initially blank `review.html`.
These six short windows do not establish full-length meeting or continuous-streaming quality.

### User-reviewed library excerpts

The user subsequently reviewed library-01 with Gemini's hypothesis visible: MCP is a confirmed omission;
the cropped first word is indeterminate; the rest was accepted. The evaluated lexical span starts at the
unique confirmed word directamente for every model, excluding all preceding hypotheses without a new
inference run. The corrected reference has 64 normalized words. WER: Gemini 1/64 = 1.56%, MOSS 4/64 =
6.25%, Qwen 1.7B 6/64 = 9.38%, Ultra 10/64 = 15.63%, Cohere 13/64 = 20.31%, Qwen 0.6B and Nemotron
14/64 = 21.88%, Parakeet v3 18/64 = 28.13%. Treating ok/okey/okay equally yields MOSS 2/64 = 3.13%,
Ultra 12.50%, Cohere 18.75%, Parakeet 26.56%; other rates stay unchanged. Both score modes are retained.
No model rendered MCP correctly. Evidence for this first excerpt: `human-review-library-01.json`,
`reviewed-library-01-scores.json`, and `score-reviewed-01.py` in `.diagnostics/asr-library-evaluation/`.

For library-02, the user identified the sole lexical correction `solté` → `setié` and accepted the
remaining lexical content. The reference has **55 normalized words**, not 64. Punctuation and other
unspecified details were acknowledged but not annotated: these results do not claim strict surface
accuracy. Gemini has one substitution, 1/55 = 1.82% WER. No further inference was performed.

The following aggregate includes **only these two reviewed spans**, totaling 119 normalized words and
612 normalized characters. Counts are summed before division. Library-01 retains its original
`directamente` anchor policy; library-02 includes its entire accepted lexical span. Speaker labels are
excluded using segment text. The four unreviewed library clips and the public Spanish pilot below are
excluded from this aggregate.

| Implemented engine | Reviewed-two WER | Reviewed-two CER |
|---|---:|---:|
| Gemini 3.5 Transcribe | 2/119 = 1.68% | 7/612 = 1.14% |
| Qwen 1.7B | 20/119 = 16.81% | 72/612 = 11.76% |
| MOSS | 20/119 = 16.81% | 65/612 = 10.62% |
| Cohere | 24/119 = 20.17% | 68/612 = 11.11% |
| Ultra | 28/119 = 23.53% | 91/612 = 14.87% |
| Parakeet v3 | 29/119 = 24.37% | 94/612 = 15.36% |
| Nemotron ASR | 31/119 = 26.05% | 106/612 = 17.32% |
| Qwen 0.6B | 37/119 = 31.09% | 115/612 = 18.79% |

The existing equal-treatment `ok`/`okey`/`okay` sensitivity yields MOSS 18/119, Cohere 23/119,
Ultra 26/119 and Parakeet 28/119 word errors; other totals remain unchanged. Base scores are retained.
These are user-reviewed corrections with Gemini's hypothesis visible, not blind independent
transcriptions. They support a scoped observed advantage for Gemini on these two excerpts, not global
accuracy, speaker attribution quality or an automatic default change. No further audio/transcript
delivery or review request is part of this analysis. Evidence: `human-review-library-02.json`,
`reviewed-library-02-scores.json`, `reviewed-library-aggregate.json`, and `score-reviewed-02.py`.

### Fixed public Spanish pilot

The fixed FLEURS es_419 test sample contains 30 unique clips, 400.68 seconds, 853 normalized words and
4,998 normalized characters. Human dataset references were fixed before inference. Normalization removes
punctuation and folds case, but preserves accents and numeric forms. CER includes spaces. WER/CER use
summed edits divided by summed reference units, not an average of clip percentages.

| Implemented runtime | Completed | Normalized WER | Normalized CER | Summed client job time |
| --- | ---: | ---: | ---: | ---: |
| Gemini 3.5-transcribe, cloud baseline | 30/30 | 2.11% | 0.48% | 165.5 s |
| Parakeet TDT v3, ONNX INT8 CPU on GAMESTATION | 30/30 | 2.70% | 0.88% | 62.0 s |
| Parakeet Ultra, Photon CUDA, corrected optional alignment | 30/30 | 3.17% | 0.80% | 182.9 s |
| Qwen3-ASR 1.7B, Photon CUDA | 30/30 | 3.52% | 1.02% | 243.9 s |
| Cohere, CUDA, corrected UTF-8 transport | 30/30 | 3.63% | 1.00% | 455.3 s |
| MOSS Transcribe Diarize, BF16 SDPA CUDA, transcript-only degradation | 30/30 | 4.92% | 1.26% | 252.0 s |
| Nemotron 3.5 ASR, native Q8 CUDA | 30/30 | 6.57% | 2.52% | 31.5 s |
| Qwen3-ASR 0.6B, ONNX INT8 CPU on GAMESTATION | 30/30 | 10.20% | 4.24% | 123.3 s |

Failed clips count as complete deletions; they are not dropped from accuracy denominators. Ultra rejected
one optional word-alignment payload; the corrected adapter completed a fresh 30/30 run. The formerly
failed clip now preserves its full transcript and explicitly reports unavailable invalid word alignment,
without inventing or clamping word times. MOSS originally rejected four outputs without speaker labels:
26/30 succeeded, WER 20.05%, CER 16.61%, with failed clips counted as deletions. Structural diagnostics
confirmed complete timestamped text and EOS, not truncation. The corrected adapter accepts fully valid
unlabeled text while marking diarization degraded; mixed/malformed grammar remains rejected. A fresh
30/30 run yielded 42/853 word edits and 63/4998 character edits. Four clips (11 segments) lack speaker
labels; no speaker identity was invented. Client time totals 252.014 seconds (median 8.1455 seconds),
worker time 108.485 seconds. MOSS reports language auto, requested es, languageHintApplied false.
Original outputs and scores remain preserved. Cohere's original Python stdout used a Windows encoding while the host decoded
UTF-8: corrupted hypotheses cannot measure recognition quality. These results are retained, not repaired
from the reference. Its fresh run uses the deployed UTF-8 correction in host 0.4.6 and completed all 30
clips with zero U+FFFD replacement characters: 31 word errors and 50 character errors. Ultra's preserved
pre-correction result was 29/30, WER 5.51%, CER 3.10%; it is not used as the corrected runtime's score.
Audio hashes and
unchanged input files were verified for every fresh result.

Times include per-clip worker startup, routing and polling, with potentially warm OS file caches. They do
not measure a persistent streaming server. Runtime precision and implementation are part of each result.

Gemini made 18 word errors versus Parakeet's 23. A paired utterance bootstrap (10,000 resamples, fixed seed)
gives Parakeet minus Gemini +0.586 percentage points, 95% percentile interval −0.505 to +1.935 points.
This small sample does not establish a reliable quality winner or represent long Spanish meetings.

For the measured Spanish sample, Parakeet TDT v3 is the provisional local choice: lowest word error among
the completed local runs, with all 30 clips successful. Gemini remains the current production choice and
has the lowest measured WER overall. Final default selection remains pending incomplete candidate
verification and representative meeting acceptance. A native runtime streaming test does not imply the
HiDock microphone UI has a complete realtime integration.

## Other acceptance boundaries

- Audio8: initial Windows loading failed with native access violation and then explicit commit-limit
  evidence. Official per-tensor `pread` loading, both indexed weight shards, strict state validation and
  an Audio8-only adaptive budget passed a real RTX 4090 speech test. The budget is at most 24 GiB,
  37.5% of physical RAM, and half free RAM; admission below 20 GiB is rejected. Other models retain their
  existing budget. The English benchmark completed 30/30 with 15.73% WER and 7.33% CER. Spanish is unsupported
  by this adapter/model declaration and is rejected before audio upload.
- MAI-Transcribe 2 and Meta Muse: adapters and isolated settings persistence were exercised, but actual
  provider requests remain blocked by missing configured credentials. No measured accuracy is claimed.
- VibeVoice remains a selectable remote catalog entry, but no matching completed FLEURS accuracy report
  was present in the saved comparison runs at this audit. Its inclusion in the selector is not evidence
  that it passed the requested accuracy benchmark; this candidate remains an explicit coverage gap.
- Diarization: six fixed 30-second AMI meeting excerpts are prepared for pyannote 3.1, Nemotron 3
  Diarization and MOSS. Pyannote completed 6/6: 27.528 error seconds / 135.93 reference speaker seconds
  = 20.25% DER. DER includes overlap with zero collar; the reference contains manually annotated words,
  so silence-boundary disagreements count. This is not the publishers' AMI recipe. Native Nemotron's
  first request was rejected before job creation because runtime validation was no longer current.
  After successful CUDA revalidation, three of six Native Nemotron excerpts failed segment validation.
  Its 13.85% DER describes only the three completed excerpts (9.376 / 67.71 speaker seconds), and cannot
  be ranked against the six-excerpt results. Neither a rejected request nor an unavailable runtime is a
  recognition result.
  A source-grounded correction for the pinned runtime's 10 ms padded final frame then completed a fresh
  6/6 run: **17.23% DER** (23.426 / 135.93 speaker seconds). All three formerly failing clips preserved
  `nativeEnd: 30.01`, published `end: 30.0`, and explicit 10 ms padding-adjustment provenance. Larger
  overshoots and malformed segments still fail. Historical runs were preserved separately.
- Explicit remote routing: all nine catalog models were exercised against an actually closed loopback
  HTTPS port. None silently returned a local/cloud route. This is a TCP-refusal test, not a real host
  shutdown test of the complete production queue.
- New client selectors are staged in `.diagnostics/asr-staged-build/`. The renderer entry references the
  updated Settings bundle containing cloud credentials, native diarizer selection, and the Audio8 language
  warning. Isolated browser interactions and actual isolated IPC/config persistence were exercised; the
  running production application has not been restarted to load them. The older
  `.diagnostics/asr-deployment-manifest-host043-historical.json` references host 0.4.3 and an older tree.
  The current `.diagnostics/asr-deployment-manifest.json` records the canonical staged client artifacts.
- MOSS degraded results were replayed from actual saved CUDA output through production client validation,
  normalization and quality assessment. Text and segments were preserved and the ledger completion payload
  remained degraded, with no invented speaker identity. This isolated replay did not write the live database.
  Evidence: `.diagnostics/asr-moss-result-boundary/report.json`; 18 focused client tests also passed.

The changed host passed 194 tests across 22 files with one test worker. This regression result supplements,
and does not replace, the actual model runs above.

## Evidence

### English comparison

Audio8 and Gemini used the same 30 FLEURS en_us clips: 280.38 seconds, 642 normalized words and
3,600 normalized characters. Audio8 completed 30/30 with 101 word edits (15.73% WER), 264 character
edits (7.33% CER), and 446.44 seconds of summed client job time. Gemini completed 30/30 with 27 word
edits (4.21% WER), 62 character edits (1.72% CER), and 162.00 seconds. Audio8's summed worker time
was 272.28 seconds; median client job time was 14.16 seconds. Fresh worker/model startup is included.
No encoding corruption was observed and input audio hashes were verified. This pilot does not support
replacing Gemini with Audio8. It does not measure continuous microphone streaming latency.

Evidence: `.diagnostics/asr-client-boundary/accuracy-d6d27b64e0bd-audio8-final/` and
`.diagnostics/asr-gemini-boundary/fleurs-enus/`.

### MOSS meeting pilot

MOSS completed all six English AMI excerpts: 20.73 error seconds / 135.93 reference speaker seconds =
15.25% DER. Normalized WER and concatenated minimum-permutation speaker WER both equal 12.73%; CER is
8.48%. The human annotation contains 353 lexical entries, expanded by the fixed punctuation normalization
to 377 reference tokens (for example, apostrophes and hyphens split words). The denominator depends only
on the reference. Including eight boundary-crossing reference words yields 385 tokens and 12.21% WER/cpWER,
7.89% CER. This sensitivity analysis does not trim or repair generated text. Overlapping speech makes
flattened word ordering arbitrary; cpWER compares per-speaker text. These six excerpts do not establish
whole-meeting identity continuity or a Spanish quality winner.

Evidence: `.diagnostics/asr-accuracy/diar-results/`, `ami-reference-tokenization.json`, and
`ami-text-reference.json`. DER is aggregated by reference speaker duration, not by averaging clip rates.

### Saved runs

- `.diagnostics/asr-client-boundary/accuracy-8025ac2f67be/summary-rescored.json` (not stale `summary.json`).
- `.diagnostics/asr-client-boundary/accuracy-8025ac2f67be-host046/summary-rescored.json` (fresh corrected runs).
- `.diagnostics/asr-client-boundary/accuracy-8025ac2f67be-moss047/summary-rescored.json` (fresh MOSS correction).
- `.diagnostics/asr-gemini-boundary/fleurs-es419/` and `fleurs-enus/`.
- `.diagnostics/asr-accuracy/audio8-preparation-failure.txt`.
- `.diagnostics/asr-offline-boundary/report.json`.
- `.diagnostics/asr-settings-persistence/` and `.diagnostics/asr-settings-ui/`.

Public benchmark conditions and primary sources are recorded separately in
[published benchmarks](asr-published-benchmarks-2026-10-11.md). No cross-dataset ranking is used to select a default.


