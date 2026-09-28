# Speaker identity: Jev suggestions and quick voice ID

Owner request, 28-sep-2026. Status: design, not built.

## What exists today

- Speakers live as turns in `transcripts.speakers` (`{speaker, start, end, text}`), bound to people
  in `transcript_speakers` (recording, label, contact). That table has no source or confidence.
- Voices: pyannote 3.1 with the WeSpeaker ResNet34 embedder (256 dimensions) runs before
  transcription. Embeddings land in `voice_cluster_observations`, centroids in `voice_clusters`.
  About 244 clusters from about 183 recordings, 6 tied to a contact. Most of the 2,139 recordings
  have no voice evidence at all.
- Naming: self-identification (Gemini Flash, "les habla Pedro", 0.97), speaker inference (one LLM
  call with the attendee roster, 0.7), and manual assignment (1.0).
- A voice match never overrides or flags an earlier tie: `applyKnownVoiceBindings` skips labels
  that already have a binding, and `match_status = 'needs_review'` is stored but nothing reads it.
- `identity_suggestions` already holds the 0.5 to 0.8 band for review.
- Contacts: 795 after the first Microsoft 365 sync (calendar attendees plus 2 Outlook contacts).
  The connector cannot read the organization's directory yet: that needs `User.ReadBasic.All`.

## The rule that orders everything

A voice match is the strongest evidence there is. A name that a model read from the text is a
suggestion. So:

1. Voice first. A speaker whose voice matches a cluster tied to a contact (similarity 0.9 or more)
   is that contact, and the tie records `source = voice`.
2. Text second. Jev and the other text signals only suggest, into `identity_suggestions`. They
   never tie a speaker by themselves, except where a person confirms.
3. Conflicts surface. When voice evidence arrives for a speaker already tied from text, and the
   voice says someone else, the tie is not changed silently: a `voice-conflict` suggestion shows
   both, with the evidence, for the owner to decide.

This needs `transcript_speakers.source` and `.confidence` (a migration), filled from the existing
writers: manual, self-identification, speaker-inference, voice.

## Phase 1: the organization's people as candidates

- Add `User.ReadBasic.All` (delegated) to the HiDock Next (Desktop) registration and to
  `GRAPH_SCOPES`. The owner reconnects once to consent.
- A `directory` source on the Microsoft 365 connector pages `/users?$select=displayName,mail,
  jobTitle,department` into contacts with `source = directory`. DFX5 is a few hundred people, one
  sync, then a delta.

## Phase 2: Jev names speakers

One Jev request per recording, several questions in one pass (the same pattern as the value
evaluation):

- State: the meeting subject and attendees, and per transcript speaker the first turns up to a
  budget (about 400 words each), plus names mentioned in the transcript.
- Questions: one `choice` per speaker. Options are prefiltered candidates, 40 at most: the
  meeting's attendees first, then people who often meet with those attendees, then names the
  transcript mentions (lexical match against contacts and aliases), plus "someone else" and
  "cannot tell". Jev returns a probability per option.
- Result: the top option goes to `identity_suggestions` with its probability and the evidence (the
  turns it read, the attendee list). Probability 0.8 or more on an attendee of the linked meeting
  shows first in the review list. Nothing is tied without the owner, or without voice.
- Cost: at about 3,500 input tokens a recording, the whole library is about 7.5 million tokens,
  about 30 cents, and minutes.

### Same person across recordings

For a contact with voice evidence in some recordings and none in others, a Jev `noul` question
compares a speaker's turns with that person's turns elsewhere ("is this the same person?"). This
is weak evidence (style, topics, the role they play) and only ranks candidates in the review list.
It never ties.

## Phase 3: quick voice ID

Full diarization runs on the whole file. To give every recording voice evidence without that
cost, embed only a few clean seconds per speaker:

1. Pick up to three segments of 5 to 10 seconds per transcript speaker: single-speaker turns, at
   least 1.5 seconds from any other speaker's turn, and 80% or more inside the sound ranges the
   audio check stored. Skip transcripts whose integrity is `suspect` or `broken` (their timestamps
   cannot be trusted; 1,617 are suspect today, so the timing check comes first, see below).
2. Cut them with the bundled ffmpeg and run only the WeSpeaker embedding (ONNX, CPU, the
   existing thread cap; never the display GPU).
3. The speaker's centroid is matched against `voice_clusters` with the existing thresholds. A
   match to a cluster tied to a contact becomes a voice tie; otherwise it joins or starts a
   cluster.

About 30 seconds of audio per speaker instead of the whole file. Measured before it runs on the
library: one batch-1 call first, then the full pass at low priority, one job at a time.

### Timestamps first

Quick voice ID is only as good as the turn times. The 1,617 transcripts flagged `suspect` get a
timing check against the sound ranges (turns that start in silence, turns longer than the sound
around them). Transcripts that fail it are re-aligned or left out of quick voice ID.

## Order of work

1. `transcript_speakers.source` and `.confidence`, and the conflict rule (small, and it protects
   everything after it).
2. Organization directory as contacts.
3. Jev speaker suggestions and the review list.
4. Timing check, then quick voice ID.

Each phase: tests, adversarial review by a separate agent, merge, and a measured run.
