# PC meeting recorder — phase 1a

On Windows, choose **New > Record** in the top bar, then press **Record** in the compact bar.
Opening the bar never opens a microphone. **Stop** flushes the recording into the Library.
The bar shows elapsed time and independent Mic/System levels and survives page navigation.
After saving, it shows **Saved to Library** and **Open** for five seconds, then hides and
resets. Dismiss hides the bar in any state without stopping capture; **New > Record**
reopens it so an active recording can still be stopped.
The system default microphone is used; a device picker is deferred.

## Capture and file format

The microphone and Windows system loopback are separate streams. Each source is downmixed
individually to mono, then a Web Audio ChannelMerger writes microphone to channel 0 (left) and
system audio to channel 1 (right). MediaRecorder produces stereo WebM/Opus at a 128 kbps target,
using the browser AudioContext sample rate. No camera or screen video is saved.

System capture uses Electron's `setDisplayMediaRequestHandler` with `audio: 'loopback'`, scoped
to the main frame and a user gesture. Missing audio, permissions failures and source termination
show an error. Capture never degrades silently to microphone only. Phase 1a supports Windows;
other platforms fail clearly if loopback cannot be supplied.

## Persistence, import and privacy

One-second MediaRecorder fragments are serialized over IPC and appended in order to
`<userData>/pc-recordings/Recording YYYY-MM-DD HH-mm <uuid>.webm.partial`. Each acknowledged
chunk is flushed to disk. These are fragments of one WebM stream, not independently encoded
files. This staging folder is outside the watched recordings folder.

Stop and normal app quit flush the last chunk before importing. Quit allows ten seconds for
the renderer to respond; if it cannot respond, the acknowledged chunks remain for recovery.
On the next startup, partial and interrupted-import files are recovered through the same
copy/Library-insert path as `recordings:addExternalByPath`: local-only, external, `is_imported=1`.
Stable filenames make recovery idempotent. The staging copy is removed only after successful
import; import errors leave it for retry. The Library's existing date-based title is used.

Before PC import or recovery, bundled FFmpeg decodes the audio and counts samples to store
the actual length with duration source `file`, even when WebM has no duration header. If
decoding is unavailable, normal stop retains monotonic elapsed time with source `recorder`.
Recovery never invents an elapsed time. The stereo file is preserved without remuxing.

A hard crash can lose audio still buffered by Chromium or IPC since the last acknowledged
chunk (normally around one second; MediaRecorder timeslices are not a real-time guarantee).
Previously acknowledged chunks survive. A recovered WebM may have an incomplete final packet;
the preserved prefix remains decodable without rewriting the original stereo channels.

The recorder itself sends no audio to a provider. After stop or recovery completes the file import,
the recording enters the existing transcription pipeline through `queueTranscriptionIfEnabled`,
just like device downloads. Automatic transcription follows the owner's auto-transcribe setting
and transcription feature setting; the configured pipeline may upload audio to a cloud provider.
When automatic transcription is disabled, the Library's **Transcribe** controls remain available.

## Phase 1b

Preserve the two-channel source file and make attribution channel-aware. The existing Gemini
path reads the original WebM bytes (MIME `audio/webm`) without a local downmix, but does not
use mic/system channel labels. Its WAV/MP3 chunk splitters do not split WebM.

Local speaker linking downmixes in `resources/speaker-linking/worker.py::decode_audio`
with FFmpeg `-ac 1 -ar 16000` before pyannote. Audio profiling also decodes to 16 kHz mono
in `electron/main/services/audio-profile.ts`, and transcript sampling uses mono MP3 in
`transcript-sampler.ts`. These analysis copies do not alter the stereo recording. The HiDock
live WAV/`.live.json` attribution path does not apply to PC WebM. Phase 1a changes no diarization.

Realtime transcription, AI assistance, guided interviews/brainstorms, device selection and
additional New menu actions are later work.

## Verification

Mocked media tests cover routing, start/stop, source failures, menu/bar and navigation lifetime.
Filesystem/temporary SQLite tests exercise the shared import path, crash recovery and Library
query with generated stereo tones; FFmpeg decodes the saved and truncated/recovered media.
An isolated hidden Electron test runs the real capture class with 400 Hz microphone and
1,000 Hz system oscillators, encodes using MediaRecorder, decodes and requires less than
-30 dB crosstalk. It also checks the independent analysers at known input gains. A second
hidden-browser test renders the real bar and app CSS in both themes and exercises recording,
dismiss/reopen, stop, Saved, Open and the five-second reset. IPC tests reject failed desktop
capture before a recording session starts. Tests never open the owner's app or database.

Chromium's `--use-fake-device-for-media-stream` can also supply synthetic display audio.
Do not use its beep to identify which recorded channel contains microphone input. The
diagnostic `scripts/probe-pc-fake-sources.js` measures both raw sources independently:
run it via `scripts/test-pc-capture.cjs <temporary-userData> <probe-script> fake-devices`
under Electron. In the observed Windows runtime the display source carries the 400 Hz beep,
while the microphone source has strong low-frequency content. The generated oscillator
test is the source-separation check; actual hardware loopback and integrated quit/restart
remain separate live checks.
