# Identity rules

One section per kind of identity question the People page used to ask. Each says the rule that
answers it, the signals it reads in order, the method it records, when the question stays for the
owner, and the test file that pins it. The design is
`docs/superpowers/specs/2026-10-03-people-identity-autoresolve-design.md` (Phase 3).

Every automatic decision follows the same contract:

- It is applied at once through the existing writers and journaled in `identity_decisions` with its
  evidence and the state before (`identity-decisions.ts`).
- Undo puts the state before back. An undone decision is never made again for the same subject and
  person, by any rule.
- A `manual` decision is never replaced. Another automatic decision is replaced only by a method
  that ranks higher (`canUpgrade` in `signal-tiers.ts`).

The ranks are in `METHOD_PRIORITY` (`signal-tiers.ts`):

| Method | Rank |
|---|---|
| manual | 100 |
| connector-email | 90 |
| self-identification | 88 |
| voice | 85 |
| one-on-one | 84 |
| voice-presence | 82 |
| attendee-email | 80 |
| elimination | 75 |
| owner-presence | 70 |
| speaker-map | 65 |
| jev-tiebreak | 60 |
| attendee-context | 55 |

Merges are not ranked against each other: a merge either happens or not, and its Undo is the
`merge_journal` row the merge writes.

## A shared first name in a recording

"Sergio" is linked to a meeting and two or more contacts are called Sergio (a bucket,
`detectAmbiguousName`). The question is which Sergio this recording means.

Rule (`buildBucketResolution` in `database.ts`, applied by `autoSplitAmbiguousBuckets` in
`org-reconciler.ts` and by the Jev tiebreak in `identity-rules.ts`). The first signal that applies
decides:

| Order | Method (rank) | Signal |
|---|---|---|
| 1 | voice-presence (82) | Exactly one candidate's voice is in the recording (a cluster tied to that candidate, matched at 0.9 or more). No other candidate is named as a speaker there, and every other candidate who attended has a known voice, so their absence means they did not speak. |
| 2 | speaker-map (65) | Exactly one candidate is named as a transcript speaker. |
| 3 | attendee-email (80) | Exactly one candidate attended, and the meeting has calendar attendees (its own or from its Outlook twin). |
| 3 | attendee-context (55) | Exactly one candidate attended, and the meeting's people come from transcripts only. |
| 4 | owner-presence (70) | The owner (Settings > Speakers & voices, "This is you") is a candidate, the owner speaks in the recording (the owner's voice is there, or it is a live recording), and no other candidate attended or speaks. |
| 5 | jev-tiebreak (60) | Two or more candidates have objective support: they attended, or their voice is in the recording. Jev reads the turns that say the name (up to 2,000 words) and the meeting's people, and chooses among the supported candidates only. The choice applies with probability 0.8 or more and a margin of 0.3 or more over the next option; the probabilities are kept in the decision's evidence. |

Stays a question for the owner when:

- no candidate attended and no candidate's voice is in the recording;
- one candidate's voice is there but another candidate attended whose voice nobody knows yet;
- Jev is off (the Jev switch or "Name the speakers" in Settings > Decisions), fails, answers "none",
  or is not sure and clear. Jev is asked once per recording and set of supported candidates; a
  failed call is asked again on the next run.

Tests: `apps/electron/electron/main/services/__tests__/identity-rules-buckets.test.ts`,
`.../__tests__/identity-rules.test.ts` ("jev-tiebreak for a shared first name"),
`.../__tests__/jev-identity-tiebreak.test.ts`, `.../__tests__/mention-resolution.test.ts`.

## Duplicate people: the same email

Two contacts with the same email address. The startup dedup (`mergeDuplicateContacts`) merges
these when both are on the same side of the visibility boundary; discovery
(`discoverContactMerges`) marks the rest of the exact-email pairs `autoMergeable`.

Rule (`autoMergeExactEmail` in `identity-rules.ts`): a pending suggestion marked `autoMergeable`
with an exact email match is accepted through the People accept path
(`acceptIdentitySuggestionWithGraph`), after the same accept-time revalidation the accept button
runs (`isSuggestionEligibleForAccept`). Method `exact-email`. It merges only a personal address:
one address can belong to a team, and two people on one shared mailbox are two people.

Stays a question when:

- the address is a role or shared mailbox (`isSharedMailbox`): its local part is info, support,
  sales, admin, team, contact, hello, office, billing, hr, jobs, careers, marketing, help, service,
  servicio, soporte, ventas, contacto, noreply, no-reply, notifications, calendar, booking,
  reservas, recepcion and similar words, alone or followed by a separator ("support-latam"), or it
  has a "+"; the evidence says `autoMergeBlocked: "role-mailbox"`;
- the two display names do not fit one person: not the same first name or nickname
  (`firstNameNicknameMatch`), neither name inside the other as whole words, and neither is just
  the address; `autoMergeBlocked: "names-differ"`;
- one meeting lists the address under two different display names, as a distribution list does;
  `autoMergeBlocked: "shared-address"`;
- the two contacts are on different sides of the visibility boundary (one visible, one hidden
  because every recording it came from is excluded);
- the suggestion fails the accept-time revalidation;
- the owner undid a merge of the two before (here or in People).

Test: `.../__tests__/identity-rules.test.ts` ("merge by exact email").

## Duplicate people: the same voice

Two contacts whose voices are tied to clusters that are the same voice.

Rule (`autoMergeSameVoice` in `identity-rules.ts`): two clusters of the same model, tied to
different contacts, with centroid similarity 0.9 or more (the consolidation line of
`voice-identity-consolidation.ts`) merge the two contacts. Method `voice`. The owner is the keeper
when one of the two is the owner; otherwise the startup dedup's keeper rule (has an email, has a
role or company, more meetings, older).

Stays a question when:

- the two voices are heard in the same recording (two people in one room);
- both contacts have email addresses and they differ;
- either contact is a shared-first-name bucket;
- they are on different sides of the visibility boundary;
- the owner undid a merge of the two before.

Test: `.../__tests__/identity-rules.test.ts` ("merge by voice").

## Duplicate people: similar names

Two contacts with similar names ("Edu" and "Eduardo Paz") and neither an exact email nor a voice
that decides it.

Rule (`resolveSimilarNameMerges` in `identity-rules.ts`): each pending suggestion is re-scored
with two signals, written into its evidence: the meetings the two share (eligible links only) and
a shared company mail domain (public mail services such as gmail.com do not count). When one of
them supports the pair, Jev is asked whether they are the same person, with their names, emails,
roles and the subjects of the meetings they share. A "same person" answer with probability 0.8 or
more and a margin of 0.3 or more merges them through the accept path. Method `jev-tiebreak`.

Stays a question when neither signal supports the pair, when both contacts already have voices
(the voice rule did not merge them), when Jev is off, unsure or failing, and under the same
visibility and undo guards as the other merges. Jev is asked once per pair and evidence.

Test: `.../__tests__/identity-rules.test.ts` ("similar names without email or voice").

## Junk names from self-identification

A self-introduction cue followed by a word that is not a name: "I'm here" read as a person called
"I'm", "Service here", "soy CTO", "This is Connect".

Rule (`isJunkSelfName` in `self-identification.ts`): a name whose first word is a pronoun, a helper
verb, a role word or a short function word, in English or Spanish, is dropped where
self-identification reads names (the cue capture and the model's answer). It never becomes a
contact, a speaker name or a warning that two people share one speaker. Words that are also common
first names or nicknames stay out of the stop list (Will, May, Ella, Dale, Vale, Una, Nada, Son,
He, Su, Ha, Tu).

Nothing to ask the owner: a dropped word leaves the speaker as "Speaker N".

Test: `.../__tests__/self-identification.test.ts` ("junk self-names").

## Projects

The project merge suggestions stay manual for now. Projects have no voice and no calendar signal:
a meeting does not list its project the way it lists its attendees, so the only evidence is the
words in transcripts and meeting subjects, which is the text-only signal the owner ruled out for
deciding alone. Their rule gets written here after the people rules are measured on the live
library.

## When the rules run

`runIdentityRules` (`identity-rules.ts`) applies the shared-first-name rules, the Jev tiebreak,
then the merges by email, voice and similar name. It runs:

- at startup, after the organization reconcile and the voice learning pass (`boot-tasks.ts`);
- from the voice backfill (`voice-backfill.ts`): voices are learned after every recording, but the
  rules run at most every 30 minutes, and once more when the backfill has nothing left;
- after each calendar sync, once the links are re-checked (`meeting-link-recheck.ts`).

It never runs while a recording is transcribed, stops between steps and between Jev calls when one
starts, hands the event loop back between steps, and makes at most 50 Jev calls per run and 300
a day (counted in the config table under `identity_rules:jev-calls-per-day`). The
reconcile step after every sync also applies the shared-first-name rules without the owner rule.
