# Internal audio and firmware implementation status

Current status at **12 October 2026, 23:19 UTC**: the everyday H1E runs custom **393988 /6.3.4_restore001** after the frozen image was flashed and automatically rebooted at 22:33:37 UTC. Same-device identity/capability/idle/card readbacks confirm operation, not a full installed-image SHA attestation. The current app transfer-contract run passed on 393988: 586-entry catalog/paging, bounded reads, owned-fixture match and exact 2,027,676-byte SHA-matched download. The 25-item ledger is **5 verified (A06, I01, I03, I04, P06), 15 in progress, 5 open**; P07 remains partial. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer evidence](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md) and [completion checklist](completion-checklist.md). Development/console delivery is the current target; installer/release qualification is parked.


11–12 October 2026. The accepted roadmap remains active. This ledger distinguishes
implemented host behavior, real local-file verification, passive device identity
and work still requiring exact-version code recovery or physical hardware evidence.
It is not a claim that the complete firmware roadmap has shipped.

## Current target and deployment boundary

The current dock runs **393988 /6.3.4_restore001**; upload, automatic reboot and same-device target/capability/idle/card confirmation passed without reset or unplug. The device does not attest the complete installed image SHA. Current transfer evidence covers a complete 586-entry catalog, bounded prefix/range reads, five ordered pages, one exact owned fixture and a 2,027,676-byte SHA-matched download. The corresponding A06/I01/I03/I04/P06 ledger entries are verified; the ledger remains 5/25, with 15 in progress and 5 open. Native four-profile controls, stereo output and markers have real 393986 evidence; 393988 settings are rendered/read back, but source labels remain neutral and 393988 capture/decode under each mode is not established. [Flash report](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer report](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md).

### Historical pre-flash baseline — 12 October 2026, 18:09 UTC

The dock then ran upload 2 **393986 /6.3.2**, selected container SHA256 `6940d83d790992d39d41791609b264d8b76041384b367076d7fbab1744c018f7`. One explicit prepared upload, autonomous reboot and exact same-device version/capabilities/idle/card confirmation passed without reset/unplug. Bounded help/version/uptime, owned 2092/556-byte commit/list/readback, sealed STATUS reconnect/app restart and a protected two-channel native WAV with one 3814 ms marker were observed. Original 558 names/sizes were preserved; the earlier562 snapshot included four owned tests; latest pre-393988 baseline 574 was scoped to 18:09 UTC, and all original bytes were not hashed. I04/P06 were qualified within those boundaries; I02 retains its separate stock resume evidence. The earlier SDK503/37 and journal62/IPC70/native25 checks are historical. SDK 601/44 Vitest suites/17 files, root IPC 74/source-helper 24/readback 33 and actual two-process Windows DPAPI 752-byte journal evidence support current source boundaries, not physical original-name restore. The earlier17,607-file ASAR proof is historical; the subsequent17,608-file/current 393986 package proof is recorded below. Source calibration, full restore, MSC, all 44 effects, persistence/endurance and conferencing remain open. [Physical upload2 report](../../research/rea/completion630-lab/runtime/REPORT-UPLOAD2-QUALIFICATION.md), [checklist](completion-checklist.md).

The historical pre-install app cache `jensen:getState` reported a connected H1E,
firmware **6.3.0**, packed version 393984, with no active recording. Serial is
not included in public docs. Board revision remains unknown. The official
**6.3.0_2606152123** original is now acquired and decoded. The historical
function map remains **6.2.5**, while the new exact **6.3.0** map and bounded
paired recording integration use independently verified target instructions. Historical
patch offsets are not reused without target verification.

The app was gracefully stopped, its prior compiled output preserved, rebuilt and
restarted in the same user profile. New main/preload handlers were observed in
that runtime. Real USB capture through the existing app owner received 512 valid
packets and persisted 819,200 stereo frames (51.2 seconds under the 16 kHz host
expectation) during a 60-second capture exercise plus pause/control overhead.
Programmatic markers survived saved-recording association; both mono exports
match every original lane sample. A missing database duration is resolved from
the bounded validated WAV parser. Native pause failed; an acknowledged realtime
stop/restart now pauses/resumes the same host file/session with a fixed paused
sample clock. No modified firmware was installed during those earlier stock checks, no second USB client opened,
and transcription was explicitly disabled for these checks.

The earlier recording-hardening artifact was the separate hardened **6.3.1_reaHard001 /393985**
image, SHA256`9a2e3acad3b239e765250d268d0678480cde2feb0012ab215c97f1eeb432099d`.
The [hardening report](../../research/rea/REPORT-H1E-6.3.0-HARDENING.md) identifies
its exact new-system lifecycle, codec, file/service and layout evidence.
The [final hardening evidence](../../research/rea/evidence/h1e-6.3.0-hardening/hardening-status.json)
binds those checks to that historical container and preserves their explicit model
and physical-verification limits. The old
f699 container and its preparation remain historical. These offline results do
not promote earlier stock-device capture into modified-firmware acceptance;
that9a2 milestone remains uninstalled. Later upload 2 boot and limited WAV/marker evidence are recorded above; other recording modes remain open.
The [current vault evidence](../../research/rea/evidence/h1e-6.3.0-hardening/backup-vaults.json)
records checked copies of the official package, hardened candidate and stock-code
forward restore onF: andG:. Those package copies do not back up installed flash,
device-specific writable data or personal recordings.

## Accepted roadmap coverage

| Accepted area | Implemented/evidenced now | Remaining gate or work |
|---|---|---|
| Actual dock identity | Current 393988 operational identity/capability/idle/card readbacks; historical stock393984 retained | Full installed-image SHA attestation, board revision and physical source mapping remain unknown |
| Exact current and newer official firmware | Official H1E 6.3.0 original downloaded through normal Google session; exact vendor ID/length/MD5 and SHA-256 retained | Exact current target acquired; newer targets are not substituted; no OTA invoked |
| Reproducible extraction and comparison | Exact 6.3.0 original SDK repack byte-identical; container/partition/boot-table/FVER CRCs, randomizer roundtrips, 35 resources and target instruction map | Complete physical board/linker/ROM/DSP contracts; board string alone does not prove compatibility |
| All recording producers | Exact 6.3 native mono producers, narrowband branch and dedicated/secondary live taps mapped; historical 6.2.5 retained separately | External/indirect/mode-specific producers and physical source routing not exhaustive |
| Mic, USB, Bluetooth and reference routing | Instruction-backed pre-mix change points and microphone-mute provenance | Controlled mode-specific source measurements and DSP/board routing |
| Individual microphone-array elements | Kept separate from processed microphone output in requirements | Raw-element availability and tap points unestablished; DSP ISA/board evidence required |
| Provider-free live capture | Deployed same-profile app and existing USB owner; real capture with `transcribe=false`, `saveRecording=true`; no rejected packets | Sustained mode-specific/source-controlled qualification |
| Channel diagnostics | Neutral IDs, RMS/peak/clipping, correlation/delay, producer-sequence metadata and rejected frames; bounded discontinuity metadata | Mic-only/playback-only/both/mute measurement; diagnostics cannot prove source isolation |
| Controlled source calibration | Bounded PCM16 WAV manifest comparison, declared conditions/thresholds, hashes, timing, channel metrics and relative leakage; generated-file verification | Physical captures in each relevant mode; source declarations and expected lanes are hypotheses, never inferred hardware identity |
| Preserved host capture | Strict aligned PCM pairs saved as synchronized stereo WAV; sidecar records assumptions and session ID | Device format/rate/mode validation; sustained one-hour capture and interruption/storage checks |
| Local individual-track export | Real saved capture exported through deployed preload/IPC; every lane sample checked exact and source hash unchanged | Native UI action not exercised in this app; device lane identities still unknown |
| Native two-channel MP3 | Complete experimental container preserves primary/secondary16k pairs and separate secondary8k FIR lanes; exact whole-image opener/drain/encoder/writer execution and independent decode pass | Physical source identities, real capture widths/concurrency and sustained throughput unverified; 393986 audio observations are historical and 393988 decode/capture acceptance remains open |
| Native MP3 quality profiles and gain | Stereo64/96/128/160 profiles, per-lane0..2x Q15 gain, guarded quantizer budgets and REA1 configuration snapshot integrated; seven whole-image execution/decode cases pass | Real NV persistence/reboot, UI acceptance, actual recording/profile transitions and hardware tests; stock profile API remains unsupported |
| Native PCM16 WAV/lossless and >2 sources | Native 16k paired PCM16 WAV, gains/partial-tail/header/stockfooter are integrated in the full candidate; exact-image execution and real host file import/export pass | One native paired WAV/manual marker was observed on 393986 before the flash; 393988 capture, sustained storage/power-loss/HiNotes and >2 native sources remain unqualified |
| Software markers and shortcut | Real active-session insertion and saved recording readback; unknown DB duration uses actual WAV frames; shortcut tested in representative UI | Native UI shortcut not exercised in this app; this does not write device-native marks |
| Existing native marker import | Bounded `HiDockVM` trailer parsing, stable provenance and millisecond times; actual downloaded stock MP3 independently read one 4,863 ms marker; representative UI checked exact 12345 ms seek with fixture file | HiNotes and actual Library UI recognition for the native hardware test remain unexercised |
| Native add-now/historical marker API | Exact 6.3 stock CMD28 `[1,3]` and guarded sole-owner API deployed; real stopped MP3 contained one 4,863 ms marker; duplicates suppressed across app restart | Arbitrary historical time/native text/channel payload, full 100-capacity and all role/test/mode acceptance remain unimplemented or unexercised |
| Automatic action/decision annotations | Opt-in cached analysis and later analysis updates; stable event IDs, ten-second spacing and max 80 automatic additions | Updated runtime/real cached-recording acceptance; no new provider request initiated by opt-in |
| Automatic audio events/native rules | Default-off detector/owned-session guard integrated;435 component cases and exact-image sample-clock WAV with native marker10044 ms/10368 ms pass, including durable host import;80auto/100total,10s spacing | Physical thresholds/source mapping, manufacturing modes and live cross-thread stop/footer timing remain unqualified |
| Settings bounds | Separate 6.2.5 experiment reproduced and verified offline | Recheck corresponding defect on exact 6.3.0; no cross-version patch applied |
| App playback/transcription integration | Existing live lanes, Library marker panel and neutral per-track exports retained; channel identity distinguished from speaker identity | Physical routing qualification and track-aware downstream transcription acceptance; >2-source/native files unavailable |
| ROM/DSP/toolchain reconstruction | Scoped CK802 compiler; seven compiled modules integrated beyond original system end, within physical partition/XIP capacity; exact partition/FVER/startup contracts | Original apparent caves remain startup RAM sources; complete vendor linker/board/ROM/DSP source map missing |
| Full native encoding validation | Current exact hardened-system lifecycle and codec stress execution, eight unchanged healthy outputs and realistic WAV marker timeline; opener/start/drain/config/gain/quantizer/staging/flush/close execute, including bounded full-staging cases | ROM/NV/FS/stream boundaries modeled; real device execution, sustained throughput, interruption and power loss remain untested |
| Retained recording-hardening container | Retained 3,413,504-byte paired/profiles/gain/WAV/rules image9a2e3,27 sites/seven modules; custom 6.3.1_reaHard001/393985;20 container groups/15 rejections/two byte-identical SDK rebuilds; exact system lifecycle proof bound | Historical uninstalled milestone; prior upload2/393986 had scoped boot/console/scratch/WAV-marker evidence; current 393988 boot/transfer is recorded above. Broader hardware remains open; vendor source rebuild unavailable; physical NV/storage/source isolation unverified; old f699 evidence preserved |
| Native recording failure-path hardening | Bounded exact reads; null FILE/context/bitstream fail-closed paths; checked staging/final-close error handling;72 exact whole-candidate lifecycle cases with zero findings, eight unchanged healthy outputs, realistic native 10044 ms marker timeline,13 codec stress cases and current host-file readback | Explicit ROM/NV/heap/stream/filesystem/clock models; real scheduling/interrupt/DMA, storage endurance and modified-device recording remain untested |
| OTA, boot, recovery and release | Exact SDK rebuild/readback; built host upload primitive; historical deployed read-only stock preflight with native 28B card reply; earlier host verification covered five retained images including9a2e3;29 actual-instruction cases prove known zero-flag source policy and sequence staging; prior upload 1/forward gate evidence is retained; the pre-flash upload2/393986 image has 182 pinned files and 78 added metadata fixtures | Installed policy flag unread; 393988 flash/automatic reboot and current 586-entry read-only transfer passed. Installer/release qualification is parked; downgrade/forward restore and broader persistence/security/recovery remain unverified |
| Documentation and provenance | Device guides updated, version-specific findings retained, fresh local-link audit | Update after each actual runtime/firmware/hardware result rather than treating source/mocks as shipment |

## Implemented host interfaces and defaults

- `jensen.startRealtime({ transcribe?, saveRecording? })`: defaults false/true;
  one owner controls lifecycle and dequeue, with explicit provider/recording
  errors. Capture format stays `host-expectation`, mapping `unverified`.
  New `-Capture-Live.wav` files declare `automaticTranscription=false` in their
  sidecar; the watcher requires a matching explicit opt-in before automatic
  transcription of this capture family, including its exported channel files.
- `jensen.getAudioDiagnostics()` / `onAudioDiagnostics()`: passive state and
  notifications from the same owner. Arrival gaps cannot establish device
  sample loss; pause/disconnect events do not invent missing WAV frames.
- `jensen.getRecordingCapabilities()` separates live, native and host features.
  Native profiles remain false/empty; insertion is gated to exact H1E 6.3.0.
  Profile get/set returns unsupported.
- `jensen.getCustomRecordingProfile/setCustomRecordingProfile`: explicit custom
  APIs, exact experimental version plus strict REA1 capability check, session
  recheck and idle guards. Updated app deployment was exercised on stock 6.3.0:
  both return null, native/live remain idle and auto-download remains enabled.
  Later upload 2 getters and WAV format store/restore are observed; gain/profile/rules modes and NV endurance remain unqualified.
- `jensen.getCustomRecordingFormat/setCustomRecordingFormat` and
  `getCustomMarkerRules/setCustomMarkerRules`: optional REF1/rules capability
  qualification follows REA1, with strict sizes/reserved fields/CRC and no
  retries. Original firmware rejects all four new command IDs without NV access.
  The corresponding firmware router is integrated and offline-qualified; no device support
  or calibrated automatic trigger is claimed.
- `jensen.getNativeRecordingStatus/addNativeMarker/toggleNativeRecording`:
  fresh status, expected-file/live/transfer/device guards and durable UUID
  deduplication. ACK is queued only; one real stopped MP3/footer confirms
  persistence. CMD33 live start refuses active/unknown native recording.
- `deviceRecordingMarkers.add/list/importNative/getSettings/setAutomation`:
  trusted recording/session IDs; local accepted versus imported native-file
  provenance. Native target returns unsupported. Saved timestamps use known
  duration; active timestamps use the capture sample clock.
- `deviceAudio.exportTracks(recordingId)`: local PCM16 WAV only, neutral channel
  names, synchronized timing, bounded memory and exclusive new files.

Automatic annotations default off and consume existing local analysis only.
New insertion stops at 100 total subject entries, with at most 80 automatic
entries and a ten-second spacing between automatic events. Native imports and
existing local annotations are preserved together in a combined snapshot that
can contain up to 200 entries; imports do not silently discard provenance.
Active-session markers are associated with the saved Library WAV using its
capture session ID. Host live audio-event detection is not installed; the separate
native rule module is included in the installed 393988 generation, with postboot rules disabled. Automatic triggering and physical calibration remain unqualified.

## Verification and runtime status

The later native-control milestone added bounded protocol/queue tests,
automatic-file-policy persistence/restart/corruption tests and owner/race
regressions. [Native hardware evidence](../../research/rea/REPORT-NATIVE-MARKER-HARDWARE.md)
records stock MP3 bytes, footer/parser/FFmpeg readback, duplicate suppression
before/after app restart and active-native live-start refusal. Test audio and
identifiers stay private; global automatic settings are unchanged and the
verification file has no Library/provider processing row.

The final native-control focused run passed **103 tests in eight suites**;
protocol checks passed **118 tests in three suites**. Node/web typechecks,
the production build and selected-file lint passed. These supporting checks
are separate from the observed stock-device marker/footer boundary above.
Two unrelated queue-drain tests retain pre-existing incomplete mocks; the
entire application test suite is not claimed to pass.

Previous host milestone checks passed **543 tests in 22 suites**: 538 in the integrated
21-suite run and five existing Device-page regressions in a separate run. These
cover owner/lifecycle races, rejected frames, actual temporary WAV
writes/readback/export, durable marker sidecars, native parsing and renderer
integration. Node and web typechecks and the isolated production build passed.
Owned captures stop once on route exit, including pending start/resume cleanup;
observer windows cannot dequeue or control another owner's stream. Marker
sidecar reads are bounded, and damaged capture association metadata does not
hide saved annotations. The
[isolated host runtime evidence](../../research/rea/evidence/host-runtime-verification.json)
records nine observed real Electron preload/IPC/filesystem checks using fixture
recording lookup and cached analysis. Representative built React controls also
exercised manual/shortcut insertion, native-file provenance, exact 12345 ms seek,
cached automatic annotations appearing immediately, visible export paths and
reload persistence with fixture transport. The
[retained screenshot](../../research/rea/evidence/host-controls-runtime.png)
shows that representative test UI, not the user's running Library. These checks
opened no USB connection and requested no provider. The
[integration summary](../../research/rea/evidence/host-integration-verification.json)
records the focused test, build and deployment boundaries.
The user's app now runs the new handlers. The post-hardware-fix focused run
passed **104 tests in five suites**, and both typechecks and a normal production
build passed. The [real hardware evidence](../../research/rea/evidence/hardware-capture-verification.json)
records packet metrics, exact WAV/track hashes, persisted marker and host pause
method. Detailed local filenames and audio remain outside public evidence.

The [firmware build report](../../research/rea/REPORT-FIRMWARE-BUILD.md) and
[build status](../../research/rea/evidence/build-toolchain/build-status.json)
separate the unintegrated 1,052-byte CK802 module, historical probes, exact-target
encoder/writer tests and earlier complete mono96 experimental container. The
[target integration report](../../research/rea/REPORT-H1E-6.3.0-INTEGRATION.md)
records its SHA-256, two-byte patch, 15 independent rebuild/readback/rejection
checks and immutable originals. Mono96 returns valid 432-byte frames and
preserves the test tone through actual target writer/staging instructions;
filesystem calls remain bounded intercepts. The earlier stereo probe used
unmodified producers and a temporary budget; it has been superseded by the
integrated paired/profiles/gain image linked in the coverage table. Mono128
failed decoding in the earlier experiment and was rejected. That older experiment was not installed; prior upload2/393986 has the limited physical evidence above. Current 393988 boot/transfer evidence is scoped separately. A vendor source rebuild and remaining hardware qualification stay open.
Both large apparent caves are consumed by startup RAM copies.

The [exact function map](../../research/rea/REPORT-H1E-6.3.0-FUNCTIONS.md) and
[published client controls](../../research/rea/REPORT-HINOTES-RECORDING-CONTROLS.md)
distinguish H1E status/level and remote-stop support from P1-only quality
selection. Stock native add-now dispatch is instruction-backed; its device
timing and final-footer persistence are separate verification criteria.

The [firmware tool verification](../../research/rea/evidence/firmware-lab-verification.json)
passed real baseline intake/readback/CLI, partition comparisons, 36 rejection
cases and independently decoded mono/stereo/padded MP3 fixtures. The encoder
there is FFmpeg libmp3lame, not HiDock Shine. The
[contract inventory](../../research/rea/evidence/firmware-contracts.json)
checks 51 original ROM call-site bytes, four resources and two DSP payloads.

The [calibration verification](../../research/rea/evidence/device-audio-calibration-verification.json)
uses actual generated WAV files with independently known sample values, CLI
output/readback and 20 rejection cases. Its evidence kind is synthetic.

File/algorithm and fixture checks are distinct from the real device capture
and native-footer tests linked above. Physical microphone/playback mapping,
one-hour throughput, OTA acceptance, modified-firmware bootability and recovery
remain unverified. One stock native file's marker persistence and actual stock
MP3 geometry are observed. Exact target acquisition and bounded mono96 offline construction
are resolved. Native feature integration and failure-path hardening are verified
offline in the current candidate. Source-controlled calibration and sustained
physical acceptance checks remain required for broader
firmware and hardware claims. Existing-app host capture/export/local-marker API
acceptance is observed.

## Offline source-hypothesis calibration

After loading the updated app, use its existing capture owner with transcription
off to save separate isolated-source and silence WAVs in each relevant operating
mode. Keep mute transitions and combined-source captures as additional evidence,
not replacements for isolated cases. Copy only explicitly selected calibration
files into a local test folder; the tool never discovers customer audio or opens
USB. PCM16 RIFF WAV with one to eight lanes is accepted; mixed rate/lane formats
make a comparison inconclusive, and compressed, truncated or partial-frame files
are rejected. Each comparison must use one declared model/version/mode.

Create a `calibration.json` beside those files. These labels describe controlled
test conditions. The nullable expected lanes below must be replaced with the
channel hypothesis being tested; they deliberately do not assert a mic/playback
mapping. Thresholds are explicit example criteria, not hardware-qualified limits.
Choose the required sources available in that mode and capture every required
isolated condition, including silence.

```json
{
  "schemaVersion": 1,
  "evidenceKind": "controlled-device-capture",
  "target": { "model": "hidock-h1e", "firmwareVersion": "6.3.0", "mode": "usb-conference" },
  "requiredSources": ["mic", "usb", "bt", "reference", "silence"],
  "thresholds": {
    "minimumSignalRms": 0.01,
    "maximumSilenceRms": 0.001,
    "maximumCrosstalkDb": -30,
    "maximumClippedFraction": 0
  },
  "captures": [
    { "id": "mic-only", "file": "mic.wav", "source": "mic", "isolated": true, "expectedChannel": null },
    { "id": "usb-only", "file": "usb.wav", "source": "usb", "isolated": true, "expectedChannel": null },
    { "id": "bt-only", "file": "bt.wav", "source": "bt", "isolated": true, "expectedChannel": null },
    { "id": "reference-only", "file": "reference.wav", "source": "reference", "isolated": true, "expectedChannel": null },
    { "id": "silence", "file": "silence.wav", "source": "silence", "isolated": true }
  ]
}
```

```powershell
python research/rea/device_audio_calibration.py C:/local-calibration/calibration.json --output C:/local-calibration/new-report.json
python research/rea/verify_device_audio_calibration.py
python research/rea/check_device_documentation.py --output research/rea/evidence/documentation-audit.json
```

The [tool](../../research/rea/device_audio_calibration.py) streams bounded sample
blocks and records SHA-256, rate/frame/lane counts, header-derived duration,
RMS/peak/DC/clipping, Pearson correlation and other-lane RMS relative to the
declared stimulus lane. Optional `capturedAt` must include a timezone; it remains
declared timing, not a measured device clock. Correlation is null for constant
lanes. Zero leakage has an explicit flag rather than a fictitious finite dB value.
Missing isolated conditions, unknown target identity or mixed sample formats
produce `inconclusive`. Complete coverage permits a threshold verdict of
`consistent-with-declared-hypothesis` or `does-not-match-declared-hypothesis`.
Every report keeps `physical_source_mapping=unverified`: declaring a source or
calling a capture controlled is not independent proof of physical isolation.
Output creation is exclusive, and originals are preserved. The
[rerunnable auditor](../../research/rea/check_device_documentation.py) checks local
files/headings; it does not verify external links or device behavior.

## Required next evidence

1. Extend the observed stock native add-now/footer case to full capacity and
   relevant role/test/mode conditions and actual marker UI acceptance. Native
   transport acknowledgements alone do not establish final file persistence.
2. Through the existing single owner, capture mic-only, playback-only and both
   with mute transitions in relevant operating modes. Inspect samples,
   crosstalk, correlation, delay, clipping and discontinuities.
3. Extend the [exact 6.3 function map](../../research/rea/REPORT-H1E-6.3.0-FUNCTIONS.md)
   and [verified target integration](../../research/rea/REPORT-H1E-6.3.0-INTEGRATION.md)
   to remaining indirect/mode-specific producers, real stereo/quality/gain
   runtime and physical full-buffer/finalization behavior. The hardened
   stereo/profiles/gain/WAV/rules image already passes bounded offline lifecycle,
   codec and full-staging/finalization cases.
4. Complete source/ROM/DSP/board contracts, native encoders/writers/control
    paths and remaining mode coverage. Current 393988 installation/operational boot is observed; development audio work remains active, while installer/release qualification is parked and recovery remains open.

12 October command/update follow-up: [contracts and host comparison](../../research/rea/REPORT-H1E-6.3.0-COMMAND-CONTRACTS.md) adds all 50 command rows, original 235-case native fixtures, corrected CMD1/CMD32/CMD34 handling and a durable candidate-specific installer. Physical preflight/preparation passed on stock 6.3.0. That historical 9a2 candidate remains uninstalled. Current 393988 flash/boot and transfer evidence passed; physical recovery/full restoration remain open.

## Subsequent current-generation observations

Historical pre-flash packaged checks at 18:11–18:13 UTC: the test app completed 574/574 listing, f117 help, profile/format/rules getters and an owned 556-byte full-SHA readback on then-current 393986; f119 was rejected before dispatch with zero device writes. The package verified17,608 payload files, both exact 393988 image resources and native SQLite/USB loading; the normal installed application was not replaced. One eight-byte same-value CMD12 request succeeded in 31 ms with all four settings unchanged and native idle before/after. These checks did not prove an original-name restore. [Packaged boundary](../../research/rea/completion630-lab/application/restore4-packaged-boundary.json), [physical current-generation smoke](../../research/rea/completion630-lab/runtime/restore4-package-current-custom-smoke.json), [same-value settings proof](../../research/rea/completion630-lab/runtime/guarded-settings-same-value-1791828838995.json).
## Original-name restore and latest software boundary

The installed 393988 RSTR2 interface and main/preload service implement trusted-source original .hda/.wav names≤27,2 GiB−1, explicit source/session ownership and no existing-final overwrite. Expected SHA in a device reply is stored provenance; completed full downloaded SHA equality is required for restore-verified. Actual WindowsDPAPI sealing/reopen passed using two isolated Electron processes and752-byte ciphertext; native media restoration was not involved. The package image backups are actual checked/flush-written file copies, not flash/NV backups. Physical f119 restoration remains open. [Restore contract and chronology](restore-original-recordings.md), [OS evidence](../../research/rea/completion630-lab/application/restore-service-dpapi-physical.json), [backup ledger](../../research/rea/completion630-lab/application/restore4-firmware-backups.json).

Latest SDK source SHA is dfccd5002ccda809855148b6e4d7871cedb28304e2979b39f922a28ddc5bf5df; ESM2846e9e5ee03b34d00b2d04b42473eb6d9884eacbf2d3076d524d81ea5d90190 and CJS2dc0864fb6900107a20925caf3f6cbcf3ac37c75b282a6a60413b1b169e3f93d. CMD12 now sends eight bytes; CMD7 filename/CMD21 signed-range/CMD26 index arithmetic align with hardened guards. [601-test source/build evidence](../../research/rea/completion630-lab/protocol/set-auto-record-verification.json). Flash/boot is complete for this iteration; original-name small/9 MiB/full-SHA restoration, all original 44 effects, complete restore, source/endurance/peripheral/NV/MSC/ROM gates remain open or parked. No 25-item completion claim follows.



