# Stored stereo audio — observed verification, 2026-10-12

The implementation defaults to preserved source channels. Source roles remain unknown
until recording-scoped evidence exists; a channel is never automatically a person.
The explicit mixed setting remains available. Original files remain unchanged.

## Observed real boundaries

- Actual FFmpeg decoding under bounded Windows Job policy: mono/stereo WAV and MP3
  at 64/96/128/160 kbps, legacy RIFF/MPEG wrappers and marker trailers, cleanup,
  cancellation and unsupported channel-count rejection. Existing OGG/FLAC/M4A/WebM
  import formats also decoded and separated in real fixture tests.
- GAMESTATION installed host **0.5.3** advertises separate channels v1 and explicit
  active-source selection. Paired HTTPS Qwen3-ASR-1.7B CUDA processing of two
  overlapping 30-second source clips completed in **16.292 seconds** host wall time.
  Output retained both source indexes, 480,000 decoded frames and a shared 30s clock.
- Actual client remote service processed a stereo MP3160 fixture with active channel0:
  **9.148 seconds** client elapsed, channel1 explicitly `no-activity-skip`; original
  audio and production configuration hashes unchanged.
- Actual `transcribePreparedChannels` coordinator, paired remote service and native
  SQLite: two sequential mono jobs took **9.113s / 8.100s** client elapsed. Both track
  rows persisted before first ASR; close/reopen checkpoint replay made no further
  jobs. Overlap survived, provenance stayed unknown, no derived paths persisted,
  temporary tracks were removed and host returned idle.
- Real channel-specific VAD retained both 1s opposite-phase signals although a naïve
  mono mix had zero peak. Quiet-source MP3 reported 22.064s activity on channel0
  and zero on channel1.
- Real HTTP loopback lost-upload-response/reconnect test streamed 2MiB exactly once
  and created one durable job, retaining channel mode/map/active selection.

All speech fixtures came from pre-existing Oct9 snippets. No Oct11/Oct12 recordings
were processed. No device connection or automatic download setting was changed.
These tests establish channel preservation and execution behavior, not a new accuracy
benchmark or microphone/system mapping for real custom-firmware recordings.

## Regression and packages

Host: 255 tests passed. Client focused pipeline/remote/VAD suite:82 passed;
state/coordinator/routing/decoder focused tests also passed; main/web types passed.
Client package checks loaded actual SQLite and USB dependencies without opening a
device and verified ASAR integrity/private-artifact exclusions.

Host installer SHA256:
`5A7ABB2FD179189026F62AF57B6A38E1A7BB8F653E82D3B397786019A5652A47`.
Client packaged ASAR SHA256:
`BFD8F3F09BFC13B3D99B1434C473115AEFC84C0CDB0EC447F2C4671F123A8B3D`.
Silent client installation completed; installed ASAR matches that exact hash.
Installed UI was exercised through native Windows automation in an isolated empty
SQLite library under recovery mode: the selector defaults to Preserve separate
channels, changing it to Mix channels together persisted `mixed`, and selecting
Preserve again persisted `preserve`. Both automatic device settings remained false.

## Remaining boundaries

The full installed pipeline using a physical custom-firmware recording has not
been exercised. Per-file firmware channel mapping and finalization/resume integrity
metadata need confirmation against the actual firmware contract. Listing, resume,
markers and uploads belong to the separate existing device qualification work; no
USB access or completion claim is made here.

Private diagnostic evidence: `.diagnostics/stored-stereo/` and
`.diagnostics/stored-channel-boundary/report.json`; transcripts are not delivered.
Firmware requirements: `docs/devices/stored-audio-firmware-contract.md`.
