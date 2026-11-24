# @hidock/jensen-protocol

Transport-independent Jensen protocol core shared by the browser and Electron main process. `JensenDevice` takes a WebUSB-compatible backend; the package itself has no runtime dependency on a browser or node-usb backend.

See [the device guide](../../docs/devices/README.md), [wire protocol and version gates](../../docs/devices/protocol.md), and [firmware engineering](../../docs/devices/firmware.md). These distinguish stored H1E MP3, newer realtime PCM and PC capture, and document unresolved source identities.

## Source and exports

- [jensen-device.ts](src/jensen-device.ts): command IDs, USB IDs, transport queue/read path, payload handlers, settings, transfers and realtime methods.
- [index.ts](src/index.ts): public exports including `JensenDevice`, `CMD`, `parseRealtimePayload`, `supportsRealtimeFirmware` and `calculateDurationSeconds`.
- [Protocol tests](tests/jensen-device.test.ts): mocked transport behavior. They do not exercise physical firmware.

Current settings expose auto-record, auto-play, notification and Bluetooth tone. No native bitrate/profile or per-source-file API is qualified. Exact connected H1E 6.3.0 now supports bounded `getRecordingStatus()` (CMD29), `addNativeMarker()` (CMD28 `[1,3]`) and `toggleNativeRecording()` (CMD28 `[2,3]`). A key ACK means queued, with persistence unverified; the Electron owner supplies expected-file guards and durable deduplication. [One actual stock-device MP3/footer/decode test](../../research/rea/REPORT-NATIVE-MARKER-HARDWARE.md) confirms native add-now persistence. Arbitrary timestamps/text/channel payload are unsupported. For local MP3 marker copies, use [native_markers.py](../../research/rea/native_markers.py).

## Development

The [experimental H1E recording build](../../research/rea/REPORT-H1E-6.3.0-RECORDING-BUILD.md)
has explicit `getCustomRecordingProfile/setCustomRecordingProfile` methods and
strict REA1 record/response helpers in [custom-recording-profile.ts](src/custom-recording-profile.ts).
They require custom6.3.1 plus a capability response before mutation; stock6.3.0
receives no custom-profile command. Four stereo profiles and Q15 gains are
offline-qualified; the custom image is not installed. These methods do not
change the unsupported stock profile capability.

The full candidate also exposes `getCustomRecordingFormat/setCustomRecordingFormat`
and `getCustomMarkerRules/setCustomMarkerRules`, with strict REF1 and CRC-protected
MC36 records. Each optional mutation requires REA1 and its own capability reply;
an earlier profile-only image cannot qualify these commands. Native PCM16 stereo
WAV and bounded automatic audio-onset markers pass offline execution. Rules
default off. Real custom-image boot, NV persistence and physical source identities
remain unverified. Custom device file-list durations stay unknown until media is
measured rather than applying the stock fixed-bitrate estimate.

```powershell
npm.cmd --prefix packages/jensen-protocol run typecheck
npm.cmd --prefix packages/jensen-protocol test
npm.cmd --prefix packages/jensen-protocol run build
```

Keep device access under the application's single connection owner and serialized queue. Follow [the contributor guide](../../apps/electron/CONTRIBUTING.md) and [hardware-validation restrictions](../../docs/devices/README.md#safe-development-and-hardware-validation); do not run exploratory USB scripts against a connected device.

## Firmware update boundary

`getFirmwareUpdatePreflight()` performs serialized, sequence-correlated read-only
CMD29/CMD18/CMD16 checks for qualified H1E versions. The actual stock6.3.0 reply
uses28 card-info bytes; only its free/capacity/status prefix is interpreted. The
Electron owner exposes this preflight without serials. Mutation methods are not
exposed by its renderer bridge.

The scoped upload primitive follows vendor CMD8(version/size) then one full-body
CMD9, validates the exact accepted image and session, checks full USB writes and
strict ACKs, and fences uncertain outcomes without retry/reset. An acknowledged
upload is not installation or boot proof. [Update readiness](../../research/rea/REPORT-H1E-6.3.0-UPDATE-READINESS.md)
records the observed read-only preflight and physical-test limits. The user has
since deferred recovery work and requested firmware hardening.
Actual upload/boot and a revision-specific recovery/restore tool remain unverified.

The retained official6.3.0 and derived f699 native code already select a policy
that accepts different compatible versions, including older ones. A newer-only
host default is our software choice, not an established hardware prohibition.
The installed dock's policy flag has not been read back. See the
[actual-instruction policy proof](../../research/rea/downgrade630-lab/REPORT-STOCK-DOWNGRADE-POLICY.md).

`uploadFirmware` accepts explicitly selected ordinary H1E6.x images below6.16.0
that pass the selected SHA256, ACTTEST0/header/data/file CRCs, bounded directory,
XML partition metadata and decoded boot/FVER version/name/board checks. Its
session option `allowDowngrade:true` permits an older target. The default rejects
older targets before sending any command; equality always remains rejected.
This removes the arbitrary exact6.3.0-only rollback restriction. Unknown boot
layouts or family boundaries fail closed. CMD29 is used from6.3.0; older sources
use legacy CMD18 idle status plus the strict28B CMD16 response. The pinned
stock-code forward restore retains its separate exact-custom-session/REA1 guard.
There is no RBP1 command or new native policy patch. These host checks are not
cryptographic vendor authentication or physical acceptance/boot qualification.
