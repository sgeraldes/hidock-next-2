# Recording checks: every check runs on old recordings too

Date: 24-sep-2026. Status: design, not built.

## The request

Sebastián, 24-sep, while the speaker engines work was in progress:

> Detection of low or no value audios is also not working, or not active on old recordings... All
> silence audio should be flagged as useless, all silence audios with just a couple audio spikes
> should be cataloged as noise, less than 10seconds should not even be proccesed and left for manual
> processing if desired. And all the validations that we already do in new audios, that where not
> part of the original version of the transcription, should be able to be run, as re.process, or
> even as a selected set of tests over a selection of files. For example the re-diarization,
> meaning, extracting from the audio a few speakers and running through voice ID, to re-detect if it
> is a known speaker, and so on...

## Goals, in Sebastián's words (do not drop any)

1. All-silence audio is flagged as useless.
2. Silence with only a couple of audio spikes is catalogued as noise.
3. Under 10 seconds is not processed at all, and stays available for manual processing.
4. Every check that new recordings get, and that did not exist when older recordings were
   transcribed, can run on old recordings.
5. Checks run as a re-process of one recording, or as a chosen set of checks over a selection of
   recordings.
6. Re-diarization is one of those checks: take a few speakers from the audio, run them through
   voice ID, and re-detect known speakers.

## What exists (measured 24-sep on the owner's library, read-only)

| Fact | Number |
|---|---|
| Recordings, not deleted | 2,115 |
| With a transcript but no silence check on record | 1,941 |
| Marked `no_speech` | 4 |
| Silence check runs ever (`processing_runs.stage = 'vad'`) | 354: 346 speech, 3 no speech, 4 degraded, 1 empty |

- `audio-preflight.ts` runs ffmpeg `silencedetect` at -45 dB and returns `no_speech` when there is
  0.25 s of sound or less, or when a recording of 30 s or more has under 3 s and under 3% of sound.
  Silent audio and spike-only audio both land in the same `no_speech`; there is no noise category.
- The 10-second gate (`measureTooShortClip`, `DURATION_GARBAGE_MAX_SECONDS = 10`) runs only inside
  `transcribeRecording` for new work, and labels the clip `no_speech` with reason
  `recording_too_short`. The owner sees "no speech", not "too short, not processed".
- Transcript integrity labels (PR #32), value classification, re-diarization (`re-diarize.ts`) and
  full re-transcription (`retranscribeMany`) each exist with their own entry point. There is no
  shared way to pick checks and recordings.
- Durations: 888 of the older `duration_seconds` values were estimates, understated by 317 h in
  total. Checks measure the file itself (MP3 inside a WAV header: decode by content).

## Categories

Decided by the silence check, stored as a label with a filter, like the integrity labels.

| Label | Rule | What happens |
|---|---|---|
| Too short, not processed | measured length under 10 s | never transcribed automatically; "Transcribe anyway" on the recording |
| Silent | 0.25 s of sound or less | value set to useless; generated content can be retired in one action |
| Noise only | sound exists, but no sustained stretch: every activity interval under 1.5 s, and in total under 3 s or under 3% | same as Silent, labelled differently so it can be reviewed |
| Speech present | anything else | nothing changes |

The Noise rule is a starting point. Before it ships, it runs over the library and 20 recordings on
each side of the line are listened to; the thresholds follow what that shows.

A transcript that exists for a Silent or Noise recording was invented by the transcriber. It keeps
its label and is hidden from search and summaries until the owner retires it or keeps it.

## Checks

One registry. Each check declares what it costs so the owner can choose.

| Check | Runs on | Cost | Output |
|---|---|---|---|
| Length | file bytes | free, milliseconds | Too short label |
| Silence and noise | ffmpeg, this computer | free, seconds per hour of audio | Silent / Noise / Speech label, activity intervals |
| Transcript integrity | transcript rows | free, instant | integrity labels (PR #32) |
| Voice re-identification | a few seconds per speaker, embedded with the library's voice model | free, local; seconds per recording with voice signatures, minutes with full pyannote | speakers matched to known voices, labels updated |
| Value classification | transcript text, Gemini | paid, small | value rating |
| Re-transcription | audio, the chosen provider | paid | new transcript |

Voice re-identification shares its sampling with the speaker engines work (spec
`2026-09-24-speaker-engines-design.md`, "Canonical voice IDs and model transfer"): pick clean turns
per speaker from the transcript, embed them, match against the canonical voices.

## Where the owner runs them

- **Automatically, once, on the whole library.** The free checks (length, silence and noise,
  integrity) run in the background at low priority over every recording that has not had them, and
  pause while a transcription runs. Progress shows in the Operations panel. 1,941 recordings today.
- **On a selection.** In the Library, select recordings, then "Run checks…": a list of checks with
  a checkbox each, how many of the selected recordings each one would touch, and the cost and time
  estimate. Paid checks are never preselected.
- **On one recording.** The recording's menu has "Re-process" with the same list.
- **New recordings** run the same registry in the same order, so old and new get the same checks.

## Phases

1. Registry, the Length and Silence/Noise checks with the new categories, labels and filters, and
   the background pass over the library. Listening review of the Noise threshold.
2. "Run checks…" on a selection and "Re-process" on one recording, with integrity, value
   classification and re-transcription moved into the registry.
3. Voice re-identification, after the speaker engines phase 2 (turn sampling) lands.

Each phase: tests, adversarial review by a separate agent, merge, and a benchmark compared with the
baseline.
