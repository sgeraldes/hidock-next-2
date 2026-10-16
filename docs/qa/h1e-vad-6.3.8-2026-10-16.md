# H1E 6.3.8 native VAD: physical readout qualification

On 16 October 2026 Sebastian explicitly authorized downloading and physical VAD tests while preserving his everyday H1E's data. This session coordinated exclusive Jensen ownership with the firmware and UI sessions and used the development application's existing FirmwareInstallService. No second USB owner, stock restore, format, file deletion, manual reset or power cycle was used.

## Image and installation

| Item | Exact value |
| --- | --- |
| Version | 393992 / `6.3.8_vad001` |
| Container | 3,429,376 bytes; SHA-256 `b6bf41d0359748c26242a902cf2949de6a18b216a2853a35f3a5d189b8b3f9ba` |
| Decoded SYS | 1,237,504 bytes; SHA-256 `043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918` |
| Module | 1,248 bytes in the granted 1,472-byte router tail |
| Native poll hook | `0x01020b62`, bytes `08e06941`, branch to `0x01128e34` |
| Console forwarding | Existing slots response alias `0x0112b81c` |

The exact container passed the production SDK parser, partition sizes/CRCs and decode readback. The SYS differs only in the admitted module and ten patch windows; inverse reconstruction matches the slots baseline exactly. Existing live router bytes and the whole console 4 KiB match the baseline. Six exact-image instruction fixtures passed: absent/present F11A, successful/failed native polling through the real hook, and both non-VAD forwarding paths. These fixtures model the native getter; the following physical observations are separate evidence.

There was one CMD8/9 transfer, acknowledged by the dock. It disconnected and reconnected automatically, reporting 393992 / `6.3.8` with the same serial identity. The first host observation timed out because the SDK's custom postboot expectation allowlist omitted 393992. The guard was corrected to admit that exact target, with regression checks preserving rejection of unqualified adjacent versions. After rebuilding SDK/main/preload and restarting only the app, the **same durable attempt** was confirmed by strict identity, custom-control, idle and card readbacks. No second firmware transfer was sent.

Two rejected offline predecessors are retained: compose-1 had inconsistent XML partition CRC metadata; compose-2 omitted the poll bridge body under all-C LTO. Neither was installed. The final build compiles only the thin poll wrapper with `-fno-lto`; the other C objects retain LTO. The deeper compiler omission mechanism remains unproven. The final bridge has a real 24-byte body and was executed by the exact-image fixture.

## Physical results

- F11A returned valid snapshots through the production SDK, IPC and preload on the installed H1E. Native state naturally reached 5; no state or mode was forced. Attempt/success counters advanced together, native getter status remained zero, and raw values included both 0 and 1.
- The first local speech playback lasted 9.01356 seconds through the explicitly selected H1E speaker endpoint: 1 of 17 active-playback samples was 1; all 7 samples after playback were 0.
- A second run used the same asset at player volume 0.8, without changing Windows or dock settings: 0 of 20 quiet-before samples, 15 of 65 active-playback samples and 0 of 55 ended-playback samples were 1. There were 11 runs of ones and 22 transitions between samples. Sampling intervals were approximately 137–188 ms, **not** a qualified detector latency.
- Both readout runs completed without missing or malformed responses. `voice` and `dspFreshness` remain `unknown`; the native DSP implementation, microphone-only response, general polarity and accuracy remain unqualified. No transcription, ASR or TTS synthesis was inferred.
- Original catalog: **580 files**, all names/sizes unchanged after installation, complete listing. Device settings, profile, format and marker rules matched before/after; native recording remained idle. A representative 120,972-byte original recording downloaded before and after installation had identical SHA-256 `c222c307565b4596c09acb7f3e221fafd131a07eddfcb377799670a045e5e08b`. This does not claim hashing every stored file.
- Saved application configuration hash remained `01b68e448f8477bb9c7caccbeaccd0fa6d7269f7a63e47b323f95596fb04dcda`; automatic connection/download/transcription remained false. No preferences or user library rows were rewritten for these tests.
- Existing F117 `slots` returned slot address `0x0000ef5c`, target word `0x0000b8a8`, PLL word `0x0000001c`. No arbitrary RAM read, dereference or execution was requested.
- The app was restored to normal development mode with the same profile and configuration; no recovery-disabled features remained. In that normal runtime, a fresh CMD1 returned 393992/6.3.8 and F11A returned a valid snapshot with 9,882 attempted/successful reads. An initial query immediately after `tryConnect()` returned `null` before CMD1 hydrated the exact-version identity; the subsequent explicitly qualified read succeeded. No guard was bypassed.

## Scope of acceptance

**Accepted:** installed engineering image operational readback, native cached-observation transport, successful native polling, preservation checks above, and raw-value association with controlled H1E output playback. **Still open:** microphone-only voice classification, DSP freshness/age, a general voice-presence contract, and product UI/automatic actions. This is not a general firmware release or closure of the separate full-device audit.

The complete per-query receipts, original audio and private identity remain local under `.diagnostics/vad-physical-20261016/`. The source-side summary is [VAD-PHYSICAL-OBSERVATION.md](../../research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/VAD-PHYSICAL-OBSERVATION.md). Duration acceptance from actual mono/stereo downloads is recorded separately in [the duration report](firmware-download-duration-2026-10-13.md).
