# HiDock device documentation

Current status at **12 October 2026, 23:19 UTC**: the everyday H1E runs custom **393988 /6.3.4_restore001** after the frozen image was flashed and automatically rebooted at 22:33:37 UTC. Same-device identity/capability/idle/card readbacks confirm operation, not a full installed-image SHA attestation. The current app transfer-contract run passed on 393988: 586-entry catalog/paging, bounded reads, owned-fixture match and exact 2,027,676-byte SHA-matched download. The 25-item ledger is **5 verified (A06, I01, I03, I04, P06), 15 in progress, 5 open**; this is scoped progress, not full completion, and P07 remains partial. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer evidence](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md) and [completion checklist](completion-checklist.md). Development/console delivery is the current target; installer/release qualification is parked.


### Historical pre-flash baseline — 12 October 2026, 18:09 UTC

At that time the everyday H1E ran **393986 / 6.3.2**, following one explicit upload of upload 2 **6.3.2_audit001**, SHA256 `6940d83d790992d39d41791609b264d8b76041384b367076d7fbab1744c018f7`, and its automatic reboot without reset/unplug. Same-device version/capabilities/idle/card confirmation, bounded USB console help/version/uptime, owned-file CRC/SHA/MD5 readback and one protected native WAV/manual-marker lifecycle were observed. The original 558 names/sizes remained preserved; they were not all byte-hashed. The earlier count562 included four owned tests; the pre-393988 baseline was 574. I04/P06 were qualified within those boundaries. The earlier ASAR qualification predates later owner sources; subsequent 18:11 packaged-current 393986 acceptance is recorded below. The official 6.3.0 original and earlier stock/upload 1 evidence remain historical. [Physical upload2 report](../../research/rea/completion630-lab/runtime/REPORT-UPLOAD2-QUALIFICATION.md), [stock app evidence](../../research/rea/completion630-lab/runtime/REPORT-STOCK-APP.md), [upload2 snapshot](../../research/rea/completion630-lab/firmware/generation-upload2/generation-snapshot.json).

The earlier deployed-app 60-second capture saved51.2 seconds of received stereo samples, with exact per-lane exports and a persisted programmatic marker. Host pause/resume uses acknowledged stream stop/restart when native pause fails. Board revision and physical source mapping remain unknown. Historical firmware addresses below apply only to6.2.5. [Earlier capture evidence](../../research/rea/evidence/hardware-capture-verification.json).

## Start here

- [Completion checklist](completion-checklist.md): observed component passes, exact outstanding requirements and blockers; all items must pass before full completion.
- [All44 original command map](command-map630.md): exact request/reply/effect/unit/source contracts and separately scoped physical observations.
- [Device drive](device-drive.md): read-only Windows facade, mount controls, tested IO and the existing50MB WebClient limit.
- [Console access](console.md): observed bounded393986 USB status bridge, current 393988 version gate and unqualified UART/arbitrary shell.
- [Full validation and access plan](validation-plan.md): console, all 44 original commands, listing/download, resume/performance, native/virtual drives and remaining audio/firmware qualification.
- [Jensen protocol and compatibility](protocol.md): transport, command groups, version gates and API boundaries.
- [Live audio access](live-audio.md): provider-free channel capture, strict stereo WAV, diagnostics, software markers and local track export.
- [Implementation status](implementation-status.md): every accepted roadmap area, delivered evidence and remaining firmware/hardware gates.
- [Firmware engineering](firmware.md): installed 393988 and preserved earlier generations, recording changes and remaining validation.
- [Restore original recordings](restore-original-recordings.md): f119/RSTR2 owner, names/size/CRC/SHA limits, OS-sealed journal and pending physical restoration.
- [Recording investigation](../../research/rea/REPORT-RECORDING-PATHS.md): both recovered PCM feeds, MP3 quality, channel separation and native markers.
- [Protocol package](../../packages/jensen-protocol/README.md): source entry points and development checks.
- [PC meeting recorder](../pc-meeting-recorder.md): Windows mic/system capture, a separate host recording path.

## Models recognized by the current host code

The [protocol source](../../packages/jensen-protocol/src/jensen-device.ts) recognizes vendor IDs `0x10d6` and `0x3887`, and these product IDs:

| Host model | Product IDs | Host realtime minimum |
|---|---|---|
| H1 (`hidock-h1`) | `0xaf0c`, `0xb00c`, `0x0100`, `0x0102` | 5.3.0 |
| H1E (`hidock-h1e`), below C1 version gate | `0xaf0d`, `0xb00d`, `0x0101`, `0x0103` | 6.3.0 |
| H1E at/above the C1 version gate of 6.16.7 | Same H1E model classification | 6.17.0 |
| P1 (`hidock-p1`) | `0xaf0e`, `0xb00e`, `0x2040` | 1.3.8 |
| P1 Mini (`hidock-p1-mini`) | `0xaf0f`, `0xb00f`, `0x2041` | 2.3.0 |
| H1 Lite (`hidock-h1-lite`) | `0x0104` | 3.1.0 |

These are identification and version checks in the host, not a hardware certification matrix. Unknown models and unavailable firmware versions fail the realtime gate. H1E 6.2.5 is below its realtime minimum; its reviewed dispatcher has no recovered commands 32–34. Do not use the newer live-stream API as evidence for the stored MP3 format of this older image.

## Three distinct audio paths

| Path | Format and channel handling | Source identity |
|---|---|---|
| H1E 6.2.5 recordings stored on the device | CPU-side modified Shine; 16 kHz, 64 kbps mono MP3. Both recovered PCM feeds sum A+B or select B before encoding | A is associated with system microphone mute; B and external DSP premixing remain unresolved by mode |
| Jensen realtime on supported firmware | Host expects an 8-byte metadata header followed by interleaved PCM16LE. Current live service splits channels; its mono helper averages them | Channel-to-source mapping requires a scoped measurement or user pin; two channels alone do not prove two speakers |
| Windows PC meeting recorder | Stereo WebM/Opus, 128 kbps target; mic is routed left and system loopback right by the host graph | Routing is explicit in the PC capture implementation; this does not establish HiDock lane identities |

The firmware's PCM sum and the host mono helper's average are different operations. Stored mono MP3 cannot recover independent sources lost before encoding. Speaker diarization and channel identity are also different: a channel may contain multiple people or acoustic bleed. The live service's noise-floor inference is a heuristic, not proof of the device's physical wiring.

The development host capture supports provider-free streaming and optional stereo WAV saving before transcription. The single owner preserves aligned lane pairs without mono duplication, records passive diagnostics and reports malformed frames/discontinuities. Local PCM16 WAV recordings export sample-exact independent tracks. Source identity is qualified for the current H1E 393988 normal USB mode: live channel 0 is microphone and channel 1 is system audio; other modes retain neutral names. The rendered Monitor channels action was verified with saving and transcription disabled. See [live audio access](live-audio.md).

## Recording quality and independent channels

The stock H1E 6.2.5 parameters are hardcoded. Its encoder contains two-channel processing, but both recovered input callbacks remove separation. A stereo change must preserve A/B through both feeds, update channel count and MPEG mode, and cover the secondary narrowband FIR branch. Separate files require additional stream/encoder/file contexts.

Changing only the bitrate is insufficient: the stock initializer fixes the frame budget at 288 bytes. At 16 kHz/128 kbps it must be 576 bytes. These are historical 6.2.5 constraints. The custom 393986/393988 recording core implements stereo MP3 profiles of 64/96/128/160 kb/s total, gains and native WAV. A current 393988 native stereo WAV was captured and decoded at 16 kHz; its system-audio lane was measured in normal USB mode ([evidence](../../research/rea/completion630-lab/runtime/current393988-system-audio-lane.json)). This does not qualify every mode, every profile on 393988, or sustained operation. Higher real sample rates require an upstream producer and matching encoder timing/buffers; the ADC/DSP rate limit is still unknown ([current capture-rate investigation](../../research/rea/completion630-lab/application/CAPTURE-RATE-BOUNDARY.md)). See the historical [codec evidence](../../research/rea/REPORT-CODEC-QUALITY.md) and [audio routes](../../research/rea/REPORT-AUDIO-ROUTES.md).

## Device markers and local annotations

The native internal operation `record_mgr_setoption(3, NULL)` adds the current elapsed time, up to 100 markers. The normal stop path appends:

```text
8 bytes "HiDockVM" | uint32 LE count | count × uint32 LE elapsed milliseconds
```

This is a 12–412-byte trailer, not an ID3 chapter block. Exact H1E 6.3.0 maps stock CMD28 `[1,3]` to the internal add-now action. The deployed native API produced a real device MP3 with one marker at 4,863 ms; duplicates were suppressed before and after app restart. Historical timestamps require an operation beyond this add-now handler. [Hardware verification](../../research/rea/REPORT-NATIVE-MARKER-HARDWARE.md).

For downloaded files, the [offline utility](../../research/rea/native_markers.py) can inspect or add timestamps to a new MP3 copy without re-encoding:

```powershell
# Run from the repository root; source is preserved and existing output is refused.
python research/rea/native_markers.py inspect "recording.mp3"
python research/rea/native_markers.py add-copy "recording.mp3" "marked.mp3" --at-ms 12500 47000
```

Times are milliseconds; callers must supply times within the recording duration. The utility merges native markers, caps their count and rejects malformed trailers. Generated MP3 copies decoded identically with FFmpeg in nine CLI cases. It does not modify the device's stored file or update the application's timeline; recognition by HiNotes/device UI remains untested.

The host marker panel/API adds durable local annotations, including Ctrl+Shift+M, and imports native MP3 trailer marks. Optional local automation reuses cached action/decision analysis, starts no provider request and defaults off; automatic additions are ten seconds apart and limited to 80, with new additions capped at 100 total subject entries. The separate exact-version `jensen.addNativeMarker` API writes a current-time device marker. Its ACK does not prove persistence; stopped-file readback did so for the hardware test. [Historical marker evidence](../../research/rea/REPORT-MARKER-PATHS.md) and [current host API](protocol.md#recording-settings-and-markers).

## Safe development and hardware validation

PCM16 WAV marker imports now validate the entire RIFF layout and accept a
HiDockVM trailer only after its boundary. The running app's saved test capture
was read through the trusted API with its local marker and source hash preserved;
generated native WAVs also pass individual-lane export and marker file checks.
Historical 393986 observation: one protected native two-lane WAV/manual marker. The current 393988 controls have rendered/readback evidence, while sustained/source-controlled capture behavior and HiNotes interpretation remain untested.

Use offline firmware artifacts and mocked transports for development. The running app owns its continuous read path and serialized command queue; do not start a second USB client, raw endpoint probe, repeated open/close loop, reset or experimental flash to validate documentation. No USB access is needed for the checks below.

Physical validation needs an explicitly scoped procedure using a single connection owner under the repository's device restrictions. For channel separation, test each operating mode with distinct microphone/playback signals, mute transitions, synchronization and sustained recording. For live markers, exercise inactive/full/error states and read back the completed recording. Offline checks do not establish OTA acceptance, bootability or recovery.

## Documentation map and evidence status

| Document | Role/status |
|---|---|
| [Implementation status](implementation-status.md) | Accepted roadmap ledger, host source/filesystem evidence and current runtime/hardware blockers |
| [Firmware implementation](../../research/rea/REPORT-FIRMWARE-IMPLEMENTATION.md) | Actual H1E 6.3.0 target, verified intake/comparison/frame tools and candidate SDK ROM ABI contracts |
| [Exact 6.3.0 functions](../../research/rea/REPORT-H1E-6.3.0-FUNCTIONS.md) | Native/live/encoder/key/status contracts matched to exact instructions |
| [Integrated recording build](../../research/rea/REPORT-H1E-6.3.0-RECORDING-BUILD.md) | Historical recording container;10 offline cases/11 decodes; later installed upload 2 has scoped physical evidence above |
| [Update readiness](../../research/rea/REPORT-H1E-6.3.0-UPDATE-READINESS.md) | Built protocol/read-only preflight; actual stock 28B card reply checked; recovery-first physical gate, no upload |
| [Exact 6.3.0 integration](../../research/rea/REPORT-H1E-6.3.0-INTEGRATION.md) | Earlier fixed mono96 container and preserved version-specific prototype evidence |
| [Native marker hardware test](../../research/rea/REPORT-NATIVE-MARKER-HARDWARE.md) | Real stock MP3 footer/decode and app-restart deduplication |
| [Published HiNotes controls](../../research/rea/REPORT-HINOTES-RECORDING-CONTROLS.md) | H1E versus P1 UI controls and separate browser-upload encoding |
| [Firmware extraction report](../../research/rea/REPORT-H1E-6.2.5.md) | ACTTEST0 offsets, randomizer, C-SKY load map, resource provenance |
| [Recording function map](../../research/rea/REPORT-RECORDING-FUNCTIONS.md) | Address-level map, updated with both producer paths and parameter meanings |
| [Recording paths](../../research/rea/REPORT-RECORDING-PATHS.md) | Integrated findings, checklist, copy utility and reproduction |
| [Audio routes](../../research/rea/REPORT-AUDIO-ROUTES.md) | Two CPU feeds, mute provenance, HAL and unresolved DSP sources |
| [Codec/quality](../../research/rea/REPORT-CODEC-QUALITY.md) | Modified Shine, bitrate/rate tables, frame-budget constraints |
| [Markers](../../research/rea/REPORT-MARKER-PATHS.md) | Add-now event, native footer, local utility and API limits |
| [Settings-bounds experiment](../../research/rea/REPORT-JENSEN-SETTINGS-BOUNDS.md) | Separate offline length-check variant; no channel, quality or marker feature |
| [REA setup](../../research/rea/README.md) | Installed tooling and local analysis workflow |
| [Realtime research](../performance/2026-09-22-hidock-realtime-research.md) | Dated vendor snapshot, with current-code and firmware addendum |
| [Live stereo design](../superpowers/specs/2026-09-22-live-stereo-speaker-channels-design.md) | Host channel splitting and inferred labels; hardware attribution remains unverified |
| [Device-list incident](../performance/2026-09-27-device-list-freeze.md) | Historical host performance findings, not firmware evidence |
| [Community migration](../community-migration.md) | Model-specific community provenance; P1 findings do not generalize to H1E |
| [HiDock plan](../superpowers/plans/2026-09-24-hidock-plan.md) | Historical work plan with current firmware-research update |
| [Live ownership decision](../decisions/2026-09-28-noche.md) | Historical `.live.json`/owner inference; physical lane identity remains a separate validation |
| [Brain service design](../superpowers/specs/2026-09-22-brain-service-design.md) | Knowledge reader versus the existing USB connection owner |
| [Recording checks design](../superpowers/specs/2026-09-24-recording-checks-design.md) | Audio analysis versus source preservation and native marker provenance |
| [Feature gating](../architecture/feature-gating.md) | Host settings versus firmware capabilities and connection ownership |

The root/app READMEs, contributor guide and release-documentation links also point here. Older dated specifications, incidents and release entries retain their historical scope; this documentation update does not report an unmerged firmware feature as shipped. General transcription, model-host and calendar documents that only mention device downloads do not establish hardware capabilities and need no recording-format rewrite.

Check evidence using [the reproduction commands](../../research/rea/REPORT-RECORDING-PATHS.md#verification-and-practical-limits) and the [implementation ledger](implementation-status.md#verification-and-runtime-status). Retained firmware results include 190 codec-validator cases, seven configuration/header fragments, two secondary PCM cases, ten marker cases, four footer cases and nine local marker-copy CLI cases. Current app deployment, paired live capture/export and one stock native MP3 marker insertion/footer readback are observed separately. Physical source isolation, sustained modified-firmware encoding and the complete native-feature roadmap remain unverified; the current 393988 installation does not resolve those questions.

Current 12October follow-up: [per-command contracts, host discrepancies and image-bound preparation](../../research/rea/REPORT-H1E-6.3.0-COMMAND-CONTRACTS.md) documents the native case ledgers, corrected protocol/audio handling and actual read-only physical preflight. That9a2 milestone remains uninstalled; current 393988 installation and bounded transfer results are linked above, with 393986 upload2 observations retained as history.

## Subsequent current-generation observations

Historical pre-flash packaged checks at 18:11–18:13 UTC: the test app completed 574/574 listing, f117 help, profile/format/rules getters and an owned 556-byte full-SHA readback on then-current 393986; f119 was rejected before dispatch with zero device writes. The package verified17,608 payload files, both exact 393988 image resources and native SQLite/USB loading; the normal installed application was not replaced. One eight-byte same-value CMD12 request succeeded in 31 ms with all four settings unchanged and native idle before/after. These do not qualify original-name restoration. [Packaged boundary](../../research/rea/completion630-lab/application/restore4-packaged-boundary.json), [physical current-generation smoke](../../research/rea/completion630-lab/runtime/restore4-package-current-custom-smoke.json), [same-value settings proof](../../research/rea/completion630-lab/runtime/guarded-settings-same-value-1791828838995.json).



