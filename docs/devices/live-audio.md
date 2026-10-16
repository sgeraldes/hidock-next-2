# Accessing HiDock live audio channels

Updated from current H1E 393988 / 6.3.4_restore001 evidence and retained firmware analysis. The firmware-only public H1E v6.3.4 release is complete; app installer/release qualification remains parked. Public downloads, sizes, SHA-256 values and the source-pinned guide were verified in the [publication evidence](../../research/rea/completion630-lab/application/public-firmware-publication.json) ([v6.3.4 release](https://github.com/sgeraldes/hidock-h1e-firmware/releases/tag/v6.3.4)). The dock's current identity/readbacks do not attest its installed image byte-for-byte. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json).

For current 393988 normal native USB/UAC WAV capture, the accepted mapping is **Channel 1/left = microphone** and **Channel 2/right = system audio**. A separate current 393988 mode-2 live sample establishes the scoped CMD34 mapping **channel-0 = microphone** and **channel-1 = system** below. These mappings belong to different transports; neither establishes Bluetooth routing, raw microphone-array access or a device-wide source map. See [model/firmware gates](README.md#models-recognized-by-the-current-host-code) and the [implementation ledger](implementation-status.md).

## Existing tap point

The host already implements the newer Jensen live-audio route. CMD33 starts/stops it; CMD34 is an empty-query dequeue (the SDK's legacy offset argument is ignored), rather than a completed-recording download. The CMD34 body begins with BE32 `sequenceMinusOne` and BE32 system-microphone-mute metadata, then interleaved audio. In mode 2, the current host expects each 4-byte frame to be lane 0's int16LE sample followed by lane 1's int16LE sample, at 16 kHz. That rate is a host expectation, not negotiated or measured on the live stream:

```text
existing Jensen connection owner
  -> getRealtimeData() / command 34
  -> packet: metadata | channel 0 sample | channel 1 sample | ...
     -> diagnostics: neutral channel statistics and discontinuities
     -> RealtimeRecorder: strict stereo WAV, when saving is enabled
     -> splitRealtimeChannels(): optional Live transcription
     -> splitRealtimeChannelsTap(): neutral `onRealtimeChannels` event
     -> jensen:realtime-data: renderer notification
```

The actual fan-out is in [jensen-handlers.ts](../../apps/electron/electron/main/ipc/jensen-handlers.ts). Its `splitRealtimeChannelsTap` call copies each accepted CMD34 packet into two mono PCM16LE buffers and sends `jensen:realtime-channels` to the owning renderer only. In the owning renderer, live capture starts through `window.electronAPI.jensen.startRealtime({ transcribe: false, saveRecording: false })`; the existing `DeviceAudioSession` loop supplies the CMD34 polls. The renderer subscribes with `window.electronAPI.jensen.onRealtimeChannels(callback)`, which returns an unsubscribe function. The callback receives `sessionId`, `receivedAtMs`, `sequenceMinusOne`, `microphoneMuted`, `frameCount`, `sampleRateHz`, `sampleRateEvidence`, `pcmFormat`, `channels` (two `{ id, pcm }` entries with neutral `channel-0`/`channel-1` IDs and separate `Uint8Array` buffers), and `droppedTrailingBytes`. The tap omits any trailing bytes that do not complete a 4-byte stereo frame. The source path and public API have passed a physical 393988 mode-2 normal-USB live boundary check, and the Device-page subscription is now verified at the rendered UI boundary below.

Public SDK commit `a1256d6` contains the channel splitter helper only in the firmware-install branch; it does not ship the Electron UI. The subscription and panel remain development-app source, with rendered UI verification recorded below.

[splitRealtimeChannels](../../apps/electron/electron/main/services/gemini-live-transcription.ts) separately feeds the optional Live transcription consumer. New consumers must share the existing CMD34 packets; they must not issue competing dequeue requests or open another USB client.

The verified live labels apply only to current H1E 393988, mode 2, normal USB in the tested setup. Two lanes do not establish access to every microphone element, USB source or Bluetooth direction; mode-specific processing or duplication may differ. Keep the native Channel 1/2 names separate from the live `channel-0`/`channel-1` IDs.

The exact official H1E **6.3.0_2606152123** image now establishes the following
version-specific routing in its instructions. The dedicated live callback
`0x01031bac` preserves the original interleaved A/B PCM buffer in format 2;
format 1 sums the lanes into mono. System microphone mute zeros lane A before
the live write. In the secondary Bluetooth capture callback `0x01050b0c`, the
non-8-kHz branch passes the original paired buffer to `0x0103257c`; the 8-kHz
branch passes mono after mixing/FIR, which is duplicated when two output lanes
are requested. Therefore two live lanes can preserve distinct producer samples
in supported paths, while narrowband duplication remains possible. These
instructions establish lane handling, not the physical identity of lane B or
raw access to individual microphone elements. The
[target manifest](../../research/rea/h1e-6.3.0-original/manifest.json) pins the
image; exact-version exports are retained with the firmware investigation.

CMD33 action 1 starts live and can stop native recording; live/native capture
share the device's MP3 staging RAM. Exact H1E 6.3.0 command analysis records
that action 1 changes the firmware auto-record state; the 393988 command-delta
model records action 0 restoring the recording setting. These are versioned
command evidence, not by themselves a physical live result on current 393988. The app reads
fresh CMD29 before starting/resuming live capture, corroborates idle with CMD18
and refuses active or unknown state. A physical hardware-button race is still
possible, so future bounded live checks should read and verify the prior
auto-record setting. The current sample preserved `autoRecord: true` and all
other settings with zero setting writes. Passing `saveRecording: false`
disables the app's local WAV only; it does not establish or suppress firmware
setting behavior. Start byte 7 uses channel count 2 for paired audio; the CMD32
getter instead reports stereo as 1. See the [retained command map](command-map630.md).

## Current native USB source mapping (393988)

The accepted current native/UAC mapping is **Channel 1/left = microphone** and
**Channel 2/right = system playback**. The 10.623-second PCM16 stereo capture
used an explicit HiDock UAC 1 kHz playback stimulus; its measured tone ratio was
775.45:1 in channel 2 versus channel 1. The microphone attribution for channel
1 follows the user's fixed topology and the firmware's system-microphone-mute
behavior; no separate microphone stimulus was run in this capture. This is the
current normal native/UAC mode only, not a Bluetooth or live CMD34 source map.
See [393988 lane evidence](../../research/rea/completion630-lab/runtime/current393988-system-audio-lane.json)
and [rendered source-control labels](../../research/rea/completion630-lab/runtime/current393988-source-control-labels.json).

## What is already saved

[RealtimeRecorder](../../apps/electron/electron/main/services/realtime-recorder.ts) writes a synchronized 16 kHz, PCM16 stereo WAV when **Save stereo WAV locally** is selected. The new capture owner defaults saving on. It finalizes a `.wav.partial` file on stop and writes a `.live.json` sidecar with session ID, expected format, packet/sample diagnostics, discontinuities and any inferred/pinned mic selection. That metadata does not claim raw microphone-element identity; the live sample below identifies only one mic source lane for tested mode 2. New capture files use `-Capture-Live.wav` and declare `automaticTranscription=false`; the folder watcher requires a matching explicit capture opt-in before automatically transcribing that file family or its channel exports.

The new owner sets `strictStereo: true`: complete aligned lane pairs are preserved, and malformed/unaligned payloads are rejected and counted instead of being duplicated or averaged. When the canonical `microphoneMuted` field is present, the recorder preserves the stereo payload: the qualified firmware has already applied microphone mute to lane 0, and lane 1 remains available. Whole-stream silence applies only to legacy packets with no `microphoneMuted` field and `muted: true`, unless diagnostic `preserveMutedPayload` is enabled. The older recorder's inferred-mono fallback remains available for legacy direct callers, but this capture owner does not use it. Two WAV channels alone do not prove independent physical sources; an even-length mono payload could satisfy alignment. The separate 393988 live test below validates source lanes only for its stated mode and setup.

The retained app capture was exercised on stock H1E 6.3.0 through its existing USB owner:
512 packets produced 819,200 stereo frames (51.2 seconds under the host format),
with zero rejected packets, a durable software marker and sample-exact mono exports.
The capture exercise ran approximately 60 seconds plus pause/control overhead;
this is not a 393988 live-capture result, one-hour throughput result or live
physical-routing qualification.
[Retained hardware readback](../../research/rea/evidence/hardware-capture-verification.json).

During the retained stock H1E 6.3.0 capture, native pause failed. Host pause now
accepts a confirmed realtime stop as suspension, retaining its file/session,
and resumes with the published start command. A missing pause reply does not
trigger fallback commands. The sample clock remains fixed while paused; no
silence is inserted.

## Capture without cloud transcription

The implemented start API is `window.electronAPI.jensen.startRealtime({ transcribe, saveRecording })`. Its defaults are `transcribe: false` and `saveRecording: true`. Device streaming and local saving start independently of Gemini. Transcription is opt-in, and provider startup/failure does not block the dequeue loop or stop local capture. Saving can also be disabled for diagnostics-only capture.

[DeviceAudioSession](../../apps/electron/electron/main/services/device-audio-session.ts) serializes start/pause/resume/stop under one renderer owner. Competing windows cannot take that owner; overlapping reads do not create another dequeue; stale replies after stop/disconnect are discarded. Pause records a discontinuity. Disconnect/shutdown ends local state and finalizes saving without opening another USB client. No missing samples or pause duration are invented in the saved WAV.

Leaving the Device page finalizes a capture started or resumed there, including
a start response arriving after navigation. Observer windows show passive
diagnostics without controlling or dequeuing another owner's stream. Newly
saved capture files can be transcribed manually later; live transcription opt-in
does not enable automatic offline transcription or change the global setting.

## Passive diagnostics and track export

`jensen.getAudioDiagnostics()` reads the app's current capture counters without requesting USB data; `onAudioDiagnostics()` subscribes to the same owner's notifications. Diagnostics use neutral `channel-0`/`channel-1` IDs and report RMS, peaks, clipping, accepted/rejected packets, sample elapsed time, producer-sequence metadata through the legacy `lastRest`/`maximumRest` fields, arrival gaps, correlation and bounded-window relative delay. Those fields are not device backlog on exact H1E6.3. Arrival gaps and the producer sequence alone do not quantify missing samples without qualified packet-size/wrap/continuity semantics. Correlation and delay are measurements of the received signals, not proof of source isolation.

The Library reader's **Export WAV tracks** action calls `deviceAudio.exportTracks(recordingId)`. The main process resolves the ID to a local PCM16 WAV and produces synchronized per-channel mono WAVs under its managed `device-audio-exports` directory. Samples are deinterleaved without resampling; names retain neutral channel IDs. Source files are preserved, existing output is refused, and compressed MP3/WebM is not accepted by this exporter. It cannot recover sources already combined in a device's mono recording.

The control displays selectable output paths for each exported channel.

## Software markers and existing native markers

The live capture panel and Library reader expose **Add marker** and the focused-panel shortcut **Ctrl+Shift+M**. New marks use durable local sidecars; active timestamps come from the existing capture owner's sample clock. After the saved WAV receives its Library recording ID, session annotations are associated through its capture sidecar. This does not add a marker to the device's internal recording.

The Library reader's **Import device markers** reads MP3 `HiDockVM` trailers and validated PCM16 WAV trailers following the complete RIFF payload. Generated native WAV imports and exact lane exports pass real file checks; the deployed app accepts its saved live WAV with no native trailer and preserves the local marker. Local sidecar native-target requests remain unsupported. The separate `jensen.addNativeMarker` sends stock CMD28 `[1,3]` on exact H1E6.3.0; one stopped device MP3 contained a4,863 ms marker and stayed deduplicated after app restart. [Native hardware verification](../../research/rea/REPORT-NATIVE-MARKER-HARDWARE.md) and [WAV host checks](../../research/rea/evidence/h1e-6.3.0-lossless/host-interop-verification.json).

On current 393988, an existing saved 10.623-second native stereo WAV carried one
native marker at 3716 ms. The development app imported that marker stably and
exported two synchronized mono tracks with sample-exact channel data while
preserving the source; that file-processing run made no device, provider or
upload calls. This validates the saved-WAV marker association and track-export
path only; the separate physical live lane result is documented below. See
[saved-WAV evidence](../../research/rea/completion630-lab/runtime/current393988-saved-wav-markers.json).

Host-side automatic annotations are off by default. When enabled, they reuse existing cached action/decision analysis and later analysis updates without starting a new provider request. Stable event IDs deduplicate reruns; automatic additions must be at least ten seconds apart and are capped at 80. New additions stop at 100 total entries for a subject. Imported native snapshots and pre-existing local annotations are preserved together rather than silently truncated. Live host-side automatic audio-event detection remains pending. See [marker API and limits](protocol.md#recording-settings-and-markers).

Separately, the custom firmware already implements persisted `REA_RULE2`
native sound-marker rules for **Mic**, **System** or **Either**, based on
mean-absolute audio level; the rules are off by default. Prior physical marker
evidence is from 393986 and applies to the same 6.3.4 core. The current live
tap check did not repeat that marker test, and `onRealtimeChannels` itself does
not emit automatic markers.

## Firmware background and live boundary

HiDock's [P1 live feature announcement](https://www.hidock.com/blogs/user-guide/live-transcription-translation-has-arrived-for-your-hidock-p1) requires firmware 1.3.8 and explicitly describes transcription without saving recordings. This supports the distinction between live transport and stored files; it does not specify raw channel identities. Current host gates also include H1 5.3.0 and H1E 6.3.0, with a separate C1 gate, as listed in the device guide. The analyzed H1E 6.2.5 image predates that live gate and cannot establish the newer stream's firmware internals.

HiDock also publishes [P1 1.4.3 notes](https://www.hidock.com/blogs/new-release/new-release-hidock-p1-firmware-1-4-3) describing 96 kbps MP3 and 768 kbps WAV recording choices. Those P1 features do not establish H1E quality controls or separate-source recording. A live attempt to refresh the generic HiNotes firmware-list API returned a non-JSON response; this investigation does not claim the newest H1/H1E version from that endpoint.

Host verification includes real WAV readback/exports, malformed-frame rejection, lifecycle/owner races, diagnostics, durable sidecars and native trailer parsing. Automated USB/provider fixtures are synthetic. Earlier firmware-lab fixtures use libmp3lame; current exact-image instruction probes execute the target's Shine encoder and independently decode its MP3 output. The [implementation ledger](implementation-status.md#verification-and-runtime-status) distinguishes those offline checks from real USB and deployed app evidence.

The current 393988 physical live sample passed through the trusted preload and
one CMD34 reader: 42 accepted packets yielded 67,200 frames and 134,400 bytes
per mono lane. Byte parity, frame alignment, and independent lane buffers were
all confirmed. With a 3-second 1 kHz tone sent through explicit HiDock UAC,
channel-1's measured tone amplitude was 69.3489 times channel-0's. This
supports **channel-1 = system** for this normal USB mode-2 setup. **Channel-0 =
microphone** follows the fixed user topology and firmware's mic-mute-first
evidence; this run did not add a separate microphone stimulus. The 16 kHz value
remains the host's expected rate, not a measured live rate. See the
[current live tap receipt](../../research/rea/completion630-lab/runtime/current393988-live-channel-tap-021926-root.json).

The session used `transcribe: false` and `saveRecording: false`; no provider was
requested. The device acknowledged stop and returned to native/live idle. The
four settings were preserved (including `autoRecord: true`), the catalogue
stayed at 587 recordings, and firmware/settings writes were zero. This is a
scoped physical result for current 393988, mode 2, normal USB only. It does not
establish Bluetooth lane identities, raw microphone-array access, other live
modes, or a global source map.

To consume the lanes programmatically, use this as the **sole** poller from the
owning renderer. If the Device page's poller is active, subscribe to its stream
instead and do not call `getRealtimeData` from a second loop.

```js
async function sampleLiveLanes(onChannels, durationMs = 3000) {
  const jensen = window.electronAPI.jensen
  const unsubscribe = jensen.onRealtimeChannels(onChannels)
  let started = false
  try {
    const result = await jensen.startRealtime({ transcribe: false, saveRecording: false })
    if (result?.result !== 'success') throw new Error(result?.error ?? 'Live start failed')
    started = true
    const until = Date.now() + durationMs
    while (Date.now() < until) {
      await jensen.getRealtimeData(0) // The sole CMD34 poll; the channel event is emitted from this packet.
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    try {
      if (started) await jensen.stopRealtime()
    } finally {
      unsubscribe()
    }
  }
}
```

The rendered `/#/sync` Device-panel check clicked **Monitor channels** with
`transcribe: false` and `saveRecording: false`. The UI showed **Microphone**
and **System audio**, 25.0 KB received for each lane and eight packets; its
copy warns that lanes are separated but not fully isolated. This was the
existing owner poll and event subscription, with no competing poll. **Stop**
returned live capture to idle. Settings were preserved, the catalogue remained
at 587 recordings, native/live state was idle, no tone was requested, and
firmware/settings writes were zero; root PID 130096 closed afterward. See the
[UI receipt](../../research/rea/completion630-lab/runtime/current393988-live-channel-ui-030312-root.json)
and [implementation/test report](../../research/rea/completion630-lab/application/LIVE-CHANNEL-UI-IMPLEMENTATION.md).

Labels are shown only for H1E 393988 / 6.3.4; other models and firmware retain
neutral Channel 0 / Channel 1 labels. The original harness assertion looked
for uppercase `Received`, while the retained DOM uses lowercase `received`; it
was corrected against that DOM without rerunning the app or hardware. The
implementation report records 11 focused UI tests passed. This confirms the
Electron development UI, not a public SDK or app release.

Historical physical controls and native capture evidence on upload 2 **393986 / 6.3.2** remain historical and do not replace the current 393988 native or live mappings. See the [prior physical upload2 report](../../research/rea/completion630-lab/runtime/REPORT-UPLOAD2-QUALIFICATION.md) and [active iteration plan](active-iteration-plan.md).

## Restore and capture exclusion

The installed 393988 original-name restore operations require explicit audio-quiescent assurance and same-owner native/live idle checks before writes. RSTR2 does not provide simultaneous restore/capture or prove native MSC exclusion. The current 393988 saved-WAV marker/export check is a local file-processing result; it does not qualify f119's still-open physical restore. The scoped live result above does not establish every microphone/USB/Bluetooth source. [Restore and ownership limits](restore-original-recordings.md).



