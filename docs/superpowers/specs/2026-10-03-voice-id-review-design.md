# Voice ID: how it works today, what fails, and a plan to review and rebuild it

Date: 3-oct-2026. Status: draft for the owner's review. Nothing is built from this until he approves it.

## The request

Owner, 3-oct-2026, after labelling the Weekly Engineering All-Hands by hand: his own voice, which speaks for minutes in many recordings, was not identified; many turns were attributed to the wrong person; he used "Split speaker from here" many times. He asked:

1. Do manual corrections fix the voice fingerprints, or break them?
2. A way to resample a voice when he labels a clip: take that audio, compute a fresh fingerprint, add it to the person.
3. Each person's voice IDs visible, in People.
4. A voice ID health check, in Settings and per person.

His answers to the first questions (3-oct): a manual confirmation weighs more than an automatic match, but the automatic ones stay valid (another microphone, something that changed); he cannot decide on rebuilding fingerprints until the whole flow is described; he wants a graph of every recording that shares a voice ID, and a sampled check of those recordings, the long ones first, if the cost allows; he wants something visual to understand how it works.

## How it works today

1. Diarization: pyannote 3.1 (local, ONNX on this computer, or the Model Host) splits the whole file into local labels, SPEAKER_00 to SPEAKER_NN.
2. One fingerprint per label: the worker computes one embedding per label over all the speech pyannote gave it. A label with 29 minutes of audio gets one fingerprint, the average of those 29 minutes.
3. Matching: each label's fingerprint is compared with every stored voice ID. Match at 0.72 or more with a 0.08 lead over the runner-up; against voice IDs tied to a person, 0.9. Otherwise a new anonymous voice ID is created. One voice ID per label per recording.
4. Learning: a matched voice ID's fingerprint becomes the speech-weighted average of its observations.
5. Naming: a voice ID tied to a person names every label it matches.
6. Corrections:
   - Assigning a person to a label ties that label's existing voice ID to the person, with no new measurement.
   - "Split speaker from here" and "From here on" do not touch voice data at all.
   - Unassigning keeps the tie.

## What the library shows (live database, read-only, 3-oct)

| Fact | Number |
|---|---|
| Recordings with voice data | 181 of about 2,100 |
| Voice IDs | 348: 22 tied to a person, 326 anonymous |
| Voice IDs seen in only one recording | 266 |
| Label-level fingerprints (observations) | 967, average 396 s of speech each, the longest 6,180 s |
| Turn sources | 712 unrecorded, 53 by voice, 4 manual |
| Owner's voice ID | 33 h of speech over 142 recordings; observations sit at 0.88 to 0.95 of its fingerprint |
| People with two voice IDs | the owner, Santiago Rojas |

Weekly Engineering All-Hands of 2-oct (Rec14, 57 min): 12 labels. SPEAKER_04 holds 29 minutes and matched the owner's voice ID at 0.94, with a 0.005 lead over the runner-up. The stored transcript has 110 turns in 57 minutes: the label named after the owner takes 46 turns and 5,074 of about 6,500 words, and one turn of another label has 332 words. "Voice 31924D", which the owner named as himself, has no stored voice ID and no turn in the current transcript.

## Why it fails (from the code and the numbers)

1. **One fingerprint per long label.** pyannote merges people in a room recording. A 29-minute label is an average of several voices; it can match one person's fingerprint strongly enough to name all 29 minutes after him, while his real turns sit in other labels.
2. **The learning spreads the error.** A mixed label that matches a person updates that person's fingerprint with the mixture.
3. **Corrections never measure.** The owner's corrections are the best evidence the app gets, and none of them produces a fingerprint.
4. **Every miss creates a voice ID.** 266 single-recording voice IDs act as runner-ups and eat the 0.08 lead.
5. **The transcriber's turns are long.** Gemini returned turns of half a minute on average in that meeting, some of several minutes. Each turn takes the voice that overlaps it most, so a turn where two people speak goes entirely to one.
6. **Microphone and room.** A fingerprint learned from close-microphone live recordings scores lower on a far-field device recording.

## Plan (proposal)

### A. Turn-level fingerprints

Measure a fingerprint per turn window (a few seconds of one speaker, skipping overlaps and turns under 2 s), not per label. A label becomes a set of windows that can disagree; a label whose windows disagree is a merge, and the disagreement shows where to split it. Measured cost: the ONNX embedder takes 0.6 ms per second of audio on DirectML and 5.7 ms on CPU; one hour of speech is about 20 s of CPU.

A long transcriber turn is split where pyannote changes voice, so each stretch carries the name of whoever speaks in it.

### B. Evidence with provenance and weight

Every fingerprint observation records its source and weight:

| Source | Weight | Example |
|---|---|---|
| Manual clip | highest | the owner marked this stretch as a person |
| Live microphone channel | high | the owner's channel in a live recording |
| Voice match over 0.9 with a clear lead | medium | automatic |
| Weaker automatic match | low | kept, never used to name |

A person's voice is a set of fingerprints, one per condition (live microphone, device in a room, phone call), not one average. A match against any of them counts; a manual clip outranks automatic evidence when they disagree. Automatic evidence is never thrown away, only weighed.

### C. Corrections become clips

Assign, split, from-here and per-turn assigns measure the exact seconds the owner labelled and store them as manual clips for that person. Undo removes the clip. A split label gets its own fingerprint.

### D. The graph and the sampled check

- **Graph.** Each voice ID links to every recording and label that used it, so People and Settings can list them.
- **Sampled check.** For each person's voice ID, take a few windows from each recording that used it (the long labels first) and compare them with the person's manual clips. A recording whose windows do not agree is flagged for review.
- **Cost.** 142 recordings × 10 windows × 5 s is about 2 hours of audio, about 40 s of CPU, plus decoding the files: minutes, one at a time, at low priority.

### E. People and the health check

- Person page: the voice IDs of the person, each with the recordings that use it, its source mix, its spread, and a play button per sample.
- Settings > Speakers & voices: library health. It shows mixed labels, people with several voice IDs, anonymous voice IDs close to a known person, voice IDs heard once, and stale ties.

### F. Re-running old recordings

Options to compare on a sample before choosing:

| Option | Cost | Fixes |
|---|---|---|
| Re-embed per turn window with the current diarization | minutes of CPU, no API | merged labels, mixed fingerprints |
| Re-diarize locally | about 10 min of CPU per hour of audio | bad label boundaries |
| Re-transcribe | paid, per recording | text and timing errors, not voices |

## Visual explanation

Private page for the owner: https://claude.ai/artifact/LHyWosoa9MGntai495sFQb

## Decisions for the owner (after reading the page)

1. Do window-level fingerprints replace the label-level fingerprint, or do both run for a while to compare?
2. Can a person have several fingerprints by condition (live, room, call), or one?
3. Does the sampled check run every night over every voice tied to a person, or on request per person?
4. When the check finds a recording that does not agree, does it flag it for review or split the label itself?
5. Where to start: the owner's voice and the All-Hands, or the whole library?
