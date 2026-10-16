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

The telemetry lives in the enlarged native object's tail and the code occupies the agreed router tail `0x01128a40..0x01129000`. The existing router and the complete console reservation remain intact. See [physical qualification](../qa/h1e-vad-6.3.8-2026-10-16.md) for image identity, preservation checks and remaining limits.
