# H1E native VAD observation

Engineering firmware **6.3.8_vad001 (393992)** exposes the word already consumed by the native `RefChannelVAD` polling path. It adds no DSP query. The installed H1E was exercised on 16 October 2026; the readout responds and its counters advance during ordinary idle operation.

Use the existing app owner:

```ts
// After connecting, hydrate the identity used by all exact-firmware guards.
await window.electronAPI.jensen.getDeviceInfo()
const observation = await window.electronAPI.jensen.getNativeVadObservation()
```

The SDK method is `JensenDevice.getNativeVadObservation(timeout = 5, signal?)`. It admits only H1E 393992 / `6.3.8`, validates the current REA1 profile with F111, then sends F11A with body `01`. The reply is exactly 32 bytes. One serialized operation, deadline, connection generation, serial identity and exact reply sequence apply to both requests. Malformed replies, disconnects, changed identity and aborts return `null`. This is an engineering telemetry API; no UI voice indicator or automatic recording control is enabled.

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `busy`, or `unavailable`; distinct from the native getter's return status. |
| `nativeState` | Original state byte; state 5 schedules the existing poll. |
| `attemptedReads`, `successfulReads` | Wrapping native poll counters. They are not utterance counts. |
| `lastCompletedNativeStatus` | Last completed native getter status. Zero means that read succeeded. |
| `hasSample` | Sticky after a successful sample, including a valid raw zero. |
| `lastSuccessfulCallerWord` | Last successful opaque 32-bit caller word; `null` before a sample. May remain stale after a failed read. |
| `sequence` | Snapshot sequence, not a timestamp. |
| `age`, `dspFreshness`, `voice` | `null`, `unknown`, `unknown`. No DSP freshness or general speech semantics are claimed. |
| `imageAttested` | Always false. Operational readback does not attest flash contents. |

In two controlled local speech playbacks through the explicitly selected **HiDock H1E speaker output**, the raw word changed between 0 and 1 while playback was active. In the more closely sampled run, 15 of 65 playback samples were 1; all 20 preceding and 55 following samples were 0. This establishes temporal association in that setup. It does **not** establish microphone-only voice detection, word recognition, universal polarity, false-positive rate or detection latency. Keep the raw value separate from a product-level “voice present” label.

On 17 October, the user spoke during one native recording. Independent channel analysis found activity on channel 0 during seconds 1–21, followed by quiet during seconds 22–35; channel 1 remained quiet. All 109 concurrent F11A observations returned raw zero with successful getter status. Therefore this path did not detect the captured microphone speech in that trial. See [microphone evidence](../qa/h1e-microphone-vad-evidence-2026-10-16.md). The earlier passive sessions contained no user speech and are not microphone-negative tests.

The existing CMD29 recording-status field `native.samples` provides a separate candidate for experimental level/activity controls during recording. In the same trial, 56 of 64 responses in the active interval contained a nonzero value; all 42 responses in the later quiet interval contained only zeros. Eight active-interval responses were also all-zero. The entries have no qualified units, channel assignment or speech semantics, and this observation does not establish an idle signal for starting a recording. Use a level/activity label, not a voice-present label. See [the retained status correlation](../qa/h1e-native-level-activity-2026-10-17.md).

Firmware 393993 / `6.3.9_rom001` has since been installed by the firmware session. The SDK guard above remains limited to 393992 until focused instruction-level checks qualify F11A and its native poll bridge against the exact new SYS. Static comparison preserves the ten VAD patch windows but finds two changed fallback calls into the enlarged parser/response muxes; version identity alone is not sufficient to widen admission. See [393993 compatibility analysis](../../research/rea/completion630-lab/hardware-vad-trace/compatibility-393993-20261017/REPORT.md).

The telemetry lives in the enlarged native object's tail and the code occupies the agreed router tail `0x01128a40..0x01129000`. The existing router and the complete console reservation remain intact. See [physical qualification](../qa/h1e-vad-6.3.8-2026-10-16.md) for image identity, preservation checks and remaining limits.
