# Native recording controls and live channel monitor: source port report

Date: 2026-10-13. Worktree: `C:\Users\Sebastian\.codex\worktrees\h1e-firmware-release\hidock-next-2` (base HEAD `a1256d6`).

Status: source port finished, built and unit tested. No runtime or device qualification has happened. No app was started, no USB was touched, no provider or model was called, no firmware image was read, Git was not touched.

## What this port does

It brings the accepted native recording controls and the live channel owner, tap and UI from the G checkout into this clean source branch. The SDK side was already here: the worktree copies of `jensen-device.ts`, `index.ts`, `native-recording.ts`, `realtime-channels.ts` and the built `dist/index.cjs` and `dist/index.d.ts` are byte-identical to G, so nothing was ported there. The installer source and the existing updater code (`firmware-handlers.ts`, `firmware-install*.ts`, their tests) were not edited.

## Behavior kept

- One owner and one CMD34 reader. `DeviceAudioSession` owns start, pause, resume and stop. `jensen:getRealtimeData` returns null unless the caller is the owner and the session is streaming, and a second call while a read is in flight returns null. No second reader and no new timer on the main side.
- The existing renderer poll in `Device.tsx` is the only dequeue loop. The channel tap rides on that same read.
- Two independent PCM16LE lanes (`channel-0`, `channel-1`) are split from the accepted packet with `splitRealtimeChannelsTap`, sent only to the owning renderer on `jensen:realtime-channels` with the session id, and unsubscribed through the function that `onRealtimeChannels` returns. A failure in the split is caught and cannot replace the poll result.
- Monitor mode sends `{ transcribe: false, saveRecording: false }`. That means no WAV, no sidecar, no `geminiLiveTranscription` call and no packet handed to a provider. The renderer keeps the user's save and transcribe checkboxes untouched during a monitor session, and keeps the monitor options through pause and resume.
- Names Microphone (lane 0) and System audio (lane 1) appear only when the device state is model `hidock-h1e`, version number 393988 and version code `6.3.4`. Every other device or firmware shows `Channel 0` and `Channel 1` and a line saying the source is not confirmed.
- No claim of 32 kHz, 48 kHz or 256 kbps input. The format is shown as a host expectation: 16 kHz, 2 channels, 16 bit.
- Native profile, format and marker-rule controls go through the existing guarded handlers (audited firmware pair, session idle, no USB operation in progress, no active transfer).
- No new firmware commands.

## Files

Hashes are the first 16 hex characters of SHA-256 of the bytes on disk. Worktree files use CRLF, the convention the worktree already had. The comparison with G ignores CR.

### Modified (12)

| File | Lines added/removed | SHA-256 (16) | Versus G |
|---|---|---|---|
| apps/electron/electron/main/ipc/jensen-handlers.ts | +155 / -26 | 4dc3f96c6607c1bf | adapted |
| apps/electron/electron/main/ipc/jensen-validation.ts | +5 / -0 | 7cff645d23be5b56 | copied (same ignoring CR) |
| apps/electron/electron/main/services/realtime-recorder.ts | +99 / -16 | 02a20185c2f5f17c | copied |
| apps/electron/electron/main/services/recording-watcher.ts | +41 / -2 | efccddae84ef9d72 | adapted |
| apps/electron/electron/preload/index.ts | +38 / -2 | 1bd07b08f9efdc33 | adapted |
| apps/electron/src/pages/Device.tsx | +342 / -47 | d1083d4920e63aa3 | adapted |
| apps/electron/src/services/hidock-device.ts | +5 / -2 | e0acd9cda577879f | adapted |
| apps/electron/src/services/jensen-ipc-client.ts | +3 / -2 | 6123ae803d372881 | copied |
| apps/electron/src/shared/feature-registry.ts | +1 / -0 | dada699cb5ced944 | adapted |
| apps/electron/electron/main/ipc/__tests__/jensen-handlers.test.ts | +248 / -20 | 30bb5c362b25a895 | adapted |
| apps/electron/electron/main/ipc/__tests__/ipc-channel-inventory.test.ts | +3 / -1 | 2368f5c7c4bd376c | adapted |
| apps/electron/electron/main/services/__tests__/realtime-recorder.test.ts | +66 / -1 | 90a49161c483097f | copied |

### New (14)

| File | SHA-256 (16) | Versus G |
|---|---|---|
| apps/electron/electron/main/services/device-audio-session.ts | f5016a9aee843c4f | copied |
| apps/electron/electron/main/services/device-audio-diagnostics.ts | 7a55e52d180e3ace | copied |
| apps/electron/electron/main/services/device-native-recording.ts | 08feccf14820a8c5 | copied, then root-directed guard correction (see addendum) |
| apps/electron/electron/main/services/device-audited-firmware.ts | 80d28f7e1bc65557 | copied |
| apps/electron/src/shared/device-audio.ts | 1ad60cf19780422f | copied |
| apps/electron/src/shared/device-native-recording.ts | 8399f91ea5e17995 | copied |
| apps/electron/src/components/DeviceNativeRecordingPanel.tsx | 93856a8149045fc3 | copied |
| apps/electron/electron/main/services/__tests__/device-audio-session.test.ts | e97e86a1f6684cce | copied |
| apps/electron/electron/main/services/__tests__/device-audio-diagnostics.test.ts | ed79eb2a45b798d0 | copied |
| apps/electron/electron/main/services/__tests__/device-native-recording.test.ts | 8cb2dd402a6fbc22 | copied, then root-directed guard correction (see addendum) |
| apps/electron/electron/main/services/__tests__/device-audited-firmware.test.ts | 69659062326506dd | copied |
| apps/electron/electron/main/services/__tests__/recording-watcher-capture-policy.test.ts | 8e2b16b7052216f3 | copied |
| apps/electron/src/components/__tests__/DeviceNativeRecordingPanel.test.tsx | caeb7e0db436eb1e | copied |
| apps/electron/src/pages/__tests__/Device.audio-capture.test.tsx | e61c36bedd2e578f | adapted (one test) |

Also in the worktree and not mine: `docs/devices/h1e-firmware-publication-report.md` (untracked before this task, left as is). This report is new.

### SDK files (unchanged, equal to G)

| File | SHA-256 (16) |
|---|---|
| packages/jensen-protocol/src/jensen-device.ts | dfccd5002ccda809 |
| packages/jensen-protocol/src/index.ts | 2d416f57d8bc6323 |
| packages/jensen-protocol/src/native-recording.ts | 423c40f698b8fcac |
| packages/jensen-protocol/src/realtime-channels.ts | 969354420373df82 |
| packages/jensen-protocol/dist/index.cjs | f26e3198116e01b6 |
| packages/jensen-protocol/dist/index.d.ts | f7e2092a0e5699b6 |

G reference: `apps/electron/src/pages/Device.tsx` in G has SHA-256 prefix `31a18238e188a981`, which matches the UI build SHA root gave (`31a18238e188a9816f110b50a5361155d053b99895f1bdf79b1c63af75ab73f0`). The worktree `Device.tsx` is not that file: it is an adapted subset (see below), so root should not expect the same UI hash.

## Adapted source, exactly what changed versus G

Device.tsx (G has these, the worktree does not):
- Removed the Drive panel (`DeviceDrivePanel`).
- Removed the local marker sidecar surface (`DeviceRecordingMarkers`) and its `deviceRecordingMarkers` API use.
- Removed the live provider and language selects, the "Refresh live availability" button and the remote Nemotron note, plus the `modelHost.status()` probe and the two config reads that fed them.
- Kept: Monitor channels button, Start/Pause/Resume/Stop with the options object, the diagnostics subscription, the identity subscription, the channel tap subscription, the `LiveChannelsPanel`, the native recording panel, the save and transcribe checkboxes, the neutral channel labels.

jensen-handlers.ts:
- Added the session owner, diagnostics, native control, the six custom-recording handlers, `jensen:getAudioDiagnostics`, `jensen:getNativeRecordingStatus`, `jensen:addNativeMarker`, `jensen:toggleNativeRecording`, the owner-gated start/pause/stop/getRealtimeData with the lane tap, and `endLiveAudioLocally`.
- Provider calls go straight to `geminiLiveTranscription` (G routes through `live-transcription-coordinator`, which also selects a remote Nemotron provider; that file was not ported).
- Not ported from G: the native verification recording (`startNativeVerificationRecording`, `protectNativeVerificationRecording`) and the file policy that goes with it, `jensen:getRecordingCapabilities`, `jensen:getRecordingProfile`, `jensen:setRecordingProfile`, the marker-capture binding, the drive/storage/scratch-upload/restore/backup code, and the shutdown helper. Existing worktree firmware handler registration and `getLiveRecordingState` stay as they were.
- `jensen:disconnect`, `jensen:reset` and the device `ondisconnect` callback now call `endLiveAudioLocally` instead of finishing the file and stopping Gemini directly. `finishLiveRecording()` is kept as an export (main/index.ts calls it) and delegates to the same path.

recording-watcher.ts: added `shouldAutomaticallyTranscribeRecording` and used it before queueing transcription, so a new `-Capture-Live` file is not transcribed automatically. G's first line, `isNativeFileManualOnly`, was left out because the native file policy file was not ported.

preload/index.ts: added the audio options argument to `startRealtime`, `getAudioDiagnostics`, `onAudioDiagnostics`, `onRealtimeChannels`, the native status/marker/toggle calls and the six custom recording calls. Not added: capabilities, profile, verification, firmware install calls and `deviceRecordingMarkers`.

feature-registry.ts: only `jensen:getAudioDiagnostics` added to the passive reads, because it returns in-memory snapshots and sends no USB command. G also lists `jensen:getRecordingCapabilities` and `jensen:getRecordingProfile` and some unrelated namespaces; none are needed here.

hidock-device.ts and jensen-ipc-client.ts: `startRealtime` forwards the options object. No other change.

Device.audio-capture.test.tsx: the marker test became "follows the owner session through diagnostics, adds no local marker surface, and tears down diagnostics". The other nine tests are G's.

jensen-handlers.test.ts: kept the worktree's file and replaced its realtime section with G's accepted realtime and native tests, added the native mock methods, the EventEmitter sender, the write-failure `fs` mock and `startCapture`. Update, firmware and download tests in that file are unchanged.

ipc-channel-inventory.test.ts: the expected list of passive jensen reads gains `jensen:getAudioDiagnostics`.

## Build and test results

All commands ran from `apps/electron` through `lowrun`, one at a time. Nothing was killed except my own stuck command (see the note at the end).

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` | exit 0 |
| `tsc --noEmit -p tsconfig.web.json` | exit 0 |
| `electron-vite build` (main, preload, renderer) | exit 0, built in 6.41 s; out/ now contains `jensen:realtime-channels`, `jensen:getAudioDiagnostics` and `jensen:getNativeRecordingStatus` in `out/main/chunks/index-CQOWm9F2.js` and `out/preload/index.js` |
| vitest, 14 files: jensen-handlers, ipc-channel-inventory, device-audio-session, device-audio-diagnostics, device-native-recording, device-audited-firmware, realtime-recorder, recording-watcher-capture-policy, DeviceNativeRecordingPanel, Device.audio-capture, Device.working, feature-registry, firmware-handlers, firmware-install | 14 files, 256 tests, all passed |
| vitest in `packages/jensen-protocol`: realtime-channels, native-recording | 2 files, 93 tests, all passed |

Order matters for one claim: the two typechecks ran before the last edits to three test files (handlers test, inventory test, audio-capture test) and before line-ending normalization. The build and the 256 tests ran after those edits. The typechecks were not rerun, as instructed. The full suite, lint, benchmarks and installers were not run.

The first handler run had four failures. They were tests that asserted the old behavior (Gemini always started, plain sender mock without `once`). They were replaced with G's accepted tests, not worked around. The first Device.audio-capture run had one failure, the marker test, and the inventory test had one failure, the passive-reads list. Both changes are listed above.

## Dependency resolution

`apps/electron/node_modules` is a real directory inside the worktree. `@hidock/jensen-protocol` in it is a symlink to `packages/jensen-protocol` in this worktree, and its `dist/index.cjs` contains `splitRealtimeChannelsTap` (3 hits) and equals G's dist. I scanned all 785 top-level entries in `apps/electron/node_modules` (scoped packages expanded): none is a link that leaves the worktree. So this source build resolves the protocol package from the worktree's own `src` and `dist`. `dist/` and `out/` are git-ignored; `dist/` is not part of the source diff, so whoever builds from a fresh checkout must run the package build first (`tsup` in `packages/jensen-protocol`). I changed no shared link and no package manifest.

## Concrete open items

1. Version 393989 / 6.3.5. Resolved by the root-directed correction in the addendum below: 393989/6.3.5 is no longer accepted by `device-native-recording.ts`.
2. Muted-microphone handling in the Gemini path. G's `gemini-live-transcription.ts` has a small change (`microphoneMuted === undefined && muted`) that the worktree copy does not have. It only matters when live transcription is switched on. Not ported (transcription scope). The local WAV and the tap already use the new rule.
3. Remote Nemotron live transcription, the provider and language selects, the coordinator, the owner-channel evidence rule in `live-channel-speakers.ts`, the Drive panel, local markers, the native verification recording with its manual-only file policy, and the capability and profile calls are absent by design. `main/index.ts` and `jensen.ts` were not touched.
4. No test covers the real renderer-to-main path together. The 256 tests use mocks for the device and for Electron.
5. `jensen-handlers.test.ts` still contains the original worktree tests for update preflight and downloads; they pass.

## Constraints for the one later real-app live check

- Live start order: the session start runs inside the device serializer. It reads CMD29 status and, for idle, confirms with CMD18, and refuses with "A native recording is active. Stop it before starting live capture" if the device is recording natively. Then it sends the single CMD33 start with mode 2. A start also fails when firmware does not pass `supportsRealtimeFirmware`.
- Monitor start from the UI sends exactly `{ transcribe: false, saveRecording: false }`. Expected: no `*-Capture-Live.wav`, no `.live.json`, no Gemini connection, `getAudioDiagnostics().session.transcribe === false` and `saveRecording === false`.
- Normal Start with the default checkboxes sends `{ transcribe: false, saveRecording: true }`. That writes `<stamp>-Capture-Live.wav` plus a `.live.json` with `capture.automaticTranscription: false`, and the watcher does not queue it.
- Only the window that started the stream can read. A second window sees "Another window owns this capture" and its Pause and Stop are disabled.
- The tap carries `sessionId`; the renderer drops taps whose id differs from the current session. Packets with no whole 4-byte frame produce no tap.
- Channel names show only for model `hidock-h1e`, 393988, `6.3.4`. On anything else expect "Channel 0 / Channel 1".
- Pause tries the device pause first and falls back to a stream stop, which is reported as a discontinuity. Resume starts a new CMD33 on the same host session.
- Native controls and the six custom-recording calls refuse (return null) while a live session is not idle, while a USB operation or a transfer is in progress, and on firmware outside the audited pairs (6.3.1, 6.3.2 and 6.3.4 for custom controls). The native journal lives in `<userData>/device-native-command-journal`.
- The CMD18 recording poll still runs every 20 seconds when no operation is in progress, as before. It is not a CMD34 reader.
- Qualification should use a build made from this worktree after running `npm run build` in `packages/jensen-protocol`, so the main bundle and the protocol package match this source.

## What is not claimed

No device, USB, app, provider or installer step ran. Nothing here shows that lane 0 is the microphone, only that the host labels it so on 393988/6.3.4 as the accepted G source does. Nothing shows a sample rate other than the 16 kHz host expectation, and no capture above it is claimed. The hashes above identify source, not behavior.

## Note on the earlier timeout

The wrapper reached its 60 minute limit. The only command of mine that hung was a `sed` call that read standard input because a shell variable was empty; I stopped that one (task `btdno0611`). No test fixture hung, and no other process was touched.

## Addendum 2026-10-13: root-directed guard correction

Root reviewed this report and ruled that 393989 / 6.3.5 has no accepted physical qualification for this port. Open item 1 above is resolved by this change.

Source change, two files only:

- `apps/electron/electron/main/services/device-native-recording.ts`: removed the `393989` / `'6.3.5'` pair from `qualifiedNativeVersion`, and removed "/6.3.5" from the error string. It now reads: "Native controls require H1E stock 6.3.0, qualified REA1 custom 6.3.1/6.3.2/6.3.4, or qualified forward stock 6.3.3". The accepted pairs through 393988 (6.3.0, 6.3.1, 6.3.2, 6.3.3, 6.3.4) are unchanged.
- `apps/electron/electron/main/services/__tests__/device-native-recording.test.ts`: removed 393989 from the four positive version lists (marker acknowledgement, live-start block, rejected-key persistence, verification hold). Added the coherent pair `[393989, '6.3.5']` to the existing "rejects incoherent/unknown native pair" case, which checks refusal before any status read, key or journal entry. The earlier mismatched cases stay as they were.

No other firmware policy, updater or SDK file changed. `device-audited-firmware.ts` already refused 393989/6.3.5 and was not touched.

| File | SHA-256 (full) |
|---|---|
| apps/electron/electron/main/services/device-native-recording.ts | 08feccf14820a8c50c0eaf6e449c28dc5b878df40332a013786abf099a4906f7 |
| apps/electron/electron/main/services/__tests__/device-native-recording.test.ts | 8cb2dd402a6fbc22fa4364ac5bf747ed4e8cad0240c051a8be52103b38090eb7 |

Results after the correction:

| Check | Result |
|---|---|
| vitest, `device-native-recording.test.ts`, one run | 1 file, 32 tests, all passed |
| `electron-vite build` (main, preload, renderer) | exit 0, built in 6.26 s. The rebuilt main bundle contains no `393989`, and its error text reads "qualified forward stock 6.3.3" |

Not rerun by direction: the earlier 256 and 93 tests, the typechecks, lint, any app, USB, provider or firmware action. The 256-test result in the table above was taken before this change and counted the old positive 393989 cases, so it no longer describes these two files exactly. The new file result is the 32 tests above. The two source hashes in the Files table above were updated to the values here. Hashes of all other files are unchanged.

Still out of scope and unchanged: the muted-microphone rule in `gemini-live-transcription.ts`, the remote Nemotron provider and coordinator, the Drive panel, local markers, the native verification recording, and the capability and profile IPC calls.

This is a source correction only. No runtime or device qualification has happened, and none is implied.

## Addendum 2026-10-13 (second): channel labels stayed neutral on a real 393988 / 6.3.4

Root's real-dock check streamed and stopped correctly with options false/false, and the files, settings and native controls were preserved. The panel showed "Channel 0 / Channel 1" on an actual H1E running 393988 / 6.3.4. Root read `getState` afterwards and it reported `hidock-h1e`, `6.3.4`, `393988`.

Cause, from reading the code, not from a device run:

- `Device.tsx` reads `jensen.getState()` once on mount, when nothing is connected yet, and after that depends only on `onStateChanged`.
- `device.onconnect` broadcasts `jensen:state-changed` right after the USB open. At that point `versionCode` and `versionNumber` are still null: they are filled in by the CMD1 reply handler (`jensen-device.ts`, the `GET_DEVICE_INFO` handler), which runs when `jensen:getDeviceInfo` is called later.
- `jensen:getDeviceInfo` returned the reply without publishing state, so no event ever carried the version. The renderer kept `versionNumber: null`, the exact-match gate (`hidock-h1e` + 393988 + `6.3.4`) stayed false, and the neutral labels stayed.

Fix, main process only, one handler (`apps/electron/electron/main/ipc/jensen-handlers.ts`): `jensen:getDeviceInfo` records the device identity (model, serial, version code, version number) before the read. If the read succeeds and the identity differs afterwards, it calls the existing `sendState()`. A repeated read that changes nothing publishes nothing. It adds no USB read (it publishes after the call the renderer already makes), no polling and no renderer change. The exact qualified-label guard in `Device.tsx` is unchanged, and no label is inferred for other firmware.

Regression test, in the existing `jensen-handlers.test.ts` (inside "connection-state push events"): connect with version null, check that the first broadcast carries null version, run `getDeviceInfo` with a reply that sets 393988 / 6.3.4, check that a new `jensen:state-changed` carries the qualified identity and that `jensen:getState` agrees, then run it again and check that nothing more is published.

| File | SHA-256 (full) |
|---|---|
| apps/electron/electron/main/ipc/jensen-handlers.ts | 7666ead96e2252e0a61a1a05f88c94fa9fcbbb04663cdbb3ea81fa35daa2f0d9 |
| apps/electron/electron/main/ipc/__tests__/jensen-handlers.test.ts | 92e93fa4a8ce579e454323023fd5e8ab4693e47f493f57839d1e771045a177d3 |

These two hashes replace the ones in the Files table for these two files. No other source file changed in this step.

| Check | Result |
|---|---|
| vitest, `jensen-handlers.test.ts`, one run | 1 file, 66 tests, all passed (65 earlier plus the new regression) |
| `electron-vite build` (main, preload, renderer) | exit 0, built in 6.13 s. The main bundle `out/main/chunks/index-C9zAqYWz.js` contains the new publish check |

Not rerun by direction: the earlier suites, typechecks, lint. No app, USB, provider or firmware action. The typecheck result in the main table predates this edit and was not repeated.

Note for the next real UI check: the labels switch on the first `getDeviceInfo` that succeeds after connect. If the renderer never asks for device info in a session, the labels stay neutral, because nothing else fills the version. That is the existing connect flow and was left alone. This is a source fix with unit evidence only; no runtime or device qualification is claimed.

## Root runtime acceptance: 13 October 2026, 05:20 UTC

The rebuilt isolated source was exercised through its real rendered Sync/Device page and trusted preload against H1E 393988 / 6.3.4. Monitor channels displayed Microphone and System audio with 3.1 KB received per lane and one packet. Stop returned the UI, live owner and native recorder to idle. Settings, native profile/format/marker rules and the 587-file catalogue matched before and after. Options were transcribe=false and saveRecording=false; no tone, saved capture, provider, setting change or firmware write was requested. The owned app quit gracefully. [Sanitized receipt and source hashes](evidence/h1e-native-live-393988.json).

The earlier real check caught the neutral-label identity defect; it was fixed and the bounded follow-up passed. An earlier recovery launch intentionally denied Device Sync and started no capture. The monitor check uses a normal launch with an isolated library, Device Sync on, and transcription/automatic transfers off. The pre-existing one-time configuration migration enabled autoTranscribe in the owned test profile on its first normal launch; transcription remained feature-disabled, and root restored that test preference before the follow-up. Production configuration was not touched.

Acceptance is scoped to this real monitor/stop and native-readback path. It does not prove cloud transcription, every physical route, higher capture rates, long-run performance, or the original 25-item audit. Native setters, saved audio, firmware upload and prior accepted tone/source checks were not repeated.
