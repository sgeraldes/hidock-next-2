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

Money: not measurable before 29-sep. Every one of the 1,121 Gemini runs has an empty
`estimated_cost_amount`; the usage the API returns was never stored. Item 1 below fixes that.

## What the numbers say

1. Diarization is 90% of the machine time: 55 of 61 hours. Everything else together is under 2 hours.
2. Correction, 29-sep-2026: the six stages after transcription are not six calls. Summary, title and
   meeting resolution are three stage records of ONE Gemini call (`analyzeTranscriptWithGemini`, one
   prompt that returns all of them; a second attempt only when the first fails to parse). The separate
   Gemini calls per recording are that analysis, the action-item detection, and the timeline sentiment
   scoring (one call per batch of windows); the speaker naming LLM call only runs when Jev is off.
3. Jev already answers "has action items" for every rated recording (`recording_evaluations.has_action_items`),
   yet action-item detection still calls Gemini on every recording.

## Plan, in order of return

| # | Change | Saves | Needs |
|---|---|---|---|
| 1 | Record the usage and cost of every Gemini call in `processing_runs` (tokens from `usageMetadata`, price per model in one table). Done for the analysis (on the summary run), action items and timeline calls: `gemini-usage.ts`. Transcription, the biggest spend, is next: its engine has three call paths with retries | Makes money measurable; nothing else can be judged without it | Nothing |
| 2 | ~~Skip diarization for recordings Jev rates 1-2 stars~~ Dropped: measured 28-sep, completed pyannote runs took 33.2 h on 3-5 star recordings, 1.6 h on unrated ones and 0.1 h on 1-2 star ones (they are short). Not worth a behaviour change | 0.1 h of 35 h | Nothing |
| 3 | Run diarization on the gamestation (HiDock Model Host, built 22-sep) instead of this PC | Most of the 55 h leaves this PC; the 4090 does it in minutes | Sebastián installs the host on the 4090 |
| 4 | Skip the action-items Gemini call when Jev's `has_action_items` is under 0.2 | Up to 145 calls a month | Nothing (Jev already answers it) |
| 5 | ~~One call for summary, title and timeline~~ Summary and title already share one call (see the correction above). What is left to merge is action-item detection and the timeline scoring into the analysis call | Two calls per recording, once item 1 shows what they cost | Nothing |
| 6 | Speaker naming on Jev instead of the LLM (built on `feat/identity-jev`, #27) | One LLM call per recording | Done with #27 |
| 7 | Images: Jev picks the category, Moondream2 or Florence-2 describes locally, Granite Vision or Qwen2.5-VL only for dense documents | Every image description sent to Gemini today | A local model runner that respects the display-GPU rule |

Order of building: 1 (measure), then 4, 5 and 6 (no decision needed), then 3 once Sebastián
decides, then 7. Item 6 shipped with #27. Item 3: Sebastián said yes on 29-sep; the installer and a
guide are on the gamestation, waiting for him to run the setup and pair.
