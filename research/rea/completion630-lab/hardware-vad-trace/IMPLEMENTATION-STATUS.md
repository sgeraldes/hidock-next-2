# Native VAD observation candidate

This work exposes an existing native DSP observation without adding another DSP query. It does not yet establish that the raw word represents speech, activity, or energy. It is not installed and is not a firmware release.

## Current scope and acceptance

1. Preserve the native polling call: same one-argument getter, caller output pointer, return status, and one getter invocation. Record a completed observation separately; failed getters must not read an undefined output word.
2. Read the recorded observation through tentative Jensen command `0xf11a`, request `[1]`, with a bounded 32-byte response. The USB response must not query the DSP. Preserve existing commands and fallback routing.
3. Establish valid storage, initialization, alignment and lifetime before connecting a production loader. A nonnull pointer, native state 5, or a repeated pointer read alone is insufficient.
4. Qualify the actual signal on the H1E against silence, speech and system playback before assigning voice semantics or exposing a user audio control.

## Source pieces

| Piece | Location | Evidence and remaining boundary |
| --- | --- | --- |
| Observation core and bounded snapshot | `fresh-sample-candidate/` | Host checks and isolated CK803 compilation; no target execution. |
| Private SDK decoder | `packages/jensen-protocol/src/native-vad-observation.ts` | Focused parser checks and actual C-to-TypeScript reply interoperability; no device response. |
| Native frame adapter | `native-frame-candidate/` | Parser and response body implementation, host checks and isolated CK803 objects. |
| Native one-argument getter wrapper | `native-poll-candidate/` | Source implemented; 49 focused host checks passed, isolated CK803 compilation and original call encoding reproduced. Production loader intentionally external. |
| Native one-argument USB dispatch | `native-dispatch-candidate/` | Source implemented; 42 focused host checks passed, isolated CK803 object adds 36 bytes over the frozen dispatcher. Target/test build separation corrected. |
| Conditional native loader and snapshot reader | `native-loader-candidate/` | Source implemented; 62 focused host checks passed. Target/test build separation corrected. Requires explicit offline prerequisites; never infers lifetime from state 5. |
| Delayed object publication | `lifecycle-followup/late-publication/` | Seven isolated instruction replacements and success-decision stub; not applied. Private pointer preservation and early native readers need resolution. |
| Independent integration review | `combined-source-review/` | Original snapshot and new source glue reviewed; conditional offline integration permitted after both build-option corrections. |
| Combined offline link | `native-link-candidate/` | Linked successfully from 36 pinned inputs. Code/constant region is 2604 bytes at `0x0112f000..0x0112fa2b`; no undefined symbols or writable XIP globals. Three native hooks are four-byte branches to actual linked symbols. No firmware image generated. |
| Sparse instruction manifest | `native-link-candidate/output/sparse-source-hunks.json` | Ten exact edits, 28 bytes, matched against the pinned 393988 preimage. Excludes 124 bytes of constructor assembler padding; no patch applied. |

The proposed object extension is 64 to 96 bytes. Telemetry occupies offsets `0x40..0x5f`; compile-time layout assertions do not prove runtime allocation or pointer lifetime. The conditional loader is connected in the source ELF. There is no installable VAD image and no installed VAD command.

## CK802 SDK-profile follow-up, 2026-10-13

The retained SDK build contract selects CK802. The earlier CK803 artifacts above remain historical evidence, rather than the current target recipe. `native-ck802-candidate/sdk-profile/` now contains an offline link with all eight C units using the SDK flags, including short enums and signed char. Internal enum sizes change from four bytes to one; the telemetry layout remains 32 bytes and native poll/dispatch returns retain their integer ABI.

The link explicitly includes the two pinned CK802 libgcc division/modulo members required by console decimal formatting. `.vad_text` is 2684 bytes; total ELF text is 2836 bytes, with zero data/BSS and no undefined symbols. Its sparse manifest contains ten instruction edits totaling 28 bytes, excluding constructor padding. No edits have been applied to firmware. The three literal assembly inputs use `-mcpu=ck802` without the remaining SDK assembler flags; that narrow command-level difference is documented rather than treated as complete flag parity.

An independent review is retained in `ck802-profile-review/SDK-PROFILE-REVIEW.md`. It verifies the linked artifacts and preserves the unresolved CPU execution, placement, object lifetime, ordering and delayed-publication prerequisites. This is source integration progress, not hardware qualification or proof that the observation indicates speech.

Instruction encoding examples are not placements. In particular, the poll example at `0x0112c000` collides with the frozen upload module reservation. The frozen linker reserves parser code at `0x0112b000..0x0112bfff`, upload at `0x0112c000..0x0112cfff`, and restore at `0x0112d000..0x0112efff`. A future VAD link must allocate its own verified region and recompute every branch from actual symbols; none of the example branch bytes is approved for installation.

## Reading the retained investigation

The initial `REPORT.md` is a historical checkpoint. Its unresolved callback-slot initializer was subsequently traced in `reader-provider-followup/ram-initializer/REPORT.md`: startup copies the initialized RAM region containing slot `0x80e70`, whose provider resolves to `0x0101f0ec`. The scheduled RefChannelVAD path was traced in the lifecycle follow-ups. These findings supersede the corresponding earlier missing-source statements; they still do not establish the DSP word's physical meaning. The unregistered VoiceEnergy helper is excluded from the first observation API.

## Protocol details that must survive integration

- Counters count recorded completed getter calls while observation storage is available, not DSP samples or every possible getter attempt.
- Raw zero is valid. Nonzero does not imply speech. Voice and DSP freshness remain unknown.
- The first response is unclocked: no age flags or inferred observation cadence.
- The response callback writes 32 body bytes, not the transport header. Native framing adds a 12-byte header. The helper reads the runtime halfword at `0x867d6`; retained native writers set it to 64 on successful USB-IAP2 initialization, or 512 on another initialization path. Neither pads this 44-byte frame. Non-mode-1 body capacity is `8192 - 12 = 8180`. Current endpoint state remains unverified; see `command-binding/response-framing/endpoint-helper-binding.md`.
- Busy and unavailable responses contain no observation payload. Unavailable has native state zero.
- `0xf11a` is a source candidate namespace, not an allocated command in the installed image.

## Current operational limit

The user's working-day instruction prohibits hardware work, resets and firmware updates without new explicit approval. Source research, implementation and offline compilation continue. No device qualification, flash, reboot or power cycle is permitted under the present scope. See `cache-bridge-candidate/WORKING-DAY-CONSTRAINT.md` for the recorded instruction.

No hardware acceptance item can be closed from these source checks. A release requires resolved production storage/lifetime, linked native integration, and later authorized observation on the dock.
