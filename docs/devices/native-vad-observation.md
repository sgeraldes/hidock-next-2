# H1E native VAD observation

Engineering firmware **6.3.8_vad001 (393992)** exposes the word already consumed by the native `RefChannelVAD` polling path. It adds no DSP query. The installed H1E was exercised on 16 October 2026; the readout responds and its counters advance during ordinary idle operation.

Use the existing app owner:

```ts
// After connecting, hydrate the identity used by all exact-firmware guards.
await window.electronAPI.jensen.getDeviceInfo()
const observation = await window.electronAPI.jensen.getNativeVadObservation()
```

The SDK method is `JensenDevice.getNativeVadObservation(timeout = 5, signal?)`. Its source admits the exact H1E pairs 393992 / `6.3.8` and 393993 / `6.3.9`, validates the current REA1 profile with F111, then sends F11A with body `01`. The reply is exactly 32 bytes. One serialized operation, deadline, connection generation, serial identity and exact reply sequence apply to both requests. Malformed replies, disconnects, changed identity and aborts return `null`. This is an engineering telemetry API; no UI voice indicator or automatic recording control is enabled.

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

The exact 6.3.0 CMD29 handler requests those levels only after its recording-active check. Its visible payload has one untagged array. Querying CMD29 while idle cannot expose microphone activity through this handler. The earlier trace incorrectly treated `0x00000b4c` as the recording-manager implementation; retained compiler-contract evidence identifies it as a halfword switch dispatcher, so its local branches in `0x0102d828` must be followed to find the actual producer. Similarly, `0x00000b38` is a byte switch dispatcher, not an opaque DSP service. Neither the channel meaning nor internal idle refresh follows from those helper calls. See [the level-source trace and correction](../../research/rea/completion630-lab/hardware-vad-trace/cmd29-level-source-20261017/REPORT.md).

Following those local branches identifies the amplitude producer: `0x0102be4c` accumulates absolute PCM16 magnitudes over 800 samples, scales the result to a byte and sends it to ring writer `0x0102bdfc`. The ring has 40 entries. The observed input paths combine pairs before aggregation and retain no per-channel labels. CMD29 option 12 consumes ring entries and advances its read index, so status queries are not passive level snapshots: independent consumers compete for entries. These are aggregate recording amplitudes, not independent microphone/system meters or speech decisions. See [the producer and input-route trace](../../research/rea/completion630-lab/hardware-vad-trace/rom-recording-provider-20261017/REPORT.md).

The later physical 393997 / `6.3.13` diagnostic resolves one previously missing runtime dependency: the fixed state tuple reads slot `0x000852a4` as `0x0101f93a`. Its receipt pins SYS SHA-256 `a86acfa502575c0151d31782996b91cebe5143e38f472aa5763915633e825c7e` and observation `2026-10-17T17:55:57.683Z`. That target lies inside SYS, so its implementation can now be inspected without another RAM query or firmware installation. This supersedes the earlier missing-runtime-target checkpoint for this slot only; it does not establish `VoiceEnergy` routing, output width, locking or microphone VAD behavior. See [the existing physical receipt](../../research/rea/completion630-lab/application/producer-continuation393997-physical-read/physical-receipt.json).

Firmware 393993 / `6.3.9_rom001` has since been installed by the firmware session. Four focused instruction cases passed on its exact decoded SYS: response with absent/present snapshot and poll-hook success/failure. They use synthetic RAM and a modeled native getter; the response cases start at the response wrapper, not the original ingress/parser. They establish neither live DSP behavior nor microphone voice detection. Static comparison preserves the ten VAD patch windows but finds two changed fallback calls into the enlarged parser/response muxes, covered separately by the producer's exact-image evidence. The SDK owner has now added exact 393993 / `6.3.9` admission in source, retaining 393992 / `6.3.8`. Adoption by the running app and physical F11A readout on 393993 remain separate verification boundaries. See [393993 compatibility analysis](../../research/rea/completion630-lab/hardware-vad-trace/compatibility-393993-20261017/REPORT.md) and [the focused instruction report](../../research/rea/completion630-lab/hardware-vad-trace/vad-exact-393993-20261017/REPORT.md).

The telemetry lives in the enlarged native object's tail and the code occupies the agreed router tail `0x01128a40..0x01129000`. The existing router and the complete console reservation remain intact. See [physical qualification](../qa/h1e-vad-6.3.8-2026-10-16.md) for image identity, preservation checks and remaining limits.

## VoiceEnergy integration in development

The second native getter is now traced through its SYS-local switch cases. The shared outer callback fixes the requested output at four bytes; the provider returns status zero for a full read and one for a short or failed read. The guarded adapter checks the expected callback slots, native state and enabled interrupts before invoking it from the existing scheduled poll context, outside the object guard. Its wait path has no established wall-clock deadline. This establishes a raw-call contract, not microphone routing or speech semantics.

The implementation adds a separate 32-byte cache at object offsets `+0x60..+0x7f`, retaining the original VADT tail. Its integration therefore requires both allocation and initialization to grow from 96 to 128 bytes before publication. Successful raw zero remains a valid sample; a failed read retains the last good word and records the latest status. F11A selector `02` reads this cache without invoking the getter; selector `01` retains the existing behavior. The new 32-byte response distinguishes envelope status from provider status and includes counters, sequence and a sample-present flag. Source, freshness and voice remain unknown.

The final provisional CK802 link contains 1,269 section bytes, has no unresolved symbols or relocations, and proposes exactly two constructor changes and three call-site changes against SYS 393998. Its address `0x01137000` is an evaluation coordinate pending reservation and expanded SYS mapping qualification. Source checks, eight focused host dispatch cases and three C-to-TypeScript codec cases passed. These are not installation or physical qualification. The SDK codec exists as a separate source module; transport exports, exact firmware admission and running-app adoption remain separate integration steps.

See the [integration contract](../../research/rea/completion630-lab/firmware/microphone-energy-cache-20261017/INTEGRATION-PLAN.md), [guarded provider](../../research/rea/completion630-lab/firmware/vad-provider-fixed-snapshot-20261017/RAW-ADAPTER-REPORT.md), and [integration review](../../research/rea/completion630-lab/firmware/microphone-energy-integration-review-20261017/REPORT.md). No VoiceEnergy firmware image has been installed by this work, and microphone VAD remains unqualified.
