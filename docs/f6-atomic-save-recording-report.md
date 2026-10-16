# F6: atomic no-overwrite saveRecording publication

Date: 2026-10-12. Scope: `apps/electron/electron/main/services/file-storage.ts` and `services/__tests__/file-storage-atomic.test.ts`. Nothing else was edited.

## Problem

`saveRecording` checked `existsSync(filePath)`, picked a free name, then called `renameSync(tempPath, filePath)`. On Windows `renameSync` replaces an existing destination. A file created between the check and the rename was silently overwritten.

## Implementation decisions

- Publication is now `publishExclusive()`: `linkSync(stagedPath, candidate)`. The filesystem creates the link only if the name is absent, so the link call is both the existence check and the publication. The `existsSync` preflight and the suffix loop are gone.
- Only `EEXIST` moves to the next name: `name.wav`, `name-1.wav`, `name-2.wav`, and so on. The stem is the mapped device name (`.hda` becomes `.wav` before publication), so the device name is preserved. The limit is 10,000 names, then `RecordingPublicationError` with code `EEXIST`.
- Any other link error (`EPERM`, `ENOTSUP`, `EXDEV`, and so on) throws `RecordingPublicationError` with the original error code and cause. There is no fallback to an overwriting rename and no copy presented as atomic.
- After a successful link the staging name is unlinked. If that unlink fails, the recording stays published, a warning is logged, and the path is returned. The publication is never undone.
- Staged-file preservation:
  - Owned resumed downloads (`isOwnedResumedDownload`) keep the partial and the checkpoint on cancel and on any failure, as before.
  - A caller-supplied staged file (not a Buffer) that hits `RecordingPublicationError` is also kept complete. It is not deleted.
  - A Buffer stage that we wrote ourselves is deleted on failure, as before.
- Cancel before publication is unchanged: the temp is removed (owned resumed bytes are kept) and the result is `null`.
- `replaceRecordingFile` is untouched, including its deliberate `renameSync` replacement. Audio repair code is untouched.
- New exports: `RecordingPublicationError` (class, field `code`).

## Behavior change to know about

Publication now needs a filesystem that supports hard links (NTFS, ReFS, ext4, APFS). On FAT/exFAT volumes and on some network shares, `saveRecording` will now throw `RecordingPublicationError` instead of succeeding. The complete stage is kept in that case. The callers (`download-service.ts:1076`, `storage-handlers.ts:276`) were not edited, so they report the failure through their existing error paths. I did not check whether any user keeps the recordings folder on such a volume.

## Tests (real temporary Windows filesystem)

`linkSync` is wrapped with a passthrough mock, so every successful publication uses the real filesystem. Only the "unsupported link" tests make one call throw.

Added (11):
- race between preflight and publication (competitor created inside `isCancelled`): competitor bytes preserved, source published as `-1` with identical sha256
- same race with a staged download
- three consecutive `EEXIST` suffixes
- HDA to WAV mapped name with an existing WAV
- HDA and WAV collisions across three saves
- original date applied to the published file
- unsupported link, Buffer stage: throws, nothing published, existing file untouched, one link attempt
- unsupported link, staged file: complete stage kept with the same sha256
- unsupported link, owned resumed download: bytes and checkpoint kept
- owned resumed download losing the race: exact bytes published, checkpoint released by `forgetPublishedResume`
- only `EEXIST` retried (`EXDEV` fails on the first attempt)
- `replaceRecordingFile` still replaces the same path

The 8 existing tests in the atomic file are unchanged. `file-storage-paths.test.ts` was not edited.

## Results

| Check | Result |
|---|---|
| `vitest run` file-storage-atomic + file-storage-paths | 2 files passed, 24 tests passed |
| eslint on the two owned files | exit 0, no output |
| Mutation: `linkSync` replaced by `renameSync` in the source | 11 of 20 atomic tests failed (race, suffix, HDA, unsupported-link cases), then the source was restored and the hash verified |
| Leftover `hidock-atomic-*` temp dirs | 0 |

Not run, by instruction: global suite, build, tsc.

## Hashes (SHA-256)

| File | Before | After |
|---|---|---|
| `file-storage.ts` | `fd30016e4027f90413d3e464d1495f9611801ecd70b9747fcd3a19d54b1dc9fb` | `9e6a3d526aca926795c45554992968257226521705a81792c39f1656ee93a694` |
| `file-storage-atomic.test.ts` | `6f14b963bf96e06c0426156c9e26e1307da4ec95a3bffad10618c09b03000fbb` | `27aa7a047b54880bb76386db3160ca6f019d70763331cf55cc520733d0b5cc00` |
| `file-storage-paths.test.ts` (read only) | `0e8f637c7168c1745d6246cf05ef785074e218d4cd8ba2807e1731f07f2ef232` | unchanged |

Both owned files already carried uncommitted changes from other sessions when I started. I read them first and edited in place, so those changes are preserved.
