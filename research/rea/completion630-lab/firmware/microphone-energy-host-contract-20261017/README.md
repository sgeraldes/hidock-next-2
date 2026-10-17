# F11A v2 host payload decoder (source-only)

The canonical codec now lives in [`packages/jensen-protocol/src/native-voice-energy-observation.ts`](../../../../../packages/jensen-protocol/src/native-voice-energy-observation.ts). It is a source-only module: it is not yet exported by the package index, wired to the live SDK/USB transport, or a VAD decision API. The request encoder only returns bytes; it sends nothing.

The request is exactly the one-byte selector `02`. The reply is exactly 32 bytes: status at byte 0 (`0=ok`, `1=busy`, `2=unavailable`), version 2 at byte 1, flags at byte 2 (`HAS_SAMPLE=01` only), byte 3 reserved zero, then big-endian 32-bit attempts, successes, signed provider status, raw word, and sequence at offsets 4, 8, 12, 16, and 20. Bytes 24–31 are reserved zero. Busy and unavailable replies must have an otherwise empty payload. An OK snapshot must have an even sequence; without `HAS_SAMPLE`, successes and raw must both remain zero. `raw` is `null` until `HAS_SAMPLE` is set; when set, raw zero remains the integer zero.

The decoder makes no inference about voice, provider freshness, time, microphone source, or polling state. Its result explicitly keeps `voice`, `source`, and `freshness` as `unknown`, `age` as `null`, and `imageAttested` as `false`. In particular, `sequence` is returned as a wire field, not treated as a timestamp. `decodeNativeVoiceEnergyObservationReply` throws `NativeVoiceEnergyDecodeError` for malformed or incoherent replies; `parseNativeVoiceEnergyObservationReply` catches that codec error and returns `null`, so a future SDK method can preserve the V1 failure boundary instead of letting malformed data escape across IPC.

## Focused C-to-TypeScript test

The test compiles and executes the existing C encoder from `../microphone-energy-cache-20261017/h1e_voice_energy_reply_v2.c` through WSL's existing `cc`, then imports the actual SDK source module above to decode those exact emitted bytes. From Windows PowerShell at the repository root:

```powershell
node --experimental-strip-types research/rea/completion630-lab/firmware/microphone-energy-host-contract-20261017/decoder.test.mts
```

The only generated C executable is placed in a temporary WSL directory and removed after the test. No app, firmware image, USB device, or hardware is involved.

## SDK export handoff

`SDK-EXPORT.patch` is a reviewable, unapplied patch for `packages/jensen-protocol/src/index.ts`; it exports only this pure codec. The SDK `get` method and transport wiring remain outside this deliverable pending coordination of the exact firmware version pair. Exporting this module alone would not enable a device query.
