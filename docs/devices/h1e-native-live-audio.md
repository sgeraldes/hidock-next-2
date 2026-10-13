# H1E native recording and live channel monitor

This guide covers the **Native recording** controls and the **Live channels** monitor on the Device Sync page. Use a normal development-app launch with the existing custom firmware and Device Sync enabled. The firmware-install recovery and firmware-qualification launches intentionally block live audio; they are not the launch mode for recording or monitoring.

> **The live Monitor/Stop path passed a real dock check on 13 October 2026.** The corrected source displayed Microphone and System audio with incoming data, then returned to idle. Device settings, native controls and all 587 recordings were preserved. This check requested no saved recording, provider, tone, setting change or firmware write. [Runtime receipt](evidence/h1e-native-live-393988.json).

## Native recording

Native recording uses the HiDock's on-device recorder. The panel shows the current filename and duration, or that no recording is active. Use **Start recording** and **Stop recording** for the device recording; use **Refresh** to reread status and settings. If another operation or live session owns the device, these controls pause. Settings are read and edited only while the device is idle, and are locked while a native recording is active.

The panel can expose these settings on supported audited H1E firmware:

- **Format:** MP3 or WAV. The MP3 bitrate selector offers 64, 96, 128, or 160 kb/s total across both channels.
- **Microphone gain** and **System audio gain:** each ranges from 0% to 200%; 100% is unity and 0% mutes that source. In the accepted 393988 normal-USB setup, Channel 1/left is the microphone and Channel 2/right is system audio.
- **Automatic native markers:** off by default. When enabled, the firmware's persisted rule can watch Microphone, System audio, or Either channel using a mean-magnitude threshold from 1 to 32,767. These are markers in a native recording, not live-transcription events or host-side annotations.

Choose **Apply settings** to write changed values. The panel rereads each value and reports whether it is stored on the device; a fallback value is not confirmation that a setting was saved. If the result is uncertain or does not match, refresh before trying again. No 256 kb/s option or 32/48 kHz recording-rate control is implemented here.

**Add marker** is available only while a native recording is active. An acknowledgement means the device accepted the marker command, not that the marker is durably present; check the marker footer in the completed recording. The live monitor does not create these automatic or manual native markers.

## Live channels

Use **Monitor channels** to view the two incoming live lanes without saving or transcribing. This mode always starts with `transcribe: false` and `saveRecording: false`, regardless of the Save stereo WAV locally and Enable live transcription checkboxes. It does not create a WAV or sidecar, and does not start an ASR/provider request. The page shows per-lane meters, peak and level, received bytes, and packet count; it does not play the audio. Pause and Resume keep monitor-only options until Stop.

**Start** is the separate capture action. Its Save stereo WAV locally and Enable live transcription checkboxes control that session; saving and transcription are independent choices. When local saving is enabled, the app writes a stereo WAV and a `.live.json` session sidecar. Live transcription depends on a separately enabled provider and is not guaranteed by the channel monitor.

For current H1E 393988 / firmware 6.3.4 in normal USB mode, the source labels are **Channel 0 = Microphone** and **Channel 1 = System audio**. The channels are separated but not fully isolated; some sound from one can appear in the other. On any other model or firmware, the UI should use neutral Channel 0 / Channel 1 labels and say the sources are unconfirmed. The displayed live format is a host expectation of 16 kHz, two channels, 16-bit PCM; the rate is not negotiated or measured by these controls. The monitor has no 256 kb/s, 32 kHz, or 48 kHz option, and the native format/bitrate settings do not configure the live stream.

## Current verification status

Source and focused UI tests are documented in the [native/live port report](native-live-source-port-report.md). The first real monitor session caught a missing device-identity update. After the fix, the real Device page showed both source labels and 3.1 KB received per lane, and Stop returned it to idle. Native profile, format and marker-rule readbacks matched before and after. The receipt covers this bounded monitoring path; it does not qualify cloud transcription, every audio route, higher sample rates or a Windows installer. Native setters and saved-file behavior were not exercised again in this clean-branch check.
