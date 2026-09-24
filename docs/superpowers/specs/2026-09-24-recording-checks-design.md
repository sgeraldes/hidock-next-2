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

Added the same night:

> 20 second, 7 minutes transcript, null audio... need more indicators... Average noise level or
> something like that should be needed, a spike like an object noise, or cough or laugh should count
> as outlier... I imagine that number can be calculated without a VAD or anything complex, in less
> than 100ms, can it? Same as with the other software verifications. Doesn't need to run always, but
> at least when something is detected wrong, or at user instructions.

7. A loudness indicator per recording: the typical level (robust to spikes), spikes counted as
   outliers, the share of time with sound. No VAD. Runs when another check finds something wrong, or
   when the owner asks.

## Loudness profile (measured 24-sep)

Decode to 8 kHz mono, 50 ms frames, RMS in dBFS per frame. Report the median (the typical level;
spikes do not move it), the 90th percentile, the peak, the share of frames above -45 dB, and the
number of spike frames (20 dB or more above the median).

| Recording | Time | Median | Peak | Share above -45 dB | Spikes |
|---|---|---|---|---|---|
| Rec56, 20 s, 1,677-word transcript | 49 ms | -67.5 dB | -59.6 dB | 0% | 0 |
| Rec93, 4 h, full decode | 4.1 s | -67.6 dB | -10.9 dB | 4.4% | 14,425 |

Sampling windows of a long file is slower than decoding it whole (one ffmpeg start per window:
2.3 s for 24 windows), so long files decode once. Under 100 ms holds for short recordings; a 4-hour
one takes seconds, which is acceptable for a check that runs on demand or after another check fails.

### Faster: read the MP3 frames without decoding (Sebastián's mmap idea, measured 24-sep)

Sebastián asked about a memory-mapped file with a vectorized non-zero byte check. Zero bytes do not
work here: the device writes constant-bitrate MP3, and every frame is full (part2_3_length is 2,200
bits in 100% of frames, silence included). The per-frame `global_gain` in the Layer III side info
does move with loudness, and reading it needs only the 4-byte header and 9 bytes of side info per
288-byte frame, over a memory-mapped file.

| Measure | Result |
|---|---|
| Rec56, 20 s | 554 frames in 0.4 ms |
| Rec93, 4 h | 399,938 frames in 248 ms (plain Python loop; native code is faster) |
| Silent Rec56 gain | median 138, p90 139 |
| Speech Rec09 gain | median 151, p90 164 |
| gain > 142 vs decoded level > -45 dB, per frame, 20 min of Rec93 | agree on 99.8% of frames, 100% of loud frames found, 0.2% false loud |

So the share of time with sound, the typical level (median gain) and spikes (frames far above the
median) come from the frame headers in milliseconds, with no decoding. The decoded profile above
stays as the reference to calibrate against. Files that are not this device's CBR MP3 (split parts
are VBR, imports can be anything) fall back to the decoded profile.

### Scan once, keep the metadata (Sebastián, 24-sep)

> can we do this process once, save metadata to disk, and then use it for the audio representation?
> first read takes time, then it only needs to read metadata in less than 10ms

8. The loudness scan runs once per recording and its result is stored; the checks and the player's
   waveform read the stored result afterwards, in under 10 ms.

Today the player has its own cache (`waveform-cache.ts`: 1,000 peaks per recording as JSON under
`<userData>/cache/waveform/<id>.json`), filled by decoding the whole file in the renderer the first
time a recording is opened. The checks cannot use it and it only exists for recordings someone opened.

Design:

- One scan per recording, in the main process, from the MP3 frame gains (decoded profile for files
  that are not the device's CBR MP3). Keyed by recording id plus file size and modification time, so
  a changed file is scanned again.
- Stored as a compact per-frame envelope (one byte per 36 ms frame: 400 KB for 4 hours, or one value
  per 0.5 s for display: about 29,000 values) in the cache folder, and the summary numbers (typical
  level, share with sound, spike count, category) in a row in the database so the Library can filter
  and label without opening any file.
- The player's waveform is drawn from the stored envelope, so it no longer decodes the file on first
  open; the old peak cache is kept only as a fallback until every recording has an envelope.
- The background pass over the library fills the envelope for every recording once. New recordings
  get it when they are downloaded.

### Time ranges with sound (Sebastián, 24-sep)

> could we use the same technique to match speaking people and have time ranges where audio should
> be found? this would be a quick way to approximate audio cuts, specially when audio is too large
> (think 2 hours), but only a smaller fraction or fractions are audio. Imagine a meeting taking 15
> minutes to start with all silence. Or a meeting that completed but user forgot to hang up. Or user
> going mute for many minutes, and then backup, so having a split usefull audio at random but very
> sparse intervals.

9. From the stored envelope, derive the time ranges with sound (loud frames merged, pauses under
   2 s bridged, blips under 1 s dropped, 0.5 s of padding). Transcription, diarization and voice ID
   work on those ranges only, and map their timestamps back to the recording's timeline. The player
   shows the ranges and can skip the silence between them.

The envelope says where someone speaks, not who. Voice ID then embeds only inside the ranges.

Measured 24-sep from frame gains (fixed threshold 142):

| Recording | Length | Ranges | Sound | Notes |
|---|---|---|---|---|
| Rec93 | 4:00:00 | 74 | 0:22:57 (9.6%) | first sound at 5:54; silent gaps of 23, 22, 18, 16 and 15 minutes; ranges computed in 24 ms |
| Rec50 | 4:00:00 | 195 | 3:48:53 (95.4%) | the meeting ran 18:00 to 19:00; the rest is room noise above the fixed threshold |

Rec93 diarized over its ranges is about 23 minutes of audio instead of 4 hours: roughly 8 minutes
on the owner's CPU instead of 80. Rec50 shows the threshold cannot be one number: it has to be
relative to each recording's floor (median gain plus a margin), and the separation of speech from
steady room noise needs checking against the decoded profile before this ships. A range that is
noise, not speech, costs only time; a speech range that is missed loses content, so the rule errs
toward keeping.

### The audio index: one pre-processing pass that feeds the whole pipeline (Sebastián, 24-sep)

> I think this pre-processing is needed to allocate many other cached data that we would be needing
> throughout the audio processing pipeline. Think about it. For example, offer automated split of
> audio based on long silences and analisis of the speakers/themes... if they change between
> blocks, it is suggested to the user to do a split. We could even have a quick evaluator/decision
> model, like jev, to make the decision in no time and little cost, with no need of slow LLMs.

10. The scan is the first stage of processing, and its output is an audio index per recording that
    every later stage reads instead of reading the file again.
11. Split suggestions: where a long silence separates blocks whose speakers or topics differ, the
    Library suggests splitting the recording there. The owner accepts or ignores it; nothing is cut
    automatically.
12. The split decision comes from Jev, TypeSafe AI's "System One" decision model, not from an LLM.
    Sebastián researched it and will pay for the credits ("We need something like that or just use
    the jev model. Need to build against its API").

### Jev (TypeSafe AI)

Documented at https://docs.typesafe.ai/ (read 24-sep):

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, model `jev-latest`.
- Request: a text `state` plus named `questions`, each of type `choice` (pick one of named options),
  `score` (place on an ordered rubric) or `noul` (is this statement true, 0 to 1). All questions in
  one call are answered in parallel.
- Response: per question the answer, a probability or confidence, and token usage.
- Latency 70 to 500 ms. Price $0.042 per million input tokens; output free. A split decision with a
  state of about 500 tokens costs about $0.00002.
- Retention and training policy are not stated on the pages read. Until they are, the call is
  opt-in and says so: it sends transcript text off the machine, like the online transcribers.
- The key is stored encrypted with the other provider keys (speaker engines spec, phase 3).

Questions per split candidate, in one call: `split` (noul: "the two blocks are different meetings or
conversations"), `speakers_changed` (score), `topic_changed` (score). The state is a short text built
from the numbers and a few lines of transcript on each side of the silence. Without a key, or offline,
a local rule over the same numbers decides, so the feature never depends on the network.

### Speed of the scan in the app's own runtime (measured 24-sep)

Plain Node, whole file read into a buffer, frames walked at their 288-byte stride, one gain byte kept
per frame: Rec93 (4 h, 115 MB, 399,938 frames) read in 25 to 29 ms from the OS cache and scanned in
6.5 ms, same median gain as the Python prototype (138). The scan touches 13 bytes out of every 288,
so it is bound by reading the file, not by instructions per cycle; native code with SIMD would not
move the total. A cold read from disk depends on the drive and is the part to measure on the owner's
machine before promising a number.

What the index holds, built in this order, each stage cached and reused:

| Stage | Built from | Cost | Used by |
|---|---|---|---|
| Envelope and summary | MP3 frame gains | ms | Silent / Noise labels, player waveform |
| Sound ranges and long silences | envelope | ms | transcription and diarization on ranges only, player skip, split candidates |
| Voices per range | voice embeddings of a few seconds per range, matched to canonical voices | seconds | voice ID, "who spoke when", speaker change between blocks |
| Topics per range | local text embeddings of the transcript inside each range (the app's local embedder) | seconds | topic change between blocks |
| Split suggestions | the numbers above | ms | the Library's "Suggested split" |

The split decision per long silence uses: the silence length; whether it lines up with a calendar
meeting boundary; how much the set of voices changes across it (overlap of canonical voice IDs); how
far the topic moves (distance between the text embeddings on each side). A logistic or small
gradient-boosted model over those numbers decides in microseconds. It is trained on the splits the
owner accepts or rejects, starting from hand-set weights.

Scan of every recording under 60 s by decoded length (24-sep): 96 speech, 41 noise only, 17 silent,
5 with the audio file missing. 51 of the silent or noise-only ones have a transcript, all of it
invented. None is under 10 s once decoded; the older files' headers declare PCM over MP3 content and
under-report the length by exactly 4×.

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
