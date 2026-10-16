# Published ASR and diarization benchmarks — 2026-10-11

Primary-source review, retrieved 2026-10-11. These are published results, **not measurements of HiDock's Windows adapters**. WER (word error rate), CER (character error rate), cpCER (speaker-permutation character error rate), and DER (diarization error rate) measure different things; lower is better. Do not present `100 − WER` as a general accuracy percentage.

Dates marked **repository created** come from the publisher's Hugging Face repository metadata; they are not asserted release dates. Publication dates belong to the linked announcement. Missing scores mean unavailable in the consulted primary material, not zero errors.

## Transcription

| Candidate | Source date | Published result and conditions | Primary source |
|---|---|---|---|
| NVIDIA Parakeet TDT 0.6B v3 | Repository created 2025-08-04 | FLEURS **25-language average WER 11.97%**; Spanish **3.45%**, English **4.85%**. English eight-dataset average **6.34%**. | [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| Moondream Parakeet Ultra | Repository created 2026-09-22 | September 2026 Open ASR normalization/alignment: English **seven-set WER 5.80%** versus original Parakeet **6.26%**; FLEURS **25-language WER 9.55%** versus **11.62%**. Publisher used identical files for each paired comparison; Ultra ran in Photon, baseline in NeMo BF16. | [Ultra card](https://huggingface.co/moondream/parakeet-ultra), [announcement](https://moondream.ai/blog/introducing-parakeet-redux-and-ultra) |
| Qwen3-ASR 0.6B | Repository created 2026-01-28 | FLEURS **12-language WER 7.57%**; MLS eight-language **13.19%**; Common Voice 13 **12.75%**. Additional FLEURS eight-/ten-language groups: **10.37% / 21.80%**. | [Qwen comparison table](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), [technical report](https://arxiv.org/abs/2601.21337) |
| Qwen3-ASR 1.7B | Repository created 2026-01-28 | Same Qwen table and conditions: FLEURS **12-language WER 4.90%**; MLS **8.55%**; Common Voice 13 **9.18%**. Additional FLEURS groups: **6.62% / 12.60%**. Spanish belongs to the first 12-language group; a Spanish-only score was not recovered. | [Qwen model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) |
| NVIDIA Nemotron 3.5 ASR streaming 0.6B | Repository created 2026-05-15 | FLEURS test, **1.12-second frame size with LangID**: English `en_us` **WER 7.91%**, Spanish `es_419` **4.11%**. These are streaming-condition scores, not full-file offline scores. | [NVIDIA model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) |
| Cohere Transcribe 03-2026 | Announcement 2026-03-26 | Open ASR Leaderboard, **eight English datasets, average WER 5.42%**. The same published table gives Qwen3-ASR 1.7B **5.76%**. Spanish WER unavailable in the accessible announcement; its human-preference percentage is a different metric. | [Cohere announcement and benchmark table](https://cohere.com/blog/transcribe), [model identity](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026) |
| OpenMOSS MOSS-Transcribe-Diarize 0.9B | Repository created 2026-05-19 | **WER/DER unavailable** in the consulted card. Published CER / cpCER: AISHELL-4 **14.84 / 15.83%**; AliMeeting **24.86 / 22.17%**; Podcast **5.97 / 7.37%**; Movies **6.36 / 12.76%**. AISHELL-4 and AliMeeting are Mandarin; podcast/movie language breakdown is not specified in this table. These are the 0.9B model's results, not MOSS-Pro. | [OpenMOSS model card](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize), [official code](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize) |
| Audio8-ASR-Infinite | Repository created 2026-09-21 | **480-ms delay, 80-ms frames**, greedy decoding with EOS suppressed: English LibriSpeech test-clean **WER 3.042%**, test-other **6.808%**; Mandarin AISHELL-1 **CER 1.750%**, AISHELL-4 **2.893%**. English/Mandarin only; Spanish is unsupported. Do not use its mixed WER/CER average for ranking. | [Audio8 model card](https://huggingface.co/Edge0/Audio8-ASR-Infinite), [official code](https://github.com/Edge0-AI/Audio8-ASR-Infinite) |
| Microsoft MAI-Transcribe-2 | Announcement 2026-09-03 | FLEURS **60-language average WER 5.2%**. This is neither Qwen's 12-language nor Parakeet's 25-language aggregate. | [Microsoft publication](https://microsoft.ai/news/mai-transcribe-2-is-the-fastest-most-accurate-and-cheapest-speech-recognition-model-in-the-world/) |
| Microsoft MAI-Transcribe-2-Streaming | Announcement 2026-10-01 | **Numeric WER unavailable in the consulted announcement**. Microsoft reports first place for partial/final transcripts on Artificial Analysis, but a rank is not an error rate. Keep this model distinct from MAI-Transcribe-2 above. | [Microsoft streaming publication](https://microsoft.ai/news/our-first-streaming-transcription-model/) |
| Meta Muse Voice Transcribe | Announcement 2026-09-01 | **Numeric WER/DER unavailable in the consulted official publication**. Its streaming/diarization leaderboard rank claims are not substituted for scores. The publication reports 25 validated languages, not a directly comparable aggregate WER. | [Meta research publication](https://research.meta.ai/blog/introducing-muse-voice-transcribe) |

Qwen's first FLEURS group comprises English, Chinese, Cantonese, Arabic, German, Spanish, French, Italian, Japanese, Korean, Portuguese, and Russian. Its additional groups should remain separate rather than averaging their already-aggregated scores without the evaluation weights.

**MOSS Spanish scope:** the [official card at the pinned checkpoint revision](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize/blob/704aa4a9c304e8520be88901e0d1960158ef5b15/README.md) claims transcription/diarization in more than 50 languages. Its 2026-07-14 news entry explicitly includes **Spanish** in the 14-language MLC-SLM challenge; its 0.9B release announcement is dated **2026-07-09**. The card's abbreviated YAML language tags (`en`, `zh`) are therefore not an exclusive supported-language list. Spanish evaluation is justified, but no Spanish-specific WER is provided by that card; poor measured Spanish quality must be reported as measured quality, not reclassified as an unsupported language. This does not establish equal quality across all claimed languages.

## Speaker diarization

| Candidate / evaluation | Published DER, by latency setting | Conditions and source |
|---|---|---|
| NVIDIA Nemotron-3-Diarization — DIHARD III Eval | **12.73% at 30.4 s**, **13.18% at 1.04 s**, **13.55% at 0.32 s** | Full 259 recordings; multilingual; 1–9 speakers; **0-second collar, overlap included**. Repository created 2026-09-01. [NVIDIA model card](https://huggingface.co/nvidia/Nemotron-3-Diarization) |
| Same — CALLHOME part 2 | **9.10% at 30.4 s**, **10.29% at 1.04 s**, **11.32% at 0.32 s** | Full 250 recordings; multilingual; 2–6 speakers; **0.25-second collar, overlap included**. [NVIDIA model card](https://huggingface.co/nvidia/Nemotron-3-Diarization) |
| Same — AMI MHM | **9.25% at 30.4 s**, **9.48% at 1.04 s**, **10.05% at 0.32 s** | 16 English recordings, 3–4 speakers; **forced-alignment reference labels, 0-second collar, overlap included**. [NVIDIA model card](https://huggingface.co/nvidia/Nemotron-3-Diarization) |

These NVIDIA scores belong to the documented NeMo evaluation. They do not establish equivalent DER for a Windows native/GGUF implementation. MOSS cpCER evaluates speaker-attributed transcription rather than time-based DER; Muse's numeric DER remains unavailable above.

## What can actually be compared

* **Ultra versus its original-Parakeet baseline:** paired evidence in one September 2026 evaluation. Use that baseline's 6.26/11.62 values, not the original model card's 6.34/11.97 values from different evaluations.
* **Qwen 0.6B versus 1.7B:** compare corresponding dataset/language groups in the same Qwen table.
* **Cohere versus Qwen 1.7B:** the March 26 English eight-set table provides a paired published comparison, not a Spanish or meeting-diarization comparison.
* **Nemotron diarization latency variants:** compare within the same dataset, collar, overlap policy, and reference annotations. Changing any of these changes the measured DER.

No defensible overall winner follows from the remaining numbers: language subsets, normalization, streaming latency, dataset versions, and scoring definitions differ. HiDock's quantization, chunk boundaries, decoder, runtime, and speaker pipeline can also change accuracy. Select its default using the separate same-corpus, same-normalizer live benchmark, retaining failure counts and unsupported languages alongside WER; do not choose it from speed or a single clean example.
