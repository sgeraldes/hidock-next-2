# Validation order: categorize only a transcript that is valid

Date: 4-oct-2026. Status: plan for the owner's approval. Follows `docs/superpowers/specs/2026-10-03-pipeline-trust-design.md` (PRs #135, #136, #139).

## The request

Owner, 4-oct-2026: categorizations (stars, kind, context) are valid only if the transcription is valid. Jev cannot make decisions on an invented transcription. The order of the validations matters.

## What the code does now (main at 6c5638d)

| Step | Where | Order problem |
|---|---|---|
| Audio verdict (silent, noise, too short) | `transcription.ts` gate, `audio-profile-store.ts` | none: it decides from the audio alone, before anything reads the text |
| Programmatic trust (integrity v3) | `transcript-integrity.ts`, `checkTranscriptIntegrity` before the analysis call | only two outcomes, ok/suspect versus broken; the grey zone passes as valid |
| Jev evaluation | `value-classification.ts` `evaluateWithJev` | one call asks `transcript_invented` and `stars`, `kind`, `context` together, so Jev categorizes the same text it is asked to doubt |
| Jev's doubt | `jev-evaluation.ts` `withEvidence` | at 0.8 or more it only caps the stars at three; kind, context and the value rating stay |
| Value rating, analysis path | `transcription.ts`, the Gemini analysis | the summary and the value come from one call after the programmatic gate; a doubtful transcript still gets both |
| Audio-versus-transcript warning | `jev-evaluation.ts` `audioTranscriptWarning` | takes the star level as input ("3 stars or more is meaningful"), so a categorization feeds a validation |
| Tier 0 for an untrusted transcript | `jev-evaluation.ts` `rulesEvaluation` | labels it "Noise or accidental" with one star even when the audio holds speech; that label is itself a categorization the text cannot support |
| Kind fallback (Haiku) | `kind-fallback.ts` | asks for any evaluation with low kind confidence, without checking that the transcript is valid |

## What the library shows (live database, read-only, 4-oct)

| Fact | Number |
|---|---|
| Evaluations | 2,072, all made 28-sep to 2-oct, before the trust check existed, in the combined call |
| Transcripts the programmatic check calls broken | 64 with an evaluation; Jev gave 28 of them under 0.3 "invented" |
| Not broken, Jev "invented" 0.5 or more | 116 (45 at 0.8 or more) |
| Not broken but doubtful (Jev 0.5 or more, or an audio warning) | 120, of which 32 still show 4 or 5 stars |
| Broken over speech audio, labelled "Noise or accidental" by tier 0 | 12 (10 words beyond sound, 2 looping); one is a real 2-hour meeting (Rec42 of 19-nov) |
| Re-transcription cost, measured | 0.0034 USD per minute of audio (gemini-3.5-transcribe, 19 recordings, 12.7 h) |

Jev reads only text, so it is a weak judge of invention: it misses most text laid over noise. It can add doubt, never remove it.

## The order

1. **Audio.** Silent, noise only or too short decides the recording from the audio alone: no transcript is needed, so the label (noise or accidental, too short) and one star are valid. Built (#135).
2. **Transcript validity**, before anything reads the content, three outcomes:
   - **Invalid**: the programmatic check finds the text cannot come from this audio (broken). Built (#136).
   - **Doubtful**: a grey-zone signal and nothing that proves the text: 8 to 40 words per second of sound; repeated text between 20% and 50%; cramped lines over a share of the words (to measure); text past the end of the audio; an audio warning; Jev "invented" 0.5 or more.
   - **Valid**: none of the above.
3. **Doubtful is resolved** before any categorization, by the spot check (decision 1): transcribe three one-minute windows that hold sound, with a second model, and compare them with the stored text for the same minutes. Agreement makes the transcript valid; disagreement makes it invalid. Cost: about 0.01 USD per recording.
4. **Categorize only a valid transcript.** Jev asks stars, kind and context. The trust questions leave this call and the warning stops reading the stars. Haiku decides the kind only for a valid transcript.
5. **Invalid over speech audio** is not categorized: no stars and no kind, labelled "Not categorized: the transcript does not match the audio", with re-transcription offered at its measured cost (decision 3). Over silence or noise the audio label of step 1 stands.
6. **Everything derived** (summary, actions, people, search) follows the same verdict: shown for valid, hidden for invalid, and per decision 2 for doubtful.

## What runs over the library

| Step | Recordings | Cost |
|---|---|---|
| Recompute the stored categorizations under the new order (withdraw the ones on invalid and doubtful transcripts) | 2,072 | none |
| Spot check of the doubtful ones | about 120, measured on a sample of 10 first | about 1.20 USD |
| Re-transcription of the invalid ones over speech | 12 at most, only with the owner's approval per batch | measured per recording before asking |
| Jev again, only for transcripts that become valid after the spot check or a re-transcription | as many as come out valid | 1,200 input tokens each at 0.042 USD per million |

## PRs

1. Validity with three outcomes, the trust questions out of the categorization call, the warning independent of stars, the tier-0 label for invalid-over-speech, the recompute.
2. The spot check (second-model windows) and its pass over the doubtful recordings, after a measured sample.
3. Library: "Transcript in doubt" and "Not categorized" chips, summary and actions per decision 2, the re-transcription offer.

## Decisions for the owner

1. How a doubtful transcript is resolved: the spot check (recommended), Jev alone, or the owner reviewing a list.
2. What a doubtful transcript shows until it is resolved: nothing derived (recommended), or everything with a warning.
3. What happens to an invalid transcript over speech: not categorized, with re-transcription offered (recommended), or one star as now.
