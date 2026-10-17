# H1E raw VoiceEnergy cache integration source

This folder contains a 32-byte sidecar, a guarded 128-byte object loader, a scheduled-poll adapter that binds to the accepted guard and `vad_provider_raw_get()` entrypoint, a bounded F11A cache reader, a strict F11A V2 parse/response shim, and a standalone v2 payload encoder. The native RefChannelVAD return and caller word pass through unchanged; selector 1 delegates to the existing VAD-aware V1 path unchanged. Raw routing, microphone response, freshness, and voice semantics remain unknown.

The target path is disabled by default. Its compile-time assertions require provider ABI/context review, the 128-byte constructor, detach-before-free lifetime ordering, and explicit build admission. These assertions prevent accidental use with the existing 96-byte constructor; they are not evidence that the lifecycle edits are present or accepted. The F11A helper reads the cache only and does not query the provider.

Run `build_f11a_dispatch_proposal.sh` for the r5 CK802 link and focused dispatch checks. It verifies exact 393997/393998 wrapper spans, resolves the proposed poll/parse/response calls, and assembles the two 96-to-128-byte constructor instructions. The retained result is `out-provisional-link-20261017-r5-dispatch-fix5/`. The 2 KiB link interval at `0x01137000` is only an evaluation coordinate, not an allocated reservation. No SYS or container is composed and none of the recorded instruction bytes are applied.

`build_128_binding_proposal.sh` and `out-provisional-link-20261017-r4/` retain the earlier core-only milestone. See [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md) for the memory contract, frame layout, and exact proposed calls.
