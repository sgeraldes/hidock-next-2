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

No hardware acceptance item can be closed from these source checks. A release requires resolved production storage/lifetime and later authorized observation on the dock.

## Decoded firmware and container integration, 2026-10-13

The earlier statements above that no edits were applied or no firmware image was generated are historical. `firmware-integration/build_candidate.py` now applies the CK802 SDK-profile module and ten approved instruction windows to the pinned custom 6.3.4 / build 393988 system. The final decoded candidate has SHA-256 `ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0` and length 1,243,776 bytes. Actual readback found 22 changed bytes inside the 28 approved bytes and no changes outside them in the original image. The 6,272-byte extension consists of zero padding, the 2,684-byte module at `0x0112f000`, and four trailing zero bytes. The first 48 header bytes are unchanged.

This candidate includes the existing-getter observation bridge, 96-byte private allocation and clearing, delayed publication on success, failure cleanup, native parser hook and bounded response hook. It adds no second DSP query. `firmware-integration/output/acceptance-readback.json` retains source pins, branch destinations and constructor readback. `firmware-integration/INDEPENDENT-REVIEW.md` independently reconciles the seven input hashes and decoded output; its no-clobber publication finding is tracked separately in the publication verification report.

`firmware-container/package_vad_container.py` produced a complete ACTTEST container from that actual decoded candidate. The container SHA-256 is `5eea2c5af70e523b4518caa94fe0097a2660d02c34b4cdb747748612fd2211bd`. Readback verifies outer CRCs, every partition size and CRC, exact decoded-system equality, unchanged other payloads and boot identity, and only the required zephyr size/CRC edits in `ota.xml`. A baseline roundtrip separately reproduces the original container byte for byte. These are retained offline artifacts, explicitly **EXPERIMENTAL / NOTINSTALL**, not public firmware releases. The identity remains 6.3.4_restore001 / 393988; no new version was allocated.

The repeatable handoff is documented in `firmware-container/README.md`: `adapt_vad_manifest.py` checks the pinned readback and actual baseline, candidate, ELF and sparse hunks, derives the thirteen bounded change ranges, and exclusively writes the packer manifest. It requires no private cache manifest. Its generated manifest SHA-256 is `cb4326116421938b7617a81a15b9775066349a9d1f26eadb05f5cfb2d6bacb0f`. One fresh downstream pack run through this adapter reproduced the same container hash; its retained receipt is `firmware-container/out-vad-adapter/vad-candidate-20261013T204414Z-ad86193a/receipt.json`. The atomic output-publication correction was verified separately on the actual WSL filesystem and independently reviewed, without repeating the firmware build.

Remaining production gates are specific: no H1E production system-partition capacity descriptor has been established; the larger image moves subsequent container offsets; `0x0112f000` is not reserved in the other audio pipeline; object lifetime, unread callees and ordering still depend on the documented prerequisites; no candidate boot or `0xf11a` reply has been observed on hardware; and the raw observation has no established speech/activity meaning. Generic SDK board flash geometry does not resolve the H1E partition question. Integration and CRC readback do not close these gates. The current working-day prohibition on hardware operations remains in effect.

## Current 393990 integration, 16 October

The installed source baseline advanced to `6.3.6_vectors001` / 393990. Its decoded host image is `abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360`. The older VAD's parser and response preimages no longer match: they now target the current vector console. `placement-393990-20261016/` records the exact compatibility contract. Applying the old 393988 console image would remove current diagnostics and is not an accepted integration method.

`native-f11a-393990-candidate/` implements a small dispatcher that handles only `0xf11a` and delegates every other valid frame to the pinned current console's C entry points. Its 31 focused host checks passed. The CK802 SDK-profile module is 1,860 bytes with zero data/BSS and no undefined symbols or libgcc helpers. Existing vectors, upload, restore and router handling remain delegated to their current implementation. This is a source/host result, not a physical VAD response.

The current candidate avoids the earlier image-growth issue. `no-growth-393990-candidate/` links the same immutable objects into a 1,420-byte section at `0x01128a40` and a 440-byte section at `0x0112be00`, inside proposed tails of existing router and console reservations. Linker assertions bound those sections to 1,472 and 512 bytes respectively. Readback pins the original live ELF extents and exact preimages: FF padding in the router and zero padding in the console. Padding alone is not treated as an ownership grant. The initial zero-only router check was rejected; only the exact pinned FF preimage was subsequently accepted, without relinking. The final layout manifest is `a3c3209d0dfba4bef2084c1b07b18027cefb38bdcbbb4860a41cd2a6af4d7ea9`; the ELF is `cfa7e5f8b2ebf838b54484169921f388f24bf868b316b7fb366b1574d798cfbf`.

`integration-393990-20261016/compose_393990_nogrowth.py` generated and read back one complete candidate. Decoded SYS: 1,237,504 bytes, SHA-256 `c5c91e98f76a6ee14ab3e6dd7a99c24b7b3bdd3dd7bd50ca07147e3f5f923ea7`. Container: 3,429,376 bytes, SHA-256 `d8dd3ad71a68a7ee104b2bb074fef3c8ede86b89026094b74a20f3121e24f5dc`. Both lengths and every partition offset match the 393990 baseline. All 1,795 actual SYS differences lie in the two sections and ten instruction windows; reversing them reproduces the exact baseline. The header, live router/console, boot and other payloads remain unchanged. Only the zephyr checksum changes in OTA XML. Independent final artifact inspection corroborated the hashes, changed-byte confinement and inverse reconstruction.

`lifecycle-closure-20261016/` narrows the lifecycle contract using actual cross-version byte parity. The original callback also calls the getter and then reloads the native slot. The guarded observer inherits that slot-lifetime contract; its added spatial requirement is the constructor's 96-byte allocation and initialization. Allocation failure must remain null-safe and unpublished. Word alignment and callee preservation already belong to the native object/ABI contract. No exhaustive ROM proof or runtime allocation observation is claimed. Future teardown/replacement must drain readers and preserve that contract; an undersized replacement or independent tail writer remains an invalid configuration.

The candidate is still **EXPERIMENTAL / NOTINSTALL** and keeps the same 393990 identity. The append-only `0x0112f000` prototype is superseded for the current no-growth workflow. A production capacity descriptor is still not known, but this candidate does not require a larger SYSTEM extent. Shared reservation acceptance remains outstanding: the producer session is developing a larger console diagnostic, and prospective non-overlap is not a substitute for binding its exact accepted ELF and entry points. A new installation, target execution and raw-signal qualification still require the appropriate explicit authority and observed device results. No new device command, flash, reboot or release occurred in this continuation.

## Router-only integration supersedes the console-tail proposal

The producer owner reserves the entire console region. The two-tail image above is retained as historical offline evidence and is not the integration choice. `router-only-393990-candidate/` instead links the same accepted C and assembly sources with recorded LTO, function/data sectioning and garbage collection. Its single `.router_tail` is 1,088 bytes at `0x01128a40`, leaving 384 bytes in the 1,472-byte proposed router window. No console-tail section exists. This changes the compiler profile, not the source algorithms; the literal assembly invocation remains documented separately.

The frozen layout manifest is `46b380301df7490743f521f49f5ebd069f5d49c924737b3cbceeb422617fdfd5`; its ELF is `e8fd8989230b3f451dda347daa456357715f43a23b84173b43f2d632f3d4b322`. It records unchanged source pins, all four native patch roots, ten instruction windows totaling 28 bytes, zero writable state and no undefined symbols. It pins the entire 4,096-byte current console reservation, rather than only its live prefix. Calls still delegate non-F11A traffic to the exact current console C entry points. A future console replacement must preserve those entry points or produce a fresh compatible link.

The router tail's exact FF preimage and the live router extent are pinned. The range has been sent to the firmware owner for allocation coordination; this is not an ownership grant or physical execution evidence. Device installation and the meaning of the raw DSP observation remain unqualified. The current direct task continues VAD integration while preserving the producer owner's console work.

The maintained composer now supports an explicit `--profile router-only`. One composition produced decoded SYS `49603bdaa1ad853436ad27b2603ddf2307133afeb6cf6cacb78152fc1d750b51` (1,237,504 bytes) and container `6290009486d4b03db457ce70602381a7647ef3883282df2d6b3d808d039fd53c` (3,429,376 bytes), under `integration-393990-20261016/out-NOTINSTALL/vad-393990-router-only-20261016T070253Z-e8fd8989/`. Readback preserves partition offsets and sizes, boot and every other payload, and all 4,096 console bytes. OTA XML changes only the zephyr checksum. Independent inspection of the actual final files confirmed 1,065 changed SYS bytes, zero changes outside the single segment and ten approved patch windows, unchanged header, and exact inverse reconstruction. The original two-tail outputs were preserved. No accepted host suite or firmware compilation was repeated for this final inspection.

These artifacts still carry the baseline 393990 identity and **EXPERIMENTAL / NOTINSTALL** status. Packaging closes the offline source-to-container boundary only. Router allocation coordination, an install-qualified identity, authorized target execution, the `0xf11a` response and raw-signal interpretation remain open; no release, successful detection of voice, or physical firmware acceptance is claimed.
