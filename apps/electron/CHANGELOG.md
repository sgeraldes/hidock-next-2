# HiDock Next release notes

Each entry is one day of merged work. The Releases page in Settings reads this file.

## 2026-09-28 | Settings with a menu, Jev in the Library, connectors that connect

Settings is a menu of pages instead of one long page, the Library shows what Jev found about each
recording, and Microsoft 365 and Slack connect on first try.

### New

- **Settings menu.** Pages grouped under Preferences, Services and System, a search box that finds
  a page by what it holds, and an Overview with the state of each area. Connectors show as a list
  with the selected account beside it.
- **Jev in the Library.** Each row shows stars and the kind of recording ("4★ Team meeting") and a
  warning icon when the transcript may be invented or missing. Filters for kind, work or personal,
  stars and warnings.
- **Library maintenance.** Rescan with Jev, re-check warnings, relink recordings to meetings (the
  Outlook calendar back to the oldest recording), redraw waveforms.
- **Microsoft 365 with no setup.** HiDock ships its own app registration; Connect and sign in.
- **Transcript problems in place.** Lines with a repeated or backwards time, or too many words for
  their time, are marked in the transcript. Clicking "Repeated times" or "Times go backwards" goes
  to the next such line. Editing a line also edits its start time.
- **Click a time to play.** A time in the transcript starts the recording there, even when nothing
  is playing.

### Fixes

- Recordings never linked to Outlook meetings: the linker only read the ICS feed.
- A Slack token saved after startup kept answering "token missing" until a restart.
- A first Slack sync would have pulled every channel; channels now start off and are picked in a
  searchable list.
- A new Hugging Face token, or a new transcription provider, was silently reset whenever another
  setting saved.
- The audio-versus-transcript warning flagged real short clips and long quiet meetings.
- Row icons now keep their place, so a missing one reads as a gap.
- A transcript with one line out of time order refused every edit ("Invalid transcript edit"), and
  saving an edit dropped the speaker-confidence marks.

## 2026-09-27 | Jev rates recordings; the device list stops freezing the app

### New

- **Jev (TypeSafe AI) as the value classifier.** One request per recording answers stars, kind,
  work or personal, and whether the transcript can be trusted. The key is stored encrypted and
  edited in Settings.

### Fixes

- Reading the device's file list no longer freezes the window.
- One Pause stops downloads and transcriptions together.
- The Operations panel shows only this session's work.
- The file name shows only in the reader's Metadata; purged recordings stay purged.
- A rejected Jev key stops the scan at the first answer instead of failing every item.

## 2026-09-25 | Packaging and the headless brain

### Fixes

- The build fails when the packaged app cannot load its database driver, instead of shipping a
  broken installer.
- The headless brain upgrades the database when no HiDock window has it open.

## 2026-09-24 | Recording checks and speaker setup per machine

### New

- **Recording checks.** Silent, noise-only and too-short recordings are labelled in the Library
  and rated, from the audio itself.
- **Speaker setup per hardware**, with the voice model pinned to the library, and an ONNX voice
  engine for AMD and Intel GPUs.
- Short recordings are transcribed beside long ones instead of waiting behind them.

### Fixes

- Startup reuses the hourly backup and shows the copy while it runs.
- One HiDock per user, whatever the profile; the Library shows when Device Sync is off.

## 2026-09-23 | Transcript integrity and the USB device

### New

- Transcripts whose timing or text cannot be right are labelled.
- Truncated recordings are recovered from the device when it still has the full copy.
- Benchmark runs compare against a baseline, with a flame graph.

### Fixes

- The USB device is released before quitting.
- The Activity Log is clickable again; the reader's section controls are compact.
- The database is vacuumed after a migration only when it reclaims enough space.

## 2026-09-22 | Notes, the model host, and honest durations

### New

- **Notes.** Write notes in HiDock; the AI makes them findable afterwards.
- **Model host.** The speaker tools install on the GPU machine and are lent over the network.
- Live transcription runs one session per channel, so turns are attributed by the cable.
- Suggested titles for unassigned recordings, renamed in place.

### Fixes

- Recording length is measured from the audio, not from a transcript; VBR audio from its stream
  header.
- Recordings shorter than ten seconds are not sent for transcription, and short recordings are
  rated by length without a model call.
- A stale sync row no longer hides a recording from both download and transcription.
- H1 Lite live transcription works.

## 2026-09-21 | A faster assistant index

### New

- Hourly hot backup of the database, with rotation.
- The local embedder runs in its own process.

### Fixes

- The assistant's index loads a partition in one block and no longer holds chunk text in memory.
- The diarization worker's CPU share is capped.
- The existing profile is kept across the 2.0 rename.
