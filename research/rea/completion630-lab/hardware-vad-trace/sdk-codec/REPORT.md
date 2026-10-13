# Native VAD observation: SDK codec (source candidate)

Scope: byte encoding and parsing of the proposed read-only observation command, in `packages/jensen-protocol`. This does not qualify any physical voice or VAD signal, any firmware image, or any installed device. Command id `0xf11a` stays tentative and unallocated. The codec is not exported from `index.ts` and is not wired into `JensenDevice`, the app or any version allowlist. Nothing was sent to hardware and no firmware was generated or flashed.

## Files

| File | SHA-256 |
| --- | --- |
| `packages/jensen-protocol/src/native-vad-observation.ts` | `99cc4c74ec9f9abcab2d6a0b4b9a58034e3d410cf7bf5830747976ae2c05fc1c` |
| `packages/jensen-protocol/src/native-vad-observation.test.ts` | `65fe199fbde34322c1c79c8cbe013a8ee16ac225880b3c9002769ec13c42da1a` |

## Final-contract corrections (second pass)

Two defects from the parent review, both fixed in the parser and covered by tests:

1. HAS_SAMPLE is sticky after the first success until `vadt_init`, including after counter wrap. A reply with HAS_SAMPLE clear and `successfulReads != 0` is therefore inconsistent and is rejected. Wrap never justifies it. HAS_SAMPLE set with `successfulReads == 0` (a wrapped successful counter) stays valid, and so do `successfulReads > attemptedReads` and a no-sample reply with failed attempts and a native failure status.
2. UNAVAILABLE (status 2) requires `nativeState == 0`. BUSY (status 1) keeps any `nativeState` byte; values 0, 2, 7 and 0xff are tested as accepted.

The first correction replaces my earlier wording that "any counters" are accepted on a no-sample reply. The second replaces my earlier note that the parser did not enforce the unavailable state. I took both rules from the parent review of the final contract and did not re-investigate the C sources for this pass, so I have not read `vadt_binding_read` myself.

## Codec surface

- `NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND = 0xf11a`
- `encodeNativeVadObservationCandidateRequest()` returns `Uint8Array.of(1)`, a fresh array on each call.
- `parseNativeVadObservationCandidateReply(body)` returns a typed result or `null`.

Decoded `ok` replies carry `hasSample`, `attemptedReads`, `successfulReads`, `lastCompletedNativeStatus` (signed), `lastSuccessfulCallerWord` (`null` when there is no sample), `sequence`, and the fixed fields `age: null`, `dspFreshness: 'unknown'`, `voice: 'unknown'`, `clockBinding: 'unclocked'`, `imageAttested: false`. `busy` and `unavailable` carry only `version`, `nativeState` and the fixed fields. `nativeState` is the raw byte and no physical meaning is assigned to its values.

## Rejected (returns null)

- Length other than 32, including empty, the legacy 1-byte error, truncated and overlong bodies.
- Version other than 1, for OK, BUSY and UNAVAILABLE.
- Status other than 0, 1, 2.
- Any flag bit other than HAS_SAMPLE. This covers reserved bits and the age flags (AGE_VALID, CLOCK_REGRESSED), because the first binding is unclocked.
- Nonzero age low or high word on OK, so no reply can read as 0 ms.
- Odd sequence on OK (writer inside the seqlock).
- BUSY or UNAVAILABLE with flags set or any nonzero byte in 4..31.
- UNAVAILABLE with nonzero `nativeState`.
- OK with HAS_SAMPLE clear and a nonzero last-good word.
- OK with HAS_SAMPLE clear and `successfulReads != 0`.

Accepted on purpose: wrapped counters, including `successfulReads` above `attemptedReads` and HAS_SAMPLE set with `successfulReads == 0`; any signed last native status, including failures with no sample; raw word 0 with HAS_SAMPLE set (a valid sample, distinct from no sample); BUSY with any `nativeState`.

## Results

| Check | Result |
| --- | --- |
| `npx vitest run src/native-vad-observation.test.ts` (package-local, existing `vitest run` runner) | 1 file, 66 tests passed |
| `npx tsc --noEmit` (package `typecheck` script) | exit 0, no output |
| Lint | not run: the package has no lint script |
| Whole-app or whole-package test run | not run, as instructed |

Commands ran through `lowrun`. The test golden vector is the vector from `vadt_test.c` at first read, with the flags byte changed from `0x03` to `0x01` and the age words zeroed. I compared it by hand. I did not compile or run `vadt_test.c`.

## Reference files

`fresh-sample-candidate/` belongs to another owner and is still changing, so I do not treat any of it as accepted-final. These are the hashes at the end of this pass, read only:

| File | SHA-256 |
| --- | --- |
| `CONTRACT.md` | `5a542bdd525e0581c89e64864c87b51148d335b2cc8023656549ae1f7b6ae245` |
| `vadt_core.h` | `7e17f0ecbba7b541569edcb85b2683d5f666f8f8c18b9c98e68e84e605920479` |
| `vadt_core.c` | `3b24144ba3c89b6750c98aad6b16d8bb36becac0969fdfb35e06a74da810dde8` |
| `vadt_test.c` | `aeaf9d299fdecd933978af9bdaa77483e29dfba0c9c845bef8deb663579efbcd` |

`vadt_test.c` was `95380186ea100edfb58eb7ae473f3e428e1ce4c63aa80bcf0aa790598fe29c9d` in the first pass and changed since. I did not read the new version.

## Limits

- `CONTRACT.md` is unchanged since first read. It still lists AGE_VALID and CLOCK_REGRESSED as live reply flags with computed age, and still says only "bytes 0..3 meaningful" for BUSY and UNAVAILABLE. The parser follows the parent review and the unclocked encoder instead, so the contract text needs its owner to catch up. I did not edit it.
- The parser checks byte shape only. It cannot tell a real device reply from a crafted one.
- Nothing here shows the word is DSP data, a voice boolean, or any physical channel.
- Not committed, not exported, and not covered by `delivery-gate` or an adversarial review.
