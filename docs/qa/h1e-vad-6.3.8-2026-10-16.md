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
- Both playback readout runs completed without missing or malformed responses. `voice` and `dspFreshness` remain `unknown`; the native DSP implementation, general polarity and accuracy remain unqualified. No transcription, ASR or TTS synthesis was inferred.
- Original catalog: **580 files**, all names/sizes unchanged after installation, complete listing. Device settings, profile, format and marker rules matched before/after; native recording remained idle. A representative 120,972-byte original recording downloaded before and after installation had identical SHA-256 `c222c307565b4596c09acb7f3e221fafd131a07eddfcb377799670a045e5e08b`. This does not claim hashing every stored file.
- Saved application configuration hash remained `01b68e448f8477bb9c7caccbeaccd0fa6d7269f7a63e47b323f95596fb04dcda`; automatic connection/download/transcription remained false. No preferences or user library rows were rewritten for these tests.
- Existing F117 `slots` returned slot address `0x0000ef5c`, target word `0x0000b8a8`, PLL word `0x0000001c`. No arbitrary RAM read, dereference or execution was requested.
- The app was restored to normal development mode with the same profile and configuration; no recovery-disabled features remained. In that normal runtime, a fresh CMD1 returned 393992/6.3.8 and F11A returned a valid snapshot with 9,882 attempted/successful reads. An initial query immediately after `tryConnect()` returned `null` before CMD1 hydrated the exact-version identity; the subsequent explicitly qualified read succeeded. No guard was bypassed.

### 17 October: controlled microphone-only speech trial

- The user reported speaking for about 20 seconds during a separate native recording. Start verification was acknowledged, an active recording was confirmed privately, and stop was acknowledged with the device returning idle. F11A only read the existing getter and did not start recording; no recording-light state was inferred from that readout. A subsequent normal library download completed through the existing queue and persisted one recording locally. Filenames, device identity, and audio are omitted; the recording and private analysis copy remain private.
- The earlier no-speech Windows microphone capture separately verified the exact H1E endpoint at 48 kHz stereo and was closed before this native trial. The native 35.6-second recording decoded as 16 kHz stereo. Channel 0 showed voice activity during seconds 1–21 (maximum window RMS −22.69 dB) and quiet during seconds 22–35 (window RMS −67.3 to −61.6 dB). Channel 1 remained low across the analyzed windows (−67.1 to −64.7 dB RMS).
- Concurrent F11A readout produced 109 valid samples, all raw `0`, with native state `5` and getter status `0`. Microphone speech was captured on channel 0, but `RefChannelVAD` did not produce a nonzero value in this trial. This is a negative result for this specific setup and interval; it does not define universal microphone-VAD behavior.
- The user confirmed no speech occurred in the earlier 55-second passive and UAC intervals (297 and 261 samples, respectively). Their all-zero samples are not negative microphone-voice tests. Low UAC levels in those no-speech intervals do not imply a capture failure.

## Scope of acceptance

**Accepted:** installed engineering image operational readback, native cached-observation transport, successful native polling, preservation checks above, and raw-value association with controlled H1E output playback. A controlled microphone-only trial captured speech on one channel while the getter stayed at raw `0`; this is evidence for that trial only. **Still open:** a general microphone-voice/VAD contract, DSP freshness/age, and product UI/automatic actions. The separate `VoiceEnergy` provider contract and any additional query remain unqualified. This is not a general firmware release or closure of the separate full-device audit.

The [microphone evidence review](h1e-microphone-vad-evidence-2026-10-16.md) identifies the separate static `VoiceEnergy` wrapper and why there is no demonstrated passive sample for it. Further microphone-only acoustic trials can use the existing F11A command without adding a DSP query; a separate energy getter needs its provider contract first.

The complete per-query receipts, original audio and private identity remain local under `.diagnostics/vad-physical-20261016/`. The source-side summary is [VAD-PHYSICAL-OBSERVATION.md](../../research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/VAD-PHYSICAL-OBSERVATION.md). Duration acceptance from actual mono/stereo downloads is recorded separately in [the duration report](firmware-download-duration-2026-10-13.md).

The separate 17 October native microphone trial's receipts are retained under `.diagnostics/vad-microphone-20261017-native/`, including the final idle state, original-580-entry preservation check and exact SHA-matched normal-library file. The stored test file has 36 whole seconds with file provenance; it is retained on the dock and locally.
