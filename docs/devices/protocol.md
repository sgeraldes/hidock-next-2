# Jensen protocol reference

Current status at **12 October 2026, 23:19 UTC**: the everyday H1E runs custom **393988 /6.3.4_restore001** after the frozen image was flashed and automatically rebooted at 22:33:37 UTC. Same-device identity/capability/idle/card readbacks confirm operation, not a full installed-image SHA attestation. The current app transfer-contract run passed on 393988: 586-entry catalog/paging, bounded reads, owned-fixture match and exact 2,027,676-byte SHA-matched download. The 25-item ledger is **5 verified (A06, I01, I03, I04, P06), 15 in progress, 5 open**; P07 remains partial. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer evidence](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md) and [completion checklist](completion-checklist.md). Development/console delivery is the current target; installer/release qualification is parked.


Updated 12 October 2026 against [jensen-device.ts](../../packages/jensen-protocol/src/jensen-device.ts) and [its exports](../../packages/jensen-protocol/src/index.ts). The host groups below are distinct from the [exact firmware command inventory](../../research/rea/REPORT-H1E-6.3.0-COMMANDS.md). See [model/version gates and audio-path distinctions](README.md).

The [all44 map](command-map630.md) retains original6.3.0 contracts with scoped runtime evidence. Prior installed 393986 has physical f117 console and f118 generated-name scratch readback evidence. Current SDK gates recognize exact custom393988/6.3.4 and stock-forward393989/6.3.5 for their source-qualified roles. f119 requires393988 plus distinct RSTR2 capability, explicit owner operations and full source/readback SHA; 393986 rejects it without probing. The current 393988 transfer evidence validates the read-only listing/range/page/download path; it does not qualify f119 restoration. No reply attests running flash bytes. [Physical393986 report](../../research/rea/completion630-lab/runtime/REPORT-UPLOAD2-QUALIFICATION.md), [current transfer report](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [command delta](../../research/rea/completion630-lab/map/restore393988-command-delta-report.md).

Accepted resources are custom393988 (`4942c98f...`,6.3.4_restore001) and offline forward393989 (`f3fd009a...`,6.3.5_reaRestore2). Forward preparation requires exact custom393988/6.3.4; only the explicit known393989/6.3.5→393988 return permits downgrade. Older393986/393987 images/evidence remain preserved. The user prohibits routine stock transitions; the CLI requires an operator-requested recovery flag before contacting the owner for stock execution. [Exact artifacts and boundaries](restore-original-recordings.md#exact-artifacts-and-evidence), [install owner](../../apps/electron/electron/main/services/firmware-install.ts).

Begin/append/commit/abort/status scratch operations use the serialized sole owner, explicit owned-file consent and normal-Jensen/MSC/audio assurances. Raw native IDs/tokens stay in main and ownership is sealed with Electron safeStorage; process handles are rebound only through an explicit fresh same-device STATUS. Actual reconnect and app close/relaunch STATUS plus whole SHA readback passed. Earlier 13:36 rejection is preserved; initial information/card/settings now share serialization. Generated-name scratch writes are not original-file/full restoration, power-loss atomicity or proof of every race. [Current owner/runtime evidence](../../research/rea/completion630-lab/runtime/REPORT-UPLOAD2-QUALIFICATION.md).

Exact original H1E6.3.0 recognizes44 Jensen IDs:1–13,16–26,28,29,32–34,
0xf001–0xf00b and 0xf00e–0xf011. All 65,536 unsigned16-bit IDs were checked in
both normal application request and response selectors. The hardened recording
candidate adds six IDs0xf110/0xf111/0xf113–0xf116. Full payload checks, response
geometry and effects are in the [50-ID catalog](../../research/rea/commands630-lab/COMMANDS.md).
Recognized routing does not guarantee acceptance in every state or safe malformed
request handling. No physical command was exercised by this inventory pass.

The retained public client declares recording-quality30/31 and Bluetooth/input
IDs0x1001–0x100a that this original H1E6.3 dispatcher does not recognize. They
must not be inferred as H1E capabilities from the host constants alone.

## Transport and framing

`JensenDevice` receives a WebUSB-compatible backend: browser `navigator.usb`, or the Electron main-process node-usb backend. It maintains a continuous receive path, a serialized command queue, handler dispatch and tag-correlated responses. The main-process polled backend copies reusable libusb buffers. Device operations should go through this connection owner, not an additional USB reader.

Endpoints are OUT `0x01` and IN `0x82`. The protocol frame header is:

| Offset | Bytes | Field |
|---|---|---|
| 0 | 2 | Magic `0x12 0x34` |
| 2 | 2 | Command ID, big endian |
| 4 | 4 | Sequence/tag, big endian |
| 8 | 4 | Body length, big endian |
| 12 | Body length | Command-specific body |

These wire fields are distinct from the little-endian PCM samples and native MP3 marker trailer. A command constant's presence in the host does not demonstrate support in every firmware version.

## Current host command groups

| IDs | Operations |
|---|---|
| 1–3 | Device information and time |
| 4–7, 13, 21 | File listing/count, whole/block/partial transfer and delete |
| 8–9 | Firmware-upgrade request/upload |
| 11–12 | Get/set settings |
| 16–20 | Card information, format, recording filename, factory settings plus SD storage reset, meeting schedule |
| 22–25 | Tone and UAC updates |
| 28–29 | Exact H1E 6.3.0 native key actions and bounded recording status |
| 32–34 | Realtime settings, control and PCM transfer |
| 4097–4104 | Bluetooth control/status, battery and paired-device operations |
| 61451, 61456–61457 | Factory-state reset and USB write-timeout set/read on exact H1E6.3; legacy host naming must not imply Bluetooth semantics |

Destructive/update operations above describe existing API surface, not instructions to execute them during research. For precise payloads and responses, use the command handlers and public methods in the source; do not infer payload layouts from names.

CMD19 (`0x0013`) invokes the same SD erase/format helper as CMD17, in addition
to settings and application changes. It is destructive to locally stored
recordings. Diagnostic0xf00b is a separate factory-state operation; its reviewed
handler does not call that formatter. Neither command name establishes a CPU
reboot. Exact0xf010/0xf011 write/read `WEB_TIMEOUT`; the reviewed native fields
do not represent a Bluetooth timeout.

## Realtime

The host gate is H1 5.3.0; H1E 6.3.0 below its C1 version gate of 6.16.7 and 6.17.0 at/above that gate; P1 1.3.8; P1 Mini 2.3.0; H1 Lite 3.1.0. `supportsRealtimeFirmware` rejects unknown models and null versions. Version values are packed as `(major << 16) | (minor << 8) | patch` for these comparisons.

`startRealtime(mode=2)` sends control body `[0,0,0,1,0,0,0,mode & 3]`; pause uses `[0,0,0,2,0,0,0,0]` and stop `[0,0,0,0,0,0,0,0]`. Exact 6.3.0 instructions store the final byte as channel count: 0 defaults to mono, 1 sums A+B, and 2 preserves the paired lanes. Values outside 0–2 are rejected before sending; values above 2 can stall that firmware loop. CMD32 uses a different representation: reply format 1 denotes internal channel count 2. See [exact target contracts](../../research/rea/REPORT-H1E-6.3.0-FUNCTIONS.md).

The transfer parser preserves the full body. On exact H1E6.3, the first big-endian uint32 is producer sequence-minus-one; the second is system microphone mute (true when1). The host exposes `sequenceMinusOne` and `microphoneMuted`, with deprecated `rest`/`muted` aliases. This is not queue depth or a whole-stream mute instruction; qualified firmware PCM is preserved, including laneB. The host capture owner expects subsequent interleaved PCM16LE at 16 kHz with two lanes and rejects malformed frame alignment. This is a `host-expectation`, not a negotiated/measured device format. Channel labels remain neutral; inferred/pinned microphone labels are not hardware evidence. This newer realtime route must not be equated with H1E 6.2.5's stored mono MP3 route.

`getRealtimeSettings` currently returns only `enabled`, derived from body byte 0. It does not fill in `sampleRate`, `channels` or `bitDepth`; those optional interface fields are not measured capabilities. `calculateDurationSeconds` uses model/file-version assumptions, including 96 kbps for P1 version-5 recordings. Do not generalize the analyzed H1E 64 kbps setting to every file or use duration heuristics as channel-format evidence.

The main-process handler fans packets out to strict stereo WAV saving, passive diagnostics, the renderer and optional Live transcription. Attach additional consumers to that fan-out rather than issuing another command-34 dequeue. `jensen.startRealtime({ transcribe?: boolean, saveRecording?: boolean })` defaults to provider-free capture with saving enabled. `getAudioDiagnostics`/`onAudioDiagnostics` expose cached counters without a separate USB read. Provider failure is reported separately and does not stop capture. See [live audio access](live-audio.md) for lifecycle, track export and file metadata.

The legacy `getRecordingCapabilities()` convenience response separates host features from its limited native flags. Live availability comes from the host version gate, format from host expectations, and physical source mapping remains `unverified`. Native profile-control remains false with an empty profile list. Marker insertion is gated to exact H1E 6.3.0. `getRecordingProfile()`/`setRecordingProfile(profileId)` return `unsupported`. Separate exact custom REA1/REF1/REM1 APIs expose profile/gain/format/rules, and the qualified native marker/toggle API supports its explicit stock/custom pairs; the legacy convenience flags are not a complete firmware capability inventory.

## Recording settings and markers

Current `DeviceSettings` exposes auto-record, auto-play, notification and Bluetooth tone. The reviewed H1E 6.2.5 settings handler has length-boundary defects; the [experimental bounds variant](../../research/rea/REPORT-JENSEN-SETTINGS-BOUNDS.md) addresses those checks offline. It does not add bitrate, sample-rate, channel or marker controls.

Exact H1E 6.3.0 maps CMD28 body `[1,3]` through the stock key table to event `0x8b` and native option 3. It marks the current native elapsed time; it cannot carry arbitrary timestamps, labels or channel IDs. `[2,3]` toggles native start/stop and is not an idempotent stop. Both actions acknowledge queueing only; role/test-mode/state/capacity can prevent the intended operation. The marker cap is 100. The [local marker-copy utility](../../research/rea/native_markers.py) needs no Jensen connection.

`electronAPI.jensen.getNativeRecordingStatus()` reads CMD29 with an empty request. A bounded active response is `[type,N,filename(N),secondsBE16,M,levels(M)]`. Levels are display samples, not calibrated dB or separated channels. Malformed/unknown replies fail closed. Empty status is corroborated with CMD18 before treating the device as idle. `addNativeMarker({requestId,expectedRecording})` and `toggleNativeRecording({requestId,expectedRecording})` require an exact supported stock/custom H1E version (including custom 393986/6.3.2 and 393988/6.3.4), the current expected filename and idle host live capture. Starting native recording uses `expectedRecording:null`; marking requires a filename. Durable UUID reservations prevent repeats, including inconclusive commands after restart. Returned `acknowledged` means queued; `persistence` remains `unverified` until a stopped MP3 trailer is read. Native-target requests to the local sidecar API below remain separate.

CMD33 starts live capture by stopping native recording and reuses its encoded MP3 staging RAM. The app now reads fresh native status before CMD33 and refuses active or unknown state. A hardware button can still change state between the final read and command; there is no firmware atomic conditional-start API. `startNativeVerificationRecording({requestId,expectedRecording:null})` holds the shared USB operation chain through fresh idle status, queued toggle, bounded active-file polling and durable manual-only protection before automatic scans can proceed. Verification can also register only its current file with `protectNativeVerificationRecording(filename)`. Both preserve global download/transcription settings.

The implemented host API is `deviceRecordingMarkers`: `add`, `list`, `importNative`, `getSettings`, and `setAutomation`. It accepts recording/session IDs, not renderer-supplied filesystem paths. `add` takes a UUID `requestId`, optional uint32 `atMs`/label/source and a `local` or `native` target. Local accepted results are `accepted-local`; retries return `duplicate`. Other results include `inactive`, `invalid`, `full`, `automation-disabled`, `rate-limited` and `unsupported`. Native target requests return `unsupported` without a device write. Omitted time is supported for active sessions using the owner's elapsed sample clock; saved files require a time within known duration.

Native import reads at most the 412-byte file tail, validates the MP3/trailer and preserves native millisecond timestamps in a sidecar with `native-file` provenance. It does not alter audio or the device's copy. Imports refresh the trailer snapshot while preserving local annotations; the stored combined snapshot can contain up to 200 entries. New additions are limited to 100 total subject entries. Automatic additions are off by default, at least ten seconds apart and at most 80, and use stable IDs for existing cached action/decision analysis. An API source enum for `audio-event` does not imply an implemented automatic audio detector.

The host track-export API is `deviceAudio.exportTracks(recordingId)`: uncompressed local PCM16 WAV is split into neutral mono tracks with identical frame timing. The deployed app's real USB capture, saved-session marker association and sample-exact exports were exercised on H1E 6.3.0. Native pause returned failed; host pause falls back to an acknowledged realtime stop and resumes into the same file/session. This does not add a native pause command. [Implementation status](implementation-status.md).

## Evidence boundaries

The [experimental recording build](../../research/rea/REPORT-H1E-6.3.0-RECORDING-BUILD.md)
adds separate `getCustomRecordingProfile/setCustomRecordingProfile` APIs gated
to custom H1E6.3.1 plus a strict REA1 capability reply. GET0xf111 returns17 bytes
(stored/fallback flag plus16-byte record); SET0xf110 accepts that record alone
while recording/live are idle. The record contains profile0..3 for
64/96/128/160 kbps and two big-endian Q15 gains0..65536. Fallback does not prove
that NV data is absent, and an ACK does not prove persistence. Stock 6.3.0
receives no custom-profile commands. Native CMD28/29 on the experimental version
also require REA1 qualification; stock native behavior remains version-specific.
The original 6.3.1 milestone remains uninstalled. Prior installed upload2/393986 has the scoped getter/WAV/manual-marker observations in the physical report; 393988 control settings have rendered/readback evidence, while all MP3 profiles/gains, automatic rules and power-cycle persistence remain unqualified.

Optional extensions require their own strict capability reply after REA1.
REF1 GET0xf114 returns9 bytes (status plus8-byte record); SET0xf113 accepts
`REF1`, format0MP3/1WAV and three zero reserved bytes. Native rule GET0xf116
returns37 bytes; SET0xf115 accepts36 native little-endian bytes: magic
`0x3633434d`, version 1, size36, enabled0/1, neutral lane0/1/2, mean-magnitude
threshold1..32767, two zero reserved words and IEEE CRC32 over the first 32 bytes.
Generation is allocated by the device per session and is never persisted in
the config. These IDs were checked against the original parser and retained
vendor enum; stock returns unsupported with no NV calls. Host setters verify
each optional contract before writing, so the earlier REA1-only candidate cannot
accept a WAV/rules mutation. Default MP3 and disabled rules preserve explicit
opt-in; physical thresholds and source identities remain uncalibrated.

USB IDs and gates come from current source. Historical 6.2.5 contracts remain version-specific; [the exact official 6.3.0 function map](../../research/rea/REPORT-H1E-6.3.0-FUNCTIONS.md) adds current native/live/key contracts. The [current published client review](../../research/rea/REPORT-HINOTES-RECORDING-CONTROLS.md) separates H1E controls from P1 quality selection and browser upload encoding. Protocol mocks, offline emulation and container checks do not demonstrate a physical device's runtime support.

## Current restore and request-bound alignment

f119/RSTR2 uses original flat ASCII .hda/.wav names≤27, maximum2 GiB−1,≤1024-byte append and 4096-byte verify/recover steps. Expected SHA is stored provenance; only complete downloaded SHA equality yields host restore-verified. Explicit STATUS/recovery, sealed same-device source/owner records and no existing-final overwrite remain required. [Original recording restore contract and evidence](restore-original-recordings.md).

The hardened CMD12 parser requires8/12/16 bytes. setAutoRecord now emits eight bytes, preserving the other field with trailing zeros. CMD7 filename checks align to27 bytes for H1E; CMD21 enforces signed offset/end and CMD26 record-index×57 arithmetic bounds before OUT. CMD5 already had its H1E27-byte gate. These offline host repairs avoid requests that the hardened firmware would reject without ACK; they are not new physical settings/deletion/large-range proofs. [Setter/vendor/native-guard evidence](../../research/rea/completion630-lab/protocol/set-auto-record-verification.json), [latest combined SDK results](../../research/rea/completion630-lab/protocol/sdk-combined-settings-final-tests.json).
## Subsequent current-generation observations

Historical pre-flash packaged checks at 18:11–18:13 UTC: the test app completed 574/574 listing, f117 help, profile/format/rules getters and an owned 556-byte full-SHA readback on then-current 393986; f119 was rejected before dispatch with zero device writes. The package verified17,608 payload files, both exact 393988 image resources and native SQLite/USB loading; the normal installed application was not replaced. One eight-byte same-value CMD12 request succeeded in 31 ms with all four settings unchanged and native idle before/after. These checks did not prove an original-name restore. [Packaged boundary](../../research/rea/completion630-lab/application/restore4-packaged-boundary.json), [physical current-generation smoke](../../research/rea/completion630-lab/runtime/restore4-package-current-custom-smoke.json), [same-value settings proof](../../research/rea/completion630-lab/runtime/guarded-settings-same-value-1791828838995.json).



