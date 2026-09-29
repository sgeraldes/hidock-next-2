# Pipeline cost and time plan (task #20)

Sebastián, 27-sep: after Jev value classification, look for other decision points where Jev, a local
classifier or batching would cut cost and time. Deliver a measured plan, then build.

## Measured (processing_runs, last 30 days, 28-sep-2026)

125 recordings, 103 hours of audio.

| Stage | Provider | Runs | Average | Total |
|---|---|---:|---:|---:|
| Speaker separation (diarization) | pyannote on this PC's CPU | 292 | 694 s | 55.0 h |
| Transcription | Gemini | 212 | 88 s | 5.1 h |
| Search indexing | local ONNX embedder | 145 | 22 s | 0.9 h |
| Diarization | Gemini | 12 | 166 s | 0.6 h |
| Summary | Gemini | 154 | 5.8 s | 0.2 h |
| Voice activity | local | 300 | 2.6 s | 0.2 h |
| Action items | Gemini | 145 | 1.4 s | 0.1 h |
| Timeline | Gemini | 145 | 2.4 s | 0.1 h |
| Title, meeting, speakers, graph, wiki | Gemini or local | 145-212 each | under 1 s | under 0.1 h |

Money: not measurable today. Every one of the 1,121 Gemini runs has an empty
`estimated_cost_amount`; the usage the API returns is never stored.

## What the numbers say

1. Diarization is 90% of the machine time: 55 of 61 hours. Everything else together is under 2 hours.
2. Each recording makes six separate Gemini calls after transcription (summary, action items,
   timeline, title, meeting resolution, and the speaker naming LLM call when Jev is off).
3. Jev already answers "has action items" for every rated recording (`recording_evaluations.has_action_items`),
   yet action-item detection still calls Gemini on every recording.

## Plan, in order of return

| # | Change | Saves | Needs |
|---|---|---|---|
| 1 | Record the usage and cost of every Gemini call in `processing_runs` (tokens from `usageMetadata`, price per model in one table) | Makes money measurable; nothing else can be judged without it | Nothing |
| 2 | Skip diarization for recordings Jev rates no value or low value (1-2 stars), and for clips under the short-clip rule; diarize them later on demand | Up to the share of low-value audio of the 55 h (to measure on the library before switching it on) | Sebastián: skipping is a behaviour change |
| 3 | Run diarization on the gamestation (HiDock Model Host, built 22-sep) instead of this PC | Most of the 55 h leaves this PC; the 4090 does it in minutes | Sebastián installs the host on the 4090 |
| 4 | Skip the action-items Gemini call when Jev's `has_action_items` is under 0.2 | Up to 145 calls a month | Nothing (Jev already answers it) |
| 5 | One Gemini call for summary, title and timeline instead of three | About 300 calls a month and their prompt tokens | Nothing |
| 6 | Speaker naming on Jev instead of the LLM (built on `feat/identity-jev`, #27) | One LLM call per recording | Done with #27 |
| 7 | Images: Jev picks the category, Moondream2 or Florence-2 describes locally, Granite Vision or Qwen2.5-VL only for dense documents | Every image description sent to Gemini today | A local model runner that respects the display-GPU rule |

Order of building: 1 (measure), then 4, 5 and 6 (no decision needed), then 2 and 3 once Sebastián
decides, then 7.
