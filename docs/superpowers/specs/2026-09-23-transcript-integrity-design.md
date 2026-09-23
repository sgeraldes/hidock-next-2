# Transcript integrity: labels, a filter and a way back to green

Date: 2026-09-23
Status: built on `feat/transcript-integrity`.

## The request

Sebastián, 23-sep, after the Library warned that 40 recordings were "shorter than their
transcripts":

> between "the audio was lost a portion" and "transcript is wrong or hallucinated extra
> time", I would take the second response any time. [...] there CANNOT be a repeated
> timestamp, ever.

> All these "wrong" results should be a tag or label, and something to filter on. And a
> path to green should exist, either automated or manual.

## What the data says

Measured read-only on the owner's library (2,087 transcripts), with the rules below:

| Verdict | Transcripts |
|---|---|
| ok | 477 |
| suspect (timing wrong) | 1,602 |
| broken (text does not fit the audio) | 8 |

| Finding | Transcripts |
|---|---|
| A line faster than 8 words per second | 1,223 |
| Two lines with the same start time | 922 |
| A start before the line above it | 448 |
| Last time past the end of the audio | 40 |
| More words than the audio can hold at 8 words per second | 8 |

Almost all transcripts come from gemini-3.5-flash. It returns only start times. Our code sets
each line's end to the next line's start (`transcription.ts`), so a start that goes
backwards is stored as a line that ends before it begins.

## Rules

`electron/main/services/transcript-integrity.ts`, pure, versioned (`INTEGRITY_VERSION`).

- **repeated_start**: two starts that round to the same hundredth of a second.
- **backwards_start**: a start more than 0.5 s before the previous one.
- **cramped_lines**: a line of at least 8 words that runs faster than 8 words per second to
  the next stated start.
- **untimed_lines**: a line with no start.
- **past_audio_end**: the last time is more than 2 s past the measured audio.
- **too_many_words**: the whole text over the measured audio is above 8 words per second.

The 8 words per second is `IMPOSSIBLE_WORDS_PER_SECOND` from `value-thresholds.ts`, the
library's existing limit (median 2.47, p95 5.44). One rule for "nobody speaks that fast".

`broken` when `too_many_words` is present, `suspect` for any other finding, `ok` otherwise.
The audio length is the stored one when it was measured from the file, else a fresh
measurement, else unknown. A transcript-derived length is never used, because judging a
transcript against a length taken from itself proves nothing. Without a length, the two
audio checks are skipped.

## Storage

Schema v58 adds to `transcripts`: `integrity_status`, `integrity_json` (the full verdict),
`integrity_version`, `integrity_accepted_at`.

- `insertTranscript` checks every new transcript as it stores it. The row is replaced, so
  an acceptance goes with the old text.
- `transcript-upgrade` rewrites segments and calls `refreshTranscriptIntegrity`, which
  checks again and clears an acceptance.
- `backfillTranscriptIntegrity` labels every transcript not checked under the current rule
  version. It runs in `recordings:backfillDurations`, after durations settle, once per
  transcript per version. An acceptance survives it.

## The Library

- **Badge** on each row while flagged: red for broken, amber for suspect; the tooltip lists
  the findings.
- **Filter** "Transcript" in the Filters panel: any problem, each finding with its count,
  and "Accepted as is".
- **Notice** once, on the mount whose backfill checked transcripts, with a Review action
  that opens the filter.
- **Reader panel** at the top of the transcript: what was found, as tags with the detail in
  the tooltip, and the two ways back to green.

## Ways back to green

- **Automatic**: "Transcribe again" in the reader (the existing re-transcribe), or "Transcribe
  all N again" for everything the filter shows, with a confirmation because it sends audio to
  the provider. New channel `transcripts:retranscribeMany`, queued in normal order. Before
  this, no bulk path re-transcribed a completed recording: Process All skipped them. The new
  transcript is checked when stored; clean means green.
- **Manual**: "Accept as is" (`transcripts:setIntegrityAccepted`), with Undo. Accepted
  transcripts leave the flagged filter and show a quiet note in the reader.

Both channels live under `transcripts:`, which the transcription feature gates.

## The old warning

"Some recordings are shorter than their transcripts" assumed lost audio. It now appears only
when the HiDock holds a larger file than the copy on disk, which is real evidence of a short
download, and offers the recovery. The integrity labels cover the rest.

## Not in this change

Tracked on the board card `hidock_transcript_integrity_20260923`:

- Link the saved speech-detector run (`processing_runs` stage `vad`) to its transcript, and
  backfill it for the ~1,900 recordings transcribed before 13-aug-2026.
- A text-over-silence finding built on that detector output.
- Stop inventing `end` from the next start; reject times past a chunk's end at the seam.
- Stop using the last timestamp as a length anywhere (duration fallback, truncated recovery).
- Pick a default provider: gemini-3.5-transcribe repeats starts in 17% of transcripts,
  3.5-flash in 46%.
