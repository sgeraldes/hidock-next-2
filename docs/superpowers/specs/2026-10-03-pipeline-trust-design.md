# Pipeline trust: noise is not transcribed, invented text feeds nothing, stars follow the evidence

Date: 3-oct-2026. Status: design, built in the PRs listed at the end.

## The request

Owner, 3-oct-2026: improve the whole transcription, detection and categorization pipeline. Every
recording must end with a trustworthy audio verdict, a transcript only when there is speech, a
transcript-trust verdict, a correct kind and work or personal context, stars that reflect real
value, a summary only when the transcript is trusted, and Library chips that agree with all of it.
Cheapest tool first: programmatic checks, then Jev, then a small LLM only where Jev cannot decide.

## The case

Rec02 of 21-apr-2026 (`ed106759-…`, 789 s). The owner listened: a crackle, flat for 99% of the
time. The audio profile (25-sep) says noise: 3.74 s of sound, 0.47%, longest run 0.61 s. Its
transcript (gemini-3.5-flash, 9-jul) is 2,554 words of an invented murder confession, with a
summary and a title made from it. Jev (28-sep) gave stars 3.51 with confidence 0 and star level 5,
kind media playback, transcript invented 0.84. The Library showed "Noise only" next to
"5★ Media playing".

## What the code did (mapped 3-oct)

| Signal | Produced | Who ignored it |
|---|---|---|
| Audio category (`audio_profiles`) | `audio-profile.ts`, stored by `audio-profile-store.ts`; device downloads were profiled only by the next boot pass, files found by the watcher after their transcription was queued | every step that calls a model: the queue, both transcription gates (`measureTooShortClip`, the ffmpeg preflight), analysis, value rating, actions, timeline, naming, graph, RAG |
| Audio "no value" rating (method `audio`) | `audio-profile-store.ts` | a later content rating replaced it (`applyCaptureValueClassification` let any AI rating replace any AI rating) |
| Transcript integrity | `transcript-integrity.ts`, on insert | computed after the summary is written; only voice backfill read it |
| Jev `transcript_invented`, `audio_warning` | `jev-evaluation.ts`, `value-classification.ts` | display only |
| Star level | argmax of Jev's distribution | confidence never consulted; Rec02's answer was 20% one star, 50% five stars, confidence 0 |

The ffmpeg preflight (`audio-preflight.ts`) calls a file speech when it has 3 s or more of activity
above -45 dB, or 3% of its length. The audio profile calls it noise when no run of sound reaches
1.5 s. By the profile's own numbers, 47 of the 92 noise files have 3 s or more of sound and would
pass the preflight.

Rec02 and Rec03 were transcribed on 9-jul, before the preflight existed (14-aug). Run today, the
preflight finds 2.5 s of activity in each and stops them. 85 of the 88 noise or silent recordings
that carry a transcript were transcribed in July, 3 in September (before their profile existed).
The evaluation, the stars, the chips and the visible summary are current behaviour.

## Measurements behind the rules (live library, read-only, 3-oct)

Words per second of sound (`words / sound_seconds`), by audio category:

| Category | Recordings | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| speech | 2,053 | 2.8 | 3.2 | 7.6 | 1,238 |
| noise | 87 | 48 | 849 | 6,089 | 7,546 |

The speech tail above 40 words per second of sound holds ten recordings, each with under 30 s of
sound in 3 to 96 minutes (Rec41 of 14-jan: 11,419 words over 9 s of sound in 96 minutes). Below 40
sit real recordings with soft speech that the loudness line undercounts (Rec45 of 21-jul: 115 words
in 59 s, 22.5 words per second of sound). Decoding two of the tail at -55 dB instead of -45 dB
moved their sound by at most 2×.

Repeated text (lines of 6 or more words that appear 3 or more times): 4 transcripts above 20% of
their words, 1 above 50% (Rec42 of 19-nov: 60% of 12,050 words).

Words inside or outside the sound ranges was measured too and dropped: the old WAV files report a
quarter of their real length to the transcriber, so line times on those files do not line up with
the ranges.

## Design

### 1. No transcription of noise or silence

`transcribeRecording` reads the recording's audio profile (computing it when it is missing or
stale; milliseconds for device files) before the ffmpeg preflight. Silent or noise ends the run as
`no_speech` with reason `audio_silent` or `audio_noise`, before any provider call, like the
too-short gate: a `vad` run records the profile numbers, the reader says why, and an explicit re-run
with a provider is the way past it. Device downloads are profiled when they land, so the Library
label is there before the queue reaches them.

Sending only the sound ranges of a long speech recording to the transcriber is phase 4 of
`2026-09-24-recording-checks-design.md` and not part of this change.

### 2. Measured ratings outrank model ratings

A rating set by measurement (method `audio`, or `trust` below) is never replaced by a rating a model
or the duration rule made (methods `content`, `duration`). Only the owner, or the measurement that
set it when its evidence changes, moves it.

### 3. Transcript trust

The integrity check (`transcript-integrity.ts`, version 3) also reads the audio profile:

| Finding | Rule | Status |
|---|---|---|
| `text_over_noise` | the audio is silent or noise only, and the transcript has 20 words or more | broken |
| `words_beyond_sound` | 100 words or more, at over 40 words per second of sound | broken |
| `repeated_text` | lines of 6 or more words that appear 3 or more times hold half the words or more | broken |

A transcript is trusted unless its status is broken and the owner has not accepted it. The check runs
when a transcript is stored, when the audio profile of its recording changes, and over the whole
library when the rule version changes (the existing backfill).

### 4. Nothing derived from an untrusted transcript

- During transcription the integrity check runs on the new segments before the analysis call. An
  untrusted transcript is stored without summary, title, actions or analysis, and the steps after it
  (actions, timeline, speaker naming, graph, wiki, RAG indexing) are skipped.
- An untrusted transcript rates its capture "no value" with method `trust` and reason
  `transcript_untrusted`. Every place that already honours a value exclusion (search, graph,
  timeline, People and identity rules, speaker naming, handover) then leaves it out. Accepting the
  transcript, or a new trusted transcript, takes the rating back.
- Nothing already stored is deleted. The Library and the reader hide the summary of an untrusted
  transcript and say why; the transcript keeps its integrity label and its two ways back to green.

### 5. Stars, kind and context

Tier 0, programmatic, no call:

| Evidence | Stars | Kind | Context |
|---|---|---|---|
| audio silent, noise or too short | 1 | noise_accidental | unclear |
| transcript untrusted | 1 | noise_accidental | unclear |

Tier 1, Jev, for everything else, as before. The star level comes from Jev's distribution: its most
probable level when Jev's confidence is 0.5 or more, otherwise the probability-weighted stars,
rounded and never above three. A low-confidence answer never maps to four or five stars.

Tier 2, a small LLM through the pipeline runner, only for the kind, when Jev's kind confidence is
under 0.4 (57 recordings on 3-oct).

Stored evaluations are recomputed from their stored Jev answers when these rules change, with no Jev
call. Recordings in tier 0 get an evaluation from the rules (`model` `rules-v1`) instead of a Jev
call.

### 6. Library

The chips read the stored, capped evaluation, so a noise recording shows "Noise only" with
"1★ Noise". The renderer also refuses to show a star level above one next to a silent or noise
label, in case an evaluation is older than its audio profile.

## Cost before running over the library

Written in each PR that runs a pass: count per tier, measured tokens and time on a sample, and the
estimate. Tier 0 and the star recompute cost nothing. Jev runs only for transcribed recordings
without an evaluation. No re-transcription runs over the library.

## PRs

1. Audio gate before transcription; measured ratings outrank model ratings (sections 1 and 2).
2. Transcript trust; nothing derived from an untrusted transcript (sections 3 and 4).
3. Stars, kind and context tiers; stored evaluations recomputed; Library chips (sections 5 and 6).
