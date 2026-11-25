# Native recording settings

The H1E custom firmware stores native recording settings on the dock. The app sends USB commands to change them and reads them back. Native recording, including recording started with the hardware button, runs inside the dock and does not require the app to remain open.

This describes the custom controls introduced in 393986 / 6.3.2 and preserved in the currently installed 393988 / 6.3.4. Official firmware does not expose these custom configuration commands. Exact firmware checks remain required before changing settings.

| Setting | Effect on the next native recording |
| --- | --- |
| Format | Stereo MP3 or PCM16 stereo WAV, at 16 kHz. |
| MP3 profile 0 / 1 / 2 / 3 | Total stereo bitrate 64 / 96 / 128 / 160 kb/s. This is not a bitrate per channel. |
| Microphone / system audio gain (Channel 1 / 2) | Independent recording gains. Q15 32768 means unity (100%); 0 means muted; 65536 means 200%. Amplification can clip. |
| Automatic native markers | Firmware watches the configured channel or either channel and queues markers after the mean absolute PCM magnitude reaches the threshold. |

For USB native recording on the current firmware, Channel 1 (left) is the microphone and Channel 2 (right) is system audio, and the panel labels them that way. The system-audio lane is physically confirmed: on 393988 a native 16 kHz stereo capture of an explicit HiDock UAC 1000 Hz tone put it on Channel 2, about 775 times above Channel 1. The microphone lane rests on the user's stated topology and the firmware's system-mic-mute, which suppresses the first lane. No separate microphone stimulus was run. This mapping covers USB native recording only. It does not extend to every Bluetooth mode or to each physical microphone in the array. These settings describe the native recording path; they do not establish a change to USB conferencing microphone or speaker controls. [Current evidence](../../research/rea/completion630-lab/runtime/current393988-system-audio-lane.json).

Changes require idle native and live recording. Apply sends each setting once and then reads the actual configuration back. A failed or partial apply must be shown as such. An acknowledgement alone does not prove the values survived a power cycle.

The custom nonvolatile records are `REA_REC1` (profile and gains), `REA_FMT1` (format), and `REA_RULE2` (automatic markers). Getters distinguish a validated stored record from fallback. Missing, unreadable, short or invalid records can produce fallback; fallback does not identify which cause occurred. Format falls back to MP3 and automatic rules fall back to disabled.

Automatic rules use mean absolute sample magnitude, not speech recognition. Lane 0 selects the first channel, lane 1 the second, and lane 2 either. Thresholds are integers 1–32767. The firmware uses a 100 ms onset, a 100 ms quiet rearm and at least 10 seconds between attempts; these rules are not a speaker classifier or a calibrated loudness scale.

There are three different marker paths:

- The hardware button triggers a native marker in the recording.
- A connected app or program sends a native marker command for the exact active recording. Command acknowledgement must be checked against the finalized file footer before claiming a persisted marker.
- Automatic native rules run in the firmware without the app. They are separate from the app's local annotations on a live capture.

The app's live capture is a separate path: it receives live PCM and can save a local stereo WAV, add local annotations and optionally transcribe. Native MP3 bitrate settings do not change that host WAV format. Completed stereo WAV files can also be exported as two synchronized mono channel files.

Protocol definitions: [profile](../../packages/jensen-protocol/src/custom-recording-profile.ts), [format](../../packages/jensen-protocol/src/custom-recording-format.ts), [marker rules](../../packages/jensen-protocol/src/custom-marker-rules.ts). Native command handling: [device-native-recording.ts](../../apps/electron/electron/main/services/device-native-recording.ts).

Physical readback, codec, gains and marker behavior have been observed on 393986. Reboot persistence, source attribution across all modes and all failure cases remain separate acceptance checks; this document does not mark those checks complete.

## Current observed checks

On 12 October 2026 the rebuilt development app applied each of the four MP3 profiles through the rendered controls and read back its stored device value. Its physical captures decoded as stereo MP3 64 kb/s and PCM16 stereo WAV, with each channel independently muted in separate captures. Manual and automatic markers were read from finalized file footers. The original MP3 128 kb/s, unity gains and disabled marker rules were restored. [UI/device evidence](../../research/rea/completion630-lab/runtime/current-custom-native-panel-final.json), [all quality readbacks](../../research/rea/completion630-lab/runtime/current-custom-ui-all-quality-readbacks.json).

A protected native recording continued while the app was fully closed and was still the same active file after reopening, with duration advancing from 2 to 29 seconds. [Autonomy evidence](../../research/rea/completion630-lab/runtime/current-custom-native-autonomy.json).

A separate physical stereo WAV of controlled synthetic speech was captured and decoded for the client transcription tests. It is 31.6815 seconds at 16 kHz. It establishes a voice fixture, not completed ASR or physical source attribution. [Capture evidence](../../research/rea/completion630-lab/runtime/current-custom-controlled-voice.json).

The native gain setting is applied to the recording samples. Automatic marker detection observes the raw paired audio before gain; muting the saved channel does not by itself disable that channel's marker detector. Disable rules or select the intended detection lane separately.

On 12 October 2026, custom 393988 / 6.3.4 was installed through the development app. Automatic reboot and same-device version/capability/idle/card readbacks were confirmed. All 586 preflash names and sizes, profile, format and rules were preserved. The rendered development panel read MP3, profile 2 (128 kb/s), both gains 100%, and automatic rules disabled after boot. This boot check does not repeat the earlier codec/source qualification or attest installed firmware bytes. [Flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [rendered controls](../../research/rea/completion630-lab/runtime/current393988-rendered-controls.json).

