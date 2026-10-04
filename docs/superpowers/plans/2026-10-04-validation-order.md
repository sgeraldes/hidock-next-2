# Validation order: categorize only a transcript that is valid

Date: 4-oct-2026. Status: plan, revised with the owner's answers of the same day. Follows `docs/superpowers/specs/2026-10-03-pipeline-trust-design.md` (PRs #135, #136, #139).

## The request

Owner, 4-oct-2026:

- Categorizations (stars, kind, context) are valid only if the transcription is valid. Jev cannot decide on an invented transcription, so the order of the validations matters.
- An LLM cannot tell invented text from real text. Invention is shown by peak-level detection: transcription where there is no audio is invented.
- When there is doubt, sample: send only a portion of the audio to be transcribed, and compare the two transcriptions by meaning, not word for word. Jev can do that almost for free.
- Before depending on Jev or an LLM, use the deterministic checks. Timestamps that are consistently wrong, transcription without audio, and more speakers than the calendar invited are errors to flag.
- A doubtful transcript shows nothing derived from it.
- An invalid transcript over speech is not categorized, and re-transcription is offered.

## What the code does now (main at 6c5638d)

| Step | Where | Order problem |
|---|---|---|
| Audio verdict (silent, noise, too short) | `transcription.ts` gate, `audio-profile-store.ts` | none: it decides from the audio alone |
| Programmatic trust (integrity v3) | `transcript-integrity.ts`, `checkTranscriptIntegrity` | two outcomes only, so the grey zone passes as valid; "sound" is a fixed loudness line, so soft speech counts as no sound |
| Jev evaluation | `value-classification.ts` `evaluateWithJev` | one call asks `transcript_invented` and `stars`, `kind`, `context` together, so Jev judges the invention of the same text it categorizes |
| Jev's "invented" answer | `jev-evaluation.ts` `withEvidence`, renderer warning | used as a validity signal; an LLM cannot give one (it gave 28 of the 64 broken transcripts under 0.3) |
| Value rating and summary | `transcription.ts`, the Gemini analysis | one call after the programmatic gate; a doubtful transcript still gets both |
| Audio-versus-transcript warning | `jev-evaluation.ts` `audioTranscriptWarning` | reads the star level ("3 stars or more is meaningful"), so a categorization feeds a validation |
| Tier 0 for an untrusted transcript | `jev-evaluation.ts` `rulesEvaluation` | labels it "Noise or accidental" with one star even over speech: a categorization the text cannot support |
| Kind fallback (Haiku) | `kind-fallback.ts` | runs without checking that the transcript is valid |

## The deterministic checks, measured (live database, read-only, 4-oct)

Peak-level detection uses each recording's own floor, not a fixed loudness line. The floor is the 5th percentile of the per-frame MP3 gain in the stored envelope (`cache/audio-envelope/<id>.u8`, one byte per 36 ms). A frame has audio when its gain is at least the floor plus 2, or above the loudness line.

With the fixed line, Rec59 of 1-apr (two hours, 20,825 words) showed sound in only 20% of its frames; soft speech sits below the line. The old WAV files gave the transcriber a quarter of their length, so their line times are mapped onto the real timeline first. Each line covers the time until the next line starts. A line faster than 8 words per second, or one with no duration, cannot be placed in time; its words count as "not placeable", never as "without audio". Example: Rec19 of 7-apr has 1,030 words, 75% of its text, in one line at second 128.

| Check | Rule | Recordings (speech audio) |
|---|---|---|
| Text without audio | 100 words or more and 90% or more of the placeable words over frames with no audio | 15 (invalid) |
| Integrity broken (existing) | text over noise, more than 40 words per second of sound, looping text | 12 (invalid; 16 with the line above) |
| Much text without audio | 50% to 90% | 38 |
| Text not placeable in time | 30% or more of the words | 162 |
| Timestamps consistently wrong | repeated or backwards starts in 20% or more of the lines | 6 |
| More speakers than invited | more transcript speakers than calendar attendees plus one | 90 |
| More words than sound | over 8 words per second of loud sound | 6 |
| Ends long before the audio | the transcript ends before 60% of a file over 5 minutes, and is judged by what comes after (owner, 4-oct: "it depends on whether that audio holds something real") | 238: 5 with no audio after the end (valid); 121 truncated, with more than two minutes of sustained sound after the end and a normal speaking rate on what exists; 78 with a compressed clock, the text complete over the real length (2.45 words per second there, 6 on the stated span); 32 without times |

| Verdict | Recordings | Show 4 or 5 stars today |
|---|---|---|
| Decided by the audio (silent, noise) | 87 | 0 |
| Invalid | 16 | 2 |
| Doubtful | 433 | 396 |
| Valid | 1,604 | 1,393 |

The thresholds above are starting points; the sample in step 3 checks them before the pass.

## The order

1. **Audio.** Silent, noise only or too short decides the recording from the audio alone; that label and one star are valid. Built (#135).
2. **Transcript validity, deterministic only**, with the checks above: invalid, doubtful or valid. No LLM and no Jev. Jev's "invented" answer is removed from validity and from the warning.
3. **Doubtful is resolved by sampling.**
   - Transcribe two or three one-minute windows of the audio where the stored transcript has text. For "ends long before the audio", the windows come from after its end instead.
   - Jev compares each new window with the stored text of the same minutes, by meaning ("same conversation, different conversation, nothing in one of them").
   - Agreement: valid. Disagreement: invalid. Speech after the end: incomplete.
   - Measured cost: 0.0034 USD per minute of transcription, about 0.01 USD per recording; Jev about 0.0001.
4. **Categorize only a valid transcript.** Jev asks stars, kind and context, with no trust question in the call. The warning stops reading the stars. Haiku decides the kind only for a valid transcript.
5. **Invalid over speech** is not categorized: no stars and no kind, labelled "Not categorized: the transcript does not match the audio". Re-transcription is offered with its cost for the owner to approve. Over silence or noise the audio label of step 1 stands.
6. **Derived content follows the verdict**: summary, actions, people and search are shown for valid, hidden for doubtful and invalid.

## What runs over the library

| Step | Recordings | Cost |
|---|---|---|
| Deterministic verdict, and recompute of the stored categorizations under the new order | 2,140 | none, minutes of CPU |
| Sampling of the doubtful ones: first 20 to check the thresholds and the comparison, then the rest | 433 | about 4.30 USD in all, 0.20 USD for the first 20 |
| Jev again, only for transcripts that become valid after sampling and have no categorization | as many as come out valid | 1,200 input tokens each at 0.042 USD per million |
| Re-transcription of the 121 truncated ones (all from the July 2026 gemini-3.5-flash batch) | 121, 7,312 minutes | about 24.57 USD, with the owner's approval |
| Re-transcription of the invalid ones over speech | per batch, only with the owner's approval and the cost of each | 0.0034 USD per minute |
| Clock repair of the 78 compressed ones | 78 | none: once sampling confirms the text, the times are rescaled to the real length |

## PRs

1. Deterministic verdict with three outcomes (peak level against the recording's floor, placeable text, timing, speakers against the calendar, end of text). Jev's "invented" out of validity, the warning independent of stars, the trust questions out of the categorization call, "Not categorized" for invalid over speech, nothing derived for doubtful, the recompute.
2. Sampling: windows transcribed by the configured engine, Jev comparison by meaning, the pass over the doubtful (first 20, then the rest).
3. Library: "Transcript in doubt", "Not categorized" and "Transcript incomplete" chips; the re-transcription offer with its cost.

## Decisions taken (owner, 4-oct)

- Ends long before the audio: it depends on the audio after the end. No real audio there: valid. Sustained sound there: incomplete.
- Sampling: 20 first, then the rest, without asking again unless something does not add up.
- Re-transcription of the 121 truncated ones: see the ask of 4-oct.
