# People: identity questions that resolve themselves

Owner request, 3-oct-2026. Status: approved by the owner on 3-oct-2026; built in five PRs (see Order of work).

The People page asks the owner 834 identity questions ("'Sebas' appears in 280 recordings and may be
Sebastian Geraldes, Sebas Giraldo"). Most of it was built before Outlook was connected. The goal is
that the app answers these questions by itself, from evidence, and asks only what it cannot decide.
Nobody fixes the data by hand: when a decision is wrong, the rule that made it is corrected.

## Owner decisions (3-oct-2026)

| Question | Decision |
|---|---|
| What happens to a decision the app makes | It is applied at once, shown with its reason, and can be undone. People lists only what is left undecided. |
| When voice fingerprints are computed for old recordings | At night, in batches, by default. Settings also offers "in the background" and "on the gamestation" (Model Host). |
| Jev's role | Tiebreak with evidence: Jev chooses only among candidates that an objective signal already supports, and its choice applies only when that signal exists. |

The third decision replaces one rule of the 28-sep spec
(`2026-09-28-jev-identity-and-quick-voice-id-design.md`), which said text signals never tie a
person. They still never tie on their own; Jev may now break a tie between candidates that the
calendar or the voice already supports.

## Measured state (live database, 3-oct-2026)

| Fact | Value |
|---|---|
| Pending identity suggestions | 834 (789 people, 45 projects) |
| Contacts named with one word ("Sebas", "Edu") | 708 of 1,656 |
| Meetings with a recording that have no attendees | 1,072 of 1,410 |
| Of those, meetings with an Outlook twin (same subject and start) that has attendees | 745 |
| Transcribed recordings with voice evidence | 181 of 2,144 |
| Voice clusters tied to a person | 21 of 373 (19 manual, 2 self-identification) |
| Recordings by diarized speaker count (where known) | 1: 9, 2: 29, 3: 32, 4: 39, 5+: 117; unknown: 1,918 |
| Transcript integrity | ok 509, suspect 1,627, broken 6 |

Two facts drive the order of work. The calendar data is already in the database, only split: the
ICS feed has no attendees, and every Outlook event arrives as a second row (`m365:<id>`) that does
have them. And almost no recording has voice evidence, so the voice cannot decide anything yet.

## How decisions are recorded

- Every automatic decision writes one row to a new `identity_decisions` table: kind (speaker,
  mention, merge, voice anchor), subject, method, the evidence as JSON, the state before, created
  and undone timestamps. Undo restores the state before and marks the row undone; an undone
  decision is never made again by the same method for the same subject.
- `transcript_speakers` gets `source` and `confidence` (step 1 of the 28-sep spec), filled by every
  writer: manual, self-identification, speaker-inference, jev, voice, one-on-one, elimination.
- New methods join the tier table in `signal-tiers.ts`. A higher tier may replace a lower one;
  `manual` is never replaced (the existing `canUpgrade` rule).

| Method | Rank | Meaning |
|---|---|---|
| manual | 100 | The owner decided |
| connector-email | 90 | Existing |
| self-identification | 88 | Existing: the speaker says their name |
| voice | 85 | The speaker's voice matches a cluster tied to that person (0.9 or more) |
| one-on-one | 84 | A two-person meeting: the voice that is not the owner's is the other attendee |
| voice-presence | 82 | A first-name mention resolved because only one candidate's voice is in the recording |
| attendee-email | 80 | Existing |
| elimination | 75 | The last unknown voice in a meeting where every other voice is known |
| owner-presence | 70 | The mention names the owner and the owner speaks in the recording |
| speaker-map | 65 | Existing |
| jev-tiebreak | 60 | Jev chose among candidates that an objective signal supports |
| attendee-context | 55 | Existing |

## Phase 1: complete the inputs

### 1a. Attendees from the Outlook twin

A meeting row without attendees takes them from its Outlook twin: same subject and same start, one
`m365:` row, which carries attendees and organizer. This runs in the reconcile step after every
calendar sync and once over the history. When the twin is ambiguous (two Outlook rows with the same
subject and start), nothing is copied. Expected effect: 745 meetings with a recording gain their
attendees. The attendees are turned into contacts and `meeting_contacts` rows by the existing
`upsertContactsFromMeetings`.

### 1b. Voice evidence for every recording

Voice evidence today comes only from transcription. A new job computes it for recordings that have
none, without transcribing again:

- It calls `runSpeakerLinkingPreflight` with the audio file. That runs diarization and the
  WeSpeaker embedding in the Python worker and stores clusters and observations. It does not need
  the transcript's turn times, so the 1,627 suspect transcripts do not block it.
- It maps the acoustic speakers onto the transcript's speakers with `reconcileProviderSpeakers`
  only when the transcript's integrity is `ok`. For the rest, the recording still knows which
  voices it contains, which is enough for sections 2c and 3a.
- Order: recordings with fewer speakers first, then by date, so voices are learned from the
  simplest meetings first.
- Schedule (Settings > Speakers & voices): at night by default (a time window, 01:00 to 07:00
  unless changed), in the background, or on the gamestation through the Model Host. It runs one
  recording at a time, at low priority, with the existing CPU share (`speakerLinkingCpuPercent`),
  never on the display GPU, and it waits while a transcription or another heavy job runs.
- Before the first full run, one recording is measured (wall time, CPU) and the estimate for the
  whole library is shown in Settings. If full diarization is too slow for the library, the quick
  voice ID of the 28-sep spec (a few clean seconds per speaker) replaces it for recordings whose
  integrity is `ok`.

## Phase 2: learn voices, from the simplest meeting up

### 2a. The owner's voice

The owner's voice comes from Live recordings (the microphone channel speaker, already named by
`nameOwnerOnLiveRecording`) and from the owner's self-identifications. Both anchor the owner's
voice cluster, method `voice`. Without an anchored owner voice, 2b and 2c do not run.

### 2b. One-on-one meetings

A recording linked to a meeting whose attendees are the owner and one other person, with exactly
two voices of at least 30 seconds each, one of them the owner's (0.9 or more): the other voice is
anchored to the other attendee, method `one-on-one`. The anchor is not made when that voice already
matches a cluster tied to someone else.

### 2c. Elimination

A recording linked to a meeting with attendees A, whose voices are V. When every voice but one is
already tied to an attendee, and exactly one attendee has no voice yet, the remaining voice is that
attendee, method `elimination`, under three guards:

- the remaining voice speaks for 30 seconds or more and matches no cluster tied to someone else;
- the recording has no more voices than the meeting has attendees;
- the same voice must be resolved to the same person in two different recordings before it is used
  to name anyone else. Until then it is stored but does not propagate.

Each new anchor can unlock other meetings, so the step repeats until it finds nothing new.

### 2d. Propagation

A voice tied to a person names that person's speakers in every other recording (0.9 or more), the
existing `applyKnownVoiceBindings`, method `voice`. When the voice disagrees with a speaker already
tied from text, the tie is replaced only if the voice's rank is higher; otherwise a
`voice-conflict` suggestion shows both (the 28-sep conflict rule).

## Phase 3: one rule per kind of question

Each kind of question gets a written decision in a catalog (`docs/identity-rules.md`): the rule that
decides it, or the signal the pipeline uses, or why only a person can decide it. The kinds known
today:

### 3a. A shared first name in a recording ("Sebas", "Eduardo")

Today a recording resolves only when exactly one candidate attended the meeting. Added, in this
order:

1. `voice-presence`: exactly one candidate's voice is in the recording.
2. `attendee-email`, `attendee-context`: as today, now with the attendees from 1a.
3. `owner-presence`: the owner is a candidate, the owner speaks in the recording, and no other
   candidate attended or speaks.
4. `jev-tiebreak`: two or more candidates have objective support (they attended, or their voice is
   present). Jev reads the turns that mention the name and the meeting's attendees and chooses one,
   with probability 0.8 or more and a margin of 0.3 or more over the next. Otherwise the recording
   stays undecided.

### 3b. Duplicate people (merge suggestions)

- The same exact email: merged automatically (the existing `autoMergeable` flag at 0.95 with an
  exact email, which nothing acts on today), through the existing accept path, so `merge_journal`
  keeps Undo.
- The same voice: two contacts whose voice clusters consolidate (0.9 or more) are the same person,
  merged automatically, method `voice`.
- Similar names without email or voice: re-scored with the new signals (co-attendance, the same
  email domain); Jev breaks a tie only when one of those signals supports it. Otherwise they stay
  as questions.

### 3c. Junk names from self-identification

Words like "not", "i'm", "we're", "service", "cto", "connect" are filtered before they become
contacts or merge-suspected warnings (pending item 49).

### 3d. Projects

The 45 project suggestions get their own entry in the catalog after the people rules are measured.

## Phase 4: People shows what is left, and how the app decided

- People lists only undecided questions. A "Decided automatically" list shows each decision with
  its method in words ("voice recognized in the one-on-one of 12-sep") and an Undo button.
- Settings > Speakers & voices shows the counts per kind of question: pending, decided
  automatically, decided by the owner, and the voice job's progress and estimate.
- After each phase the owner and I review a sample of automatic decisions together. A wrong
  decision changes the rule and its tests, then the job runs again.

## Order of work

Each item is one PR with tests, an adversarial review by kiro-cli, CI, merge, and a measured run
against the live database (counts before and after, read only).

1. Decision journal, `transcript_speakers.source` and `.confidence`, the new method tiers, and the
   Outlook twin attendees (1a).
2. The voice job: measure one recording, then schedule, Settings, and the gamestation option (1b).
3. The owner's voice, one-on-one, elimination and propagation (phase 2).
4. The rules of phase 3 and the catalog.
5. People and Settings views of phase 4, then the review with the owner.

## Out of scope

- The organization directory as contacts (phase 1 of the 28-sep spec): it needs a new Graph
  permission and the owner's consent, and it is not needed for these rules.
- Changing a transcript's text or turn times.
