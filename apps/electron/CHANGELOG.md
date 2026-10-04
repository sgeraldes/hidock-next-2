# HiDock Next release notes

Each entry is one day of merged work. The Releases page in Settings reads this file.

## 2026-10-04 | The gamestation only helps, and gets out of the way

The Model Host on the gamestation is now a small tray icon and nothing else to set up there. HiDock
pairs with it, gives it the Hugging Face token and decides when it steps aside.

### Changes

- **Reference labels for recording kinds.** Settings > Pipeline keeps a sample of up to 40 valid
  recordings for your own labels, with keyboard choices and progress, ready for engine comparisons.
- **A fresh restore point before database updates.** Schema migrations now verify a current backup,
  even when today's daily backup already exists. The newest three migration backups are kept.

- **Decision engines and presets.** Pipeline settings choose Clef Flash, Clef, Jev, Haiku or Gemini
  Flash for five decision steps, with a global preset and per-step overrides. Presets fall back when
  an engine cannot answer, and each attempt is recorded in the call ledger.

- **Installing on the gamestation is a double click.** Model Host 0.3.0 asks no questions: it
  installs its runtime in a console that closes by itself, starts a tray icon and starts it again
  with Windows. The control page, its game mode settings and the "pause or resume" shortcut of
  0.2.0 are gone.
- **Paused means nothing running.** The tray icon (93 KB, written in C) stops the whole service
  when it steps aside or when you press Pause: no Node, no Python, no model in memory. Measured
  while a game runs: 336 KB for the icon and no CPU.
- **One setting, in HiDock.** Settings > Transcription > Model host > "When the gamestation is in
  use": step aside whenever it is used, only for games (the default), or never. A game is a program
  from a Steam, Xbox, Epic, GOG, Riot, EA or Ubisoft games folder, or a full-screen window. Work
  starts again five minutes after the game closes. Start in the tray during a game keeps it working
  until that game ends.
- **Pairing without a code, and the token goes with it.** For five minutes after the host is
  installed, Pair with an empty code connects to it; the tray can cancel that window, resume it, or
  disconnect HiDock and start again, and still shows an 8-digit code if you prefer. Pairing gives
  the host this computer's Hugging Face token; the host tests the voice model with it and only then
  takes work. You never type a token on the gamestation.
- **HiDock looks after the gamestation from here (Model Host 0.3.1).** It reads the host's logs and
  CUDA check over the paired connection, asks it to reinstall its GPU runtime (a Repair link appears
  when the host has an NVIDIA card and still ran the model on its CPU), and sends it new versions,
  which it installs by itself. 0.3.0 counted a launcher helper running in the background of a games
  folder as a game and stayed paused with no game open; now only a window that comes to the front
  counts, and the tray icon names the program it took for a game.
- **The voice backlog runs back to back on the gamestation's GPU.** A recording measured on the
  host's RTX card takes seconds, so the next one starts two seconds later instead of two minutes.
  On this computer's CPU the two-minute pace stays.
- **No recording goes to this computer's CPU for a stale "busy".** HiDock keeps the gamestation's
  status for 15 seconds, and a status read while one recording was being processed sent the next
  one, two seconds later, to this computer's CPU. Now only the gamestation's answer to the job
  itself can send a recording back here.
- **A speaker without a usable voiceprint no longer spoils the whole recording.** The voice model
  sometimes returns no voiceprint (NaN) for a speaker with little speech; the result was then
  unreadable and the recording was processed again on this computer. That speaker is now left out,
  as one with too little speech already was, and the rest is kept.
- **Model Host 0.3.2 installs the GPU build of torch.** The installer is a 32-bit program, and
  Windows gave it the 32-bit PowerShell, which cannot see the NVIDIA driver; 0.3.0 and 0.3.1
  therefore installed the CPU build. 0.3.2 runs the 64-bit PowerShell. Its window also closes by
  itself when the install worked, and stays open only when setup failed, to show the error.
- **Clef and Clef-Flash on the gamestation (Model Host 0.4.0).** The host answers decisions with
  Cloudflare's decision models, using the same questions and answers as Jev: Clef-Flash (9B)
  as published, Clef (27B) in 4 bits so it fits the RTX 4090. HiDock picks the model in each
  request. A model downloads to the gamestation the first time it is asked for (19 GB and 55 GB)
  and leaves the GPU after ten minutes without requests. No HiDock feature uses it yet.

## 2026-10-03 | Attendees from Outlook, and speakers that know who named them

Meetings that arrive from the calendar feed without a guest list take it from the same meeting in
Outlook, and every speaker the app names now keeps a note of how it was named.

### Changes

- **Meetings from the calendar feed take their attendees from Outlook.** The calendar feed sends
  meetings without attendees, and Outlook sends the same meeting again with them. A meeting with no
  attendees now copies them from its Outlook copy (same subject, same start), and the organizer
  when it has none, so its people appear under the meeting. When two Outlook meetings share that
  subject and start and list different people, nothing is copied.
- **Each speaker assignment remembers where it came from.** A speaker named by you, by the speaker
  saying their own name, by the voice, by Jev, by the meeting roster or by the microphone of a live
  recording now stores that source and how sure it was. Speakers named before today keep an empty
  source.
- **Older recordings get their voices measured.** Recordings transcribed before voices were measured
  now get them without being transcribed again, one at a time and at low priority, starting with the
  meetings that have the fewest speakers. By default this runs at night, from 01:00 to 07:00; Settings >
  Speakers & voices can move it to the background or turn it off, and it always waits while a
  recording is transcribed. When the transcript's timing is sound, each voice is matched to the
  transcript's speaker, so a voice you already named names that speaker too. The same block shows how
  many recordings have voices, the last problem, and a "Measure one recording" button that times one
  recording and estimates how long the rest would take.
- **The app learns voices from your meetings.** Your voice is learned from the microphone of a live
  recording. In a meeting with only you and one other person, the other voice points to that person.
  In a bigger meeting where every voice but one is known and one guest has not been heard, the last
  voice points to that guest. A voice is tied to someone only when two recordings point it to the same
  person and none points elsewhere, because an invited person may stay silent while someone who was
  not invited speaks. Each voice learned names that person's speakers in your
  other recordings. It runs after each recording gets its voices and once at startup, never while a
  recording is transcribed, and every decision is recorded with its reason and the state before, so
  it can be undone.
- **A voice never overrides a speaker you named.** When a known voice disagrees with a speaker you
  or a stronger signal named, the name stays and the disagreement is saved with both people for you
  to answer in People. When an automatic speaker name is undone, no rule names that speaker after
  that person again.
- **A shared first name is settled from voices and attendance.** When "Sergio" could be two people,
  a recording now picks the one whose voice is heard in it, provided every other Sergio who attended
  has a known voice. It still picks the only Sergio who attended, and it picks you when you are one
  of the Sergios, you speak in the recording (or it is a live recording) and no other Sergio
  attended or speaks. When two or more of them attended or speak, Jev reads the lines that say the
  name and chooses, and its choice counts only when it is at least 80% sure and 30 points ahead of
  the next person. Each decision is recorded with its reason and can be undone, and an undone one is
  not made again.
- **Duplicate people merge by themselves when the evidence is clear.** Two people with the same
  personal email address and names that fit one person are merged. A shared mailbox (info@,
  support@ and the like, or an address with a "+") or an address that one meeting lists under two
  names stays a question for you. Two people whose voices are the same voice are merged too,
  unless both voices are heard in one recording or their email addresses differ. Two people with similar names who share
  meetings or a company email domain are put to Jev, and merged only when it is sure they are one
  person; the rest stay in People for you. Each merge keeps its Undo.
- **Words are no longer taken for names.** "I'm here", "Service here" or "soy CTO" no longer create a
  person called "I'm", "Service" or "CTO", nor a warning that two people share one speaker.
  Pronouns, helper verbs, role words and short words in English and Spanish are skipped.
- **People named after an email address get their real name.** A calendar often lists the address
  as the person's name, and the app stored it: 299 people in the library were called
  "juanchobq2017@gmail.com" and the like, and some showed up in People as a shared first name ("Juan")
  because the address starts with one. An address, a web address or a phone number is no longer
  taken for a first name. A person named after an address takes the name the calendar uses most for
  that address, when it has one (53 of the 299), and new people from the calendar never get an
  address as their name. People you added yourself are never renamed, and neither are shared
  mailboxes such as info@ or addresses a meeting lists under two names, which are not one person.
- **The identity rules are written down.** The file docs/identity-rules.md lists each kind of
  identity question, the rule that answers it, the signals in order and when it stays a question
  for you.
- **People shows what the app decided, and lets you undo it.** A "Decided automatically" list,
  closed until you open it, shows each decision the app made by itself in one sentence with its
  reason, newest first: "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: Ana Ruiz was the only
  other person in this one-on-one", or "Merged 'Ana R.' into Ana Ruiz: same email". Each row has an
  Undo; an undone row says so and the count drops, and a question it brings back appears again
  above it.
- **People asks only what is still open.** A shared first name whose recordings are all decided no
  longer shows. A voice that disagrees with a name gets its own card: "In 'Weekly sync' (12 Sep),
  Speaker 2's voice sounds like Ana Ruiz, but it is named Bea Paz (named by you)", with "Keep Bea
  Paz" and "It is Ana Ruiz". Keeping the name writes no alias; choosing the voice names the speaker
  as if you had picked it yourself.
- **Settings counts the identity questions.** Settings > Speakers & voices has a small table with,
  for shared first names, duplicate people, speakers, voices and voice conflicts, how many are
  pending, how many the app decided and how many you decided. The app's column adds up to the
  "Decided automatically" count in People, and duplicate people count only what People shows.
- **The Model Host installer works on a machine that has never had HiDock.** Version 0.1.2 brings
  its own ffmpeg (the voice step reads every recording through it, and a gaming PC has none), and
  installs the exact package versions this machine uses, with torch built for CUDA 12.6. The
  0.1.0 installer would have put a CPU-only torch on the RTX machine and then failed every job, and
  the host could not read the settings file its own setup wrote, so it never offered to work.
- **The Model Host steps aside for games.** Version 0.2.0 pauses by itself within a couple of
  seconds when a game starts on the gamestation (a program from a Steam, Epic, Xbox, GOG, Riot, EA
  or Ubisoft games folder, a full-screen app, another program computing on the GPU, or one on its
  always-pause list) and works again five minutes after the game closes. The recording it was on
  goes back to this computer instead of failing. A "pause or resume" shortcut on its desktop does
  the same by hand, and a pause made by hand waits for a hand to resume it. Settings > Transcription
  > Model host and the voice evidence panel say in words what the host is doing: working, paused
  for a game (which one, and until when), paused by hand, stopped, or off.

## 2026-10-02 | Columns that stay put, and meetings that follow the calendar

The Library list keeps every column in place while files download and transcribe, the reader shows
something at once when you open a recording, and a meeting that moves on the calendar no longer
keeps the recordings it used to cover.

### Changes

- **Stars and kind appear as soon as they are known.** A recording's evaluation (stars, team or
  project meeting) shows on its row the moment it is saved, without waiting for a refresh.
- **The date group no longer covers a row.** In the wide list, "Today", "This week" and the others
  show in the column header, next to Title, while you scroll.
- **Nothing shows above the column header.** While you scroll, the header sits on the top edge of the
  list; before, a strip of the row underneath showed above it.
- **A meeting recorded in pieces says so.** Two recordings of one meeting read "· part 1 of 2" and
  "· part 2 of 2".
- **Long recordings are not tied to one meeting by the clock.** A recording is linked by time only
  when the meeting covers at least half of it. A four-hour recording that holds lunch and three
  meetings is left for the transcript to decide.

- **Waiting looks like work, everywhere.** No screen says "Loading...", "Syncing..." or "In
  progress..." anymore. While something loads you see the shape of what is coming with a moving
  shimmer and a spinner (a pulsing clock while it waits its turn), and a bar with the percentage
  when it is known. Busy buttons keep their name and show a spinner. Hover to read what is
  happening.
- **Progress in its own place.** A download from the device shows in the file place (a clock while
  it waits, then the percentage) and a running transcription shows its percentage in the transcript
  place. Nothing is added at the end of the row, so date, time, length and icons line up with the
  header on every row. The tooltip says what the number counts.
- **Opening a recording.** The wave appears at once, drawn from the loudness the app already knows,
  and the exact one replaces it a moment later. Until then the space holds a placeholder in the
  shape of a wave; the transcript shows placeholder lines while it loads. A recording still being
  transcribed says whether it waits in the queue or is running, with the percentage and a bar.
- **Meeting links follow the calendar.** A recording linked to a meeting only by the time is
  checked again after every calendar sync. When the meeting moved and no longer covers half of the
  recording, the link is removed and the recording is matched again against the calendar as it is
  now. Links you chose, and links chosen from the transcript, are never changed.
- **No file names as titles.** A recording with no speech showed its file name in the list; it now
  shows "Recording" with its date, like any recording without a title.

## 2026-10-01 | Choose which AI runs each step

Settings has a Pipeline page: for each step the assistant and the library take, pick the harness,
the model and the effort, and see what the step costs.

### New

- **Settings > Pipeline.** Nine steps in three groups (Interactive, Speakers, Library). Each row says
  what the step runs on, where its text goes (this computer, the vendors, or wherever AI providers
  sends it), and the median time and cost of the last 30 days. Edit a step to choose the harness,
  a model (the harness lists its models; you can type any name) and an effort for harnesses that
  have levels. A step left on Automatic behaves as before.
- **A fallback for each step.** It runs only when the main choice fails or is not available.
- **Harnesses that cannot serve are greyed out with the reason**: not signed in, out of quota, or
  turned off in AI providers. A slow harness on a step that runs on every recording asks for one
  confirmation. A saved plan the app cannot run is marked on its row and the step runs as Automatic.
- **Nothing needs a restart.** The next call uses what you save.
- **Local server (OpenAI-compatible).** AI providers has a card for LM Studio, llama.cpp or vLLM:
  address, model, embedding model and an optional key.

### Changes

- **Setting an AI task back to Automatic on AI providers now sticks.** The earlier choice used to stay
  saved.

## 2026-09-30 | The Library list has a header and the card view is a card view

The list follows the width of its pane, a header names every column and sorts on click, and the
card view is a grid of cards.

### New

- **Header row on the wide list.** Title, Date, Time, Length, Rating and the three icon places each
  have a header. Click one to sort by it, click again to turn the order around. The icon headers
  show the icon the rows use, and their tooltips say what it can mean.
- **More ways to sort.** Stars, calendar meeting, file status and transcript join date, title,
  length and quality in Filters & sort. Title now sorts on the title the list shows, not on the
  file name.
- **Card view.** A grid of cards of one size: title over at most two lines, date, time and length,
  the chips, a line of the summary or the meeting, the state of the file and the transcript, and
  Play, Download or Transcribe. Everything else is in the card menu. Arrow keys move a row up
  and down and a card left and right.
- **More on the card, in the space it had.** How many actions and key points (decisions included) the
  analysis found, at the right of the date; the people as small circles with their initials, those who
  spoke first and then those who were only invited, faded; what is wrong in words (an error, a failed
  transcription, a transcript that may be invented or missing); and one button for the next step: Retry
  after a failure, otherwise Download or Transcribe. The meeting is a link in the footer. The card
  keeps its five blocks, and in a single column (a phone in portrait) it is as wide as the pane allows.

### Changes

- **Two icons less on a row.** A processing error now takes the place of the file-status icon
  (the green tick), and a problem with the transcript (wrong timing, text that does not fit the
  audio, text that may be invented or missing) takes the place of the transcription icon. The
  tooltip lists every problem and still says the state. The Legend explains both.
- **Narrow lists.** With the recording open beside the list, the title stays on one line and the
  date, time and length go on the second, with the chips after them. On a phone-width list the
  chips get a third line. A chip that does not fit is left out whole, or its kind is cut with an
  ellipsis, never sliced in half.
- **Cards no longer open the transcript inline.** Click the card to read it in the reader.

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
- **Recording page.** The HiDock switches (record meetings automatically, connect on start,
  download and transcribe automatically) are in Settings too, in sync with the Device page, with
  where recordings go. Auto-record is stored on the device and changes while it is connected.
- **Transcription as services.** Settings > Transcription lists Pipeline, Gemini, Local ASR &
  VibeVoice and Live transcription. Pipeline holds what happens to every recording: automatic
  transcription (also on the Device page), the default service, the language, automatic rating and
  the shortest clip to transcribe.
- **Storage you can read.** Each folder shows its size, file count and the free space on its own
  disk, with an optional limit; over the recordings limit, auto-download pauses. The connected
  HiDock's storage is on the same page.
- **Display.** A Settings page for the theme and the format of dates, times and numbers. Every
  date in the app now uses that one format; some screens forced US English before.
- **Player & notifications.** A Settings page for the skip length, the speeds in the speed menu,
  the speed recordings start at, and how long notices stay on screen.
- **Office hours and work days** are set in Settings > Calendar, and one calendar window (60 days
  back, 120 ahead) applies to the feed and Microsoft 365 alike.
- **Week starts on.** Settings > Calendar picks Monday, Sunday or Saturday, and the week and
  month views now agree (they started on Monday and on Sunday).
- **A switch per feature.** Settings > Features lists every feature with its own switch, what it
  costs to run and what it needs; the preset changes to Custom when your set matches none. The
  main Jev switch is there too.
- **Close the reader.** An X next to the title closes it and unselects the recording (Esc does the
  same). The title stays at the top while you scroll.
- **Click a time to play.** A time in the transcript starts the recording there, even when nothing
  is playing.
- **Live streams become recordings.** Realtime streaming on the Device page now also writes both
  channels to a WAV in the recordings folder. When it stops, the recording is in the Library, linked
  to its meeting and transcribed like any other, diarization included. A stream cut off by a crash
  or an unplugged cable is saved too. Off with the switch in Settings > Recording.
- **"This is you".** Choose your contact on Settings > Speakers & voices. In a live stream saved
  from the HiDock, the speaker on the microphone channel is then named after you. Nobody is named
  when that is not clear.
- **Secrets, Shortcuts and Library pages.** Secrets lists every stored key and token, set or
  not, with Replace and Remove; Shortcuts lists the keys HiDock answers to; Library sets the rows,
  the sort and how each part of a source opens.
- **Captures folder.** Images and imported files have a folder setting on Storage and Privacy &
  capture, with its size and limit, and a move like recordings and transcripts.
- **Chat placement and clipboard capture are saved with the other settings**, instead of only in
  the window; the choice already made is kept.
- **Quality checks.** The thresholds behind warnings and ratings are settings now: when a quiet file
  or a thin transcript is flagged, how sure Jev must be before a transcript "may be invented" or a
  meeting is linked, when a short clip is low-value, retries, the re-transcription score and the
  live silence gate. Changing a warning rule updates the saved warnings; changing Jev's reason
  threshold updates saved reasons without asking Jev again.
- **Developer > Advanced.** The tuning values that had no control get one: search passage size and
  overlap, the Gemini chat model, the VibeVoice model and device, the rating confidence floor, and
  the voice-matching threshold, margin, minimum speech, time limit and paths. Each shows its default
  and has a Reset.
- **Connectors, easier to set up.** The Slack channel list has "Choose all shown" for the filtered
  channels, and says what a sync does: one Library item per channel, what edits do, and what it does
  not do yet (channel summaries, reports, people matching). The ICS calendar feed has Disconnect.

### Fixes

- Recordings never linked to Outlook meetings: the linker only read the ICS feed.
- Microsoft 365 and Slack only synced when you pressed Sync; they now sync on the calendar interval.
- A Slack token saved after startup kept answering "token missing" until a restart.
- A first Slack sync would have pulled every channel; channels now start off and are picked in a
  searchable list.
- A new Hugging Face token, or a new transcription provider, was silently reset whenever another
  setting saved.
- The audio-versus-transcript warning flagged real short clips and long quiet meetings.
- Row icons now keep their place, so a missing one reads as a gap.
- The RAG Context Window, chunk size and chunk overlap settings were saved and ignored; they are
  read now, and at their defaults nothing changes. Five settings nothing used are gone.
- Changing a storage folder only created the new one: files stayed, every recording kept pointing
  at the old folder, and the folder watcher kept watching it. Settings now offers to move the files
  (copied and checked, stored paths updated, originals kept) or to switch without moving.
- A speed picked in the player reset to 1x on the next recording while the menu still showed
  the old speed.
- A .flac recording could be imported but was then missed by the folder watcher, the file date
  fix and the orphan and date checks; every place now uses the same list of audio types.
- A transcript with one line out of time order refused every edit ("Invalid transcript edit"), and
  saving an edit dropped the speaker-confidence marks.
- **A fixed transcript loses its warning.** Editing a line's time fixed the problem but kept the
  "times are wrong" warning, and its jump buttons found nothing. A saved edit is now checked again,
  every transcript is checked again once at the next start, and "Accept as is" survives a wording
  fix that leaves the same problems.
- **Moving a storage folder is safe to stop.** One move at a time; downloads, transcription and the
  folder watcher pause while it runs; each file is copied, checked, then renamed; Stop removes the
  copies; a failed save puts every path back. If a folder cannot be measured, automatic downloads
  pause instead of filling the disk.
- **Slack items no longer flood the Library.** Every message was going to become its own Library
  item. Now each channel is one item, an edited message replaces its old copy, and an unchanged one
  is skipped.

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
