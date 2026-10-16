# Speaker-only doubt routing: report

Date: 2026-10-13. Coding session. No commits, no app restart, no hardware, no paid inference.
Scope: one slice. This is not contextual speaker repair.

## Problem

`more_speakers_than_invited` made a transcript `doubtful`. The sampler picks every doubtful transcript, so an interview with two real speakers (four generated voice labels, one invitee) was queued for paid ASR sampling. Sampling compares words by meaning. It cannot say who spoke, so the spend could not settle the doubt.

## What changed

### New: `electron/main/services/quality-repair-routing.ts`

- `DOMAIN_BY_CODE` is a `Record<ValidityReasonCode, IssueDomain>`, so a new reason code does not compile until it has a domain. Domains: `speaker`, `timing`, `text`, `coverage`, `unverified` (`audio_not_checked`), plus `unknown` for codes outside the table.
- `routeValidityRepair(validityJson)` reads the stored `reasons[].code` values and returns a kind plus flags:

| kind | when | `allowsAsrSampling` | `fullRetranscribeIsDefault` | `needsSpeakerReview` |
|---|---|---|---|---|
| `speaker-only` | every reason is the speaker code | false | false | true |
| `mixed` | speaker code plus any other domain, including unknown codes and malformed reasons | true | true | true |
| `non-speaker` | reasons present, none about speakers | true | true | false |
| `none` | no readable reasons | true | true | false |

- Unreadable or empty JSON keeps the old behavior (`none`). A speaker-only verdict needs every reason to be the speaker code, so unknown or malformed entries cannot make a mixed doubt look speaker-only.
- It does not duplicate the pipeline. `transcript-validity.ts` still produces the reasons, the sampler consumes the routing, and the existing sampling, verdict and trust code is untouched.

### Changed: `electron/main/services/transcript-sampler.ts`

- `candidates()` drops speaker-only rows before the daily limit is applied. They neither buy ASR nor take one of the day's slots from a row that needs it.
- `sampleRecording()` returns `null` for a speaker-only row before it plans windows. It never calls `readWindow`, `transcribeWindow` or `compare`, and writes no `transcript_samples` row.
- When a mixed row is sampled, `windows_json` now carries `speakersChecked: false`, so stored evidence cannot be read as "voices verified".
- The warning and the stored transcript are not modified. The row stays `doubtful`.

## Tests

New files (real SQLite and real envelope, transcriber and Jev replaced, same setup as `transcript-sampler.test.ts`):

- `__tests__/quality-repair-routing.test.ts` (unit): speaker-only; mixed with timing, text and coverage; mixed with `audio_not_checked`; no speaker reason; unreadable JSON; unknown code; `__proto__` and `toString` as codes.
- `__tests__/transcript-sampler-speaker-routing.test.ts`:
  - A speaker-only row (4 voices, 1 invitee) goes through `runSamplingPass` with zero `readWindow`, `transcribeWindow` and `compare` calls and no sample row. It stays `doubtful` with its reasons and stored text unchanged.
  - `sampleRecording` called directly on that row returns `null` with zero calls.
  - A mixed row (speaker plus `timestamps_consistently_wrong`) is still sampled and transcribed. A newer speaker-only row does not take the one daily slot (`samplesPerDay: 1`).
  - After the sample says `confirmed`, the mixed row stays `doubtful` and keeps `more_speakers_than_invited`. The sample is stored with `speakersChecked: false`.

Results: the two new files plus the existing `transcript-sampler.test.ts` and `transcript-validity.test.ts`: 4 files, 48 tests, all pass. `tsc -p tsconfig.node.json --noEmit`: 0 errors. I did not run the full suite or the web typecheck, because no web file was touched.

## Changes to old behavior

- Before: a speaker-only doubt was sampled with paid ASR, and a `confirmed` text comparison turned the transcript `valid`, clearing a warning the comparison could not test. After: it is never sampled and stays `doubtful`.
- The "confirmed cannot clear a speaker reason" half lives in `transcript-validity.ts` (uncommitted, `VALIDITY_VERSION` 2 to 3, not mine to edit in this slice). My sampler change relies on it for the mixed case. Without it, a mixed row whose text matched would go `valid`, and the mixed test above would fail. I read that from the code and did not run it without the guard, because reverting someone else's uncommitted file is outside this slice.
- The daily allowance now covers only rows sampling can settle. The count of sampled rows per day can go up for the same limit where speaker-only rows used to fill it.

## Runtime gaps

1. **UI not done.** `src/features/library/components/TranscriptValidityView.tsx` does not exist, so by your rule I left UI alone. The real surface is `TranscriptIntegrityPanel.tsx` with `utils/transcriptValidity.ts`, neither in my ownership.
   - `TranscriptIntegrityPanel.tsx` has an uncommitted partial edit: `SPEAKER_REVIEW` (the truthful copy), `speakersOnly()` and a `speakers` variable. None of them is used in the render, so the panel still shows the generic doubt text. It should use `routeValidityRepair`'s rule instead of a second copy of it; the renderer cannot import from `electron/main`, so the clean option is to move the table into `src/shared/` (needs an owner).
   - `VALIDITY_LABELS.doubtful` in `transcriptValidity.ts` says "being checked against the audio. A few minutes of the audio are transcribed again and compared". For a speaker-only doubt that is now false.
   - The panel still offers "Transcribe again (about 0.20 USD)" as the main action for every doubt. Speaker-only must not.
2. **No review action to link.** `SpeakerAssignPopover` exists, wired in `SourceReader` per speaker label, and `TranscriptIntegrityPanel` has no handle to it. I did not invent a button. A scroll-to-speakers or open-speaker-list callback has to come from `SourceReader` first.
3. **Existing samples.** Rows sampled `confirmed` before this change and still `valid` are not re-evaluated by my files. That depends on the `VALIDITY_VERSION` bump in `transcript-validity.ts` triggering a recompute at startup, which I did not exercise (no app start allowed).
4. **No end-to-end run on the real library** and no paid inference, as instructed. Evidence is the tests above.
5. **Not done:** adversarial review (separate agent, via `claude2kiro`), commit, PR and board card. The slice is uncommitted by instruction.

## Files

Mine:

- `apps\electron\electron\main\services\quality-repair-routing.ts` (new)
- `apps\electron\electron\main\services\transcript-sampler.ts` (modified; had no uncommitted diff before I started)
- `apps\electron\electron\main\services\__tests__\quality-repair-routing.test.ts` (new)
- `apps\electron\electron\main\services\__tests__\transcript-sampler-speaker-routing.test.ts` (new)
- `completion-20261013\speaker-routing-report.md` (this file)

Read only, uncommitted edits by others preserved: `transcript-validity.ts`, `TranscriptIntegrityPanel.tsx`.
