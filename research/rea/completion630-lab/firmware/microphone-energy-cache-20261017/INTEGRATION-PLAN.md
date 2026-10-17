# VoiceEnergy raw-cache integration proposal

## Current state and scope

This folder contains a bounded sidecar cache, a default-off scheduled-poll adapter, a 128-byte loader derived from the accepted native loader, a bounded F11A snapshot reader, a strict F11A V2 parse/response shim, and a standalone 32-byte reply-payload codec. These are source candidates only. They do not allocate object memory, change a SYS, frame USB traffic in a composed image, build a firmware container, or select a new device/API version. The poll adapter calls the separately reviewed provider abstraction `vad_provider_raw_get(uint32_t *)`; its enabled CK802 object is linked only in the local evaluation ELF.

The accepted H1E VAD path calls `h1e_vad_native_poll_bridge()` from the existing scheduled poll hook at `0x01020b62`. That bridge forwards the caller's word to the existing `RefChannelVAD` getter at `0x0101fb68` once, records the result in the existing VADT tail, and returns the getter status unchanged. Its current 32-byte VADT record occupies object offsets `+0x40..+0x5f` in a 96-byte object. F11A v1 reads that record; its request and 32-byte response remain unchanged.

The provider call shape, passive preflight gates, raw-word ABI and native return handling are pinned by the provider owner's `RAW-ADAPTER-REPORT.md` and enabled object. This adapter does not hardcode the provider's address. The data source route, microphone response, freshness, and any relationship to voice activity remain unknown. Future raw observation may help qualify the source route; it must not be labeled a voice decision.

## Proposed memory layout

| Object offsets | Length | Meaning |
| --- | ---: | --- |
| `+0x00..+0x3f` | 64 B | Existing native object, unchanged |
| `+0x40..+0x5f` | 32 B | Existing VADT telemetry, unchanged |
| `+0x60..+0x7f` | 32 B | Proposed raw/status/counter sidecar |
| End | 128 B | Proposed total extent `0x80` |

The sidecar stores sequence, attempts, successful reads, latest provider status, last successful raw word, `HAS_SAMPLE`, and two zeroed reserved words. It has no timestamp, audio buffer, threshold, channel/source label, or Boolean voice field. It does not overlay the VADT time words or flags.

Before this layout can be used, a constructor must allocate and zero `0x80` bytes before delayed publication, and the guarded loader must validate the complete object extent and rely on an accepted detach-before-free lifetime. The installed 393998 constructor still uses `0x60` at `0x01021054` and `0x0102109e`; the r5 link includes proposed replacement instructions `movi r0,0x80` (`8030`) and `movi r2,0x80` (`8032`) for review only. Neither is applied to the SYS. `h1e_voice_energy_load_object_128()` reads the existing pointer slot once, rejects NULL, wrap and misalignment before touching the object, then returns its VADT tail and native state. It requires explicit compile assertions for the 128-byte constructor, detach-before-free, and build admission. Those macros are not evidence; no loader is enabled in the current firmware. The sidecar begins at `tail + sizeof(vadt_telemetry_t)` (`+0x20` relative to the tail).

## Scheduled-poll adapter

`h1e_voice_energy_poll_bridge(uint32_t *)` has the existing one-argument poll-hook ABI. It delegates to the accepted `h1e_vad_native_poll_bridge()` and saves its return status. The two-argument `h1e_voice_energy_poll_bridge_with_ops()` remains a focused fake-ops test seam. In an explicitly admitted target build, a local static ops table binds to `vadt_csky_guard_enter/exit`, the new extent-checking loader, and `vad_provider_raw_get()`; there is no unresolved ops-table dependency. The target binding requires all of `H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED`, `H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128`, `H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE`, and `H1E_VOICE_ENERGY_BUILD_ADMITTED` to equal 1. These are compile assertions, not evidence. Poll sampling and target binding both default off.

When enabled after provider ABI/context review and constructor/lifetime admission, the wrapper uses the existing guard and the 128-byte loader to confirm a live object. It releases the guard before calling `vad_provider_raw_get()`, which may retry or wait/yield; there is no nonblocking guarantee. Invoke it only in the same native poll context and outside the IRQ/object guard. The wrapper retains only the preflight object's `uintptr_t` identity, never dereferences that saved value, then reacquires the guard and reloads before deriving and publishing. A changed object identity, failed reload, or failed load suppresses the sidecar write. A failed source call on the same live object updates attempts/latest status and preserves the last good raw word and `HAS_SAMPLE`. The wrapper always returns the original RefChannelVAD status and does not alter its caller word.

The callback remains independent from any microphone/voice interpretation. Provider ABI/context review is the raw-call gate; source routing, microphone response, freshness, and voice semantics are separately unknown and require their own evidence. The operation also requires one writer, valid aligned pointers, constructor initialization before publication, detach-before-free lifetime, and target CK802 ordering review. The current cache barrier default is compiler-only; do not infer inter-core or DSP exclusion.

## Future F11A selector and v2 payload contract

The current parser accepts exactly a one-byte body with `body[0] == 1`; the current response is exactly 32 bytes and remains the compatibility path. The proposed new request is also one byte long, with selector value `body[0] == 2` (not a two-byte body). It requests an opaque raw-cache snapshot only; it does not initiate a provider read.

The standalone `h1e_voice_energy_reply_v2_encode()` serializes a supplied coherent snapshot into a 32-byte payload. `h1e_voice_energy_f11a_reply_v2_read()` takes the bounded snapshot under the existing guard and then calls the encoder; it never queries the provider. If the 128-byte object is absent it returns UNAVAILABLE; if the bounded snapshot is unstable it returns BUSY. The pure `h1e_voice_energy_f11a_reply_select()` helper remains available for adapters. The r5 frame shim uses the accepted response layout directly for V2 and delegates every other response to the existing VAD-aware response wrapper.

All multi-byte fields are big-endian:

| Byte offset | Field |
| --- | --- |
| 0 | Reply status: 0 OK, 1 BUSY, 2 UNAVAILABLE |
| 1 | Payload version: 2 |
| 2 | Flags: bit 0 is `HAS_SAMPLE`; all other bits zero |
| 3 | Reserved, zero |
| 4..7 | Attempted provider reads |
| 8..11 | Successful provider reads |
| 12..15 | Latest provider status, signed 32-bit representation |
| 16..19 | Last successful raw word, copied without interpretation |
| 20..23 | Cache sequence |
| 24..31 | Reserved, zero |

The reply-envelope status at byte 0 is distinct from the provider status at bytes 12..15. BUSY and UNAVAILABLE replies carry zero flags and zero payload bytes. OK with no sample has `HAS_SAMPLE` clear. There are no time, age, freshness, source, or voice fields.

### Implemented source/link shim; not applied

`h1e_voice_energy_f11a_parse_shim(frame,body,length)` uses the accepted wrapper ABI and frame offsets. Only an exact one-byte body containing selector value 2 is a candidate. It passes a private V1 validation byte through the prior VAD-aware parser, so pending-command, resolved context, fragment, declared-length, and parser result checks remain in that path; only after success it changes `head[9]` to 2. It does not modify the request bytes. V1 and every non-exact or non-F11A request go unchanged through the prior VAD-aware parser.

`h1e_voice_energy_f11a_response_shim(frame)` handles only a valid saved state 2; it resolves the accepted response output/head fields, checks payload capacity, snapshots the sidecar cache, validates and copies exactly 32 V2 bytes, and never queries the provider. V1, invalid parse states, F117, and every other command delegate to the prior VAD-aware response. The accepted wrapper functions are `console630_parse` at `0x01128d08` and `console630_response` at `0x01128bf4`; these perform the current VAD dispatch before forwarding non-F11A traffic to the console. The r5 link verifies the delegate calls in disassembly and does not link the raw console aliases `0x0112b70c` or `0x0112b81c`.

The exact proposed external calls are poll at `0x01020b62`, parser dispatch inside the existing assembly wrapper at `0x01128e68`, and response dispatch at `0x01128ea2`. The installed 393998 bytes at those addresses are pinned in `out-provisional-link-20261017-r5-dispatch-fix5/integration-manifest.json`; the linked BSR replacements and constructor instructions are review-only, not applied. This preserves the surrounding assembly wrappers and their original fallback/status handling. The 393997 and 393998 live wrapper spans match exactly at the pinned addresses. This remains a source/local-link result, not target execution or a composed image.

## Focused checks and limits

- Host C execution covers cache initialization, successful publication, failed publication preserving the last good raw word, and the standalone v2 payload field layout/status cases.
- `build_f11a_dispatch_proposal.sh` performs CK802 compile/link and eight focused host dispatch cases. It pins the current 393997 and installed 393998 SYS, verifies VAD-aware wrapper spans and targets, emits exact proposed bytes for the two constructor length instructions and three calls, and links at `0x01137000` within the `0x01137800` evaluation bound. The link has no undefined symbols or CK802 relocations. The interval is not an accepted allocation or reservation. No SYS or container is composed.
- CK802 object attributes, per-object sections, undefined symbols, and disassembly are retained in `out-integration-source-check/`.
- These checks establish source/object structure and host dispatch behavior only. They do not prove the compile-time constructor/lifetime assertions, qualify microphone routing/response, timing/freshness, target memory ordering, object placement, target instruction behavior, or any firmware image or hardware behavior.
