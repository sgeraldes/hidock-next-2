# Settings redesign

Owner request, 28-sep-2026: menu-driven Settings in the style of Kiro Crew, every setting the app
has in the right place, and every hardcoded value a person could want to change moved into
configuration.

## What we start from (inventory, 28-sep)

- Settings in seven places: `config.json` (AppConfig), `brains.json` (provider secrets),
  `connectors.json`, the `hidock-ui-store` and `hidock-library-store` browser stores, two single
  keys, and the Model Host's own files on the GPU machine.
- One long page with 15 cards. Theme, calendar view and the device switches are edited elsewhere.
- About 25 config keys with no control; eight are never read (`storage.maxRecordingsGB`,
  `embeddings.chunkSize`, `embeddings.chunkOverlap`, `chat.maxContextChunks` is ignored by RAG,
  `speakerLinkingModel`, `speakerLinkingFallbackModel`, `brains.models`, `ui.defaultView`,
  `ui.startOfWeek`).
- About 330 hardcoded values in the main process and packages (about 65 worth showing) and about
  200 in the renderer (about 85 worth showing), with 19 groups of duplicated or conflicting
  defaults.
- Security: `transcription.geminiApiKey` and `localAsrHfToken` are stored in plain text, and
  `config:get` sends every secret, decrypted, to the renderer.
- Shipped defaults that are one person's machine: `localAsrPath` (`G:\Code\...\mcp-asr`) and the
  Codex companion path.

## Layout

A menu on the left, one page on the right (Kiro Crew). The menu has a search box that matches a
page by what it holds ("token" finds Speakers & voices), and groups:

| Group | Pages |
|---|---|
| (top) | Overview, Features |
| Preferences | Display, Library, Player, Assistant, Calendar, Notifications, Shortcuts, Privacy & capture |
| Services | Transcription, Speakers & voices, AI providers, Connectors, Decisions (Jev) |
| System | Storage & backups, Maintenance, Performance, Security, Secrets, Prompts, Developer, About |

One setting, two pages (owner, 28-sep-2026). A setting may appear on two pages when both are
natural places to look for it, as long as it is one config key and both controls read and write
it, so they never disagree. Storage shows every location (captures, transcripts, recordings) and
each also sits on its own page: the captures folder on the capture page, transcript storage on
Transcription, recordings storage on Recording.

Recording gets its own page once the recording feature from the standalone app is integrated:
auto-record from the HiDock, local recording, and where recordings go.

Under 768 px the menu becomes one picker above the page. Every page is `/settings/<id>`; the old
`/settings#features` anchors redirect.

### Option rows

Every option is one row: title, one plain sentence on what it does (and, where it matters, what it
sends and where), the control on the right. Rows sit in titled groups. On a narrow window the
control drops under the text. Saving is immediate for switches and lists; text fields that need a
check (keys, paths) have their own Save.

### Services: a list and a detail pane (Messaging Channels)

Transcription, Speakers & voices, AI providers and Connectors use one pattern:

- On the left, every service with its state in words: Needs setup, Connected, In use, Off.
- On the right, the selected one: a header with the state; a "Get your credentials" box with the
  actions that get a key or register an app (open the provider page, setup guide, copy a manifest);
  then Required, Identity & access, and Behavior groups.

Services: Gemini, Local ASR, VibeVoice, Model Host, the speaker model (Hugging Face), Microsoft 365
(one entry per account), Slack, Calendar (ICS), Jev, Ollama, local embeddings, Claude Code, Codex,
Kiro, Gemini CLI.

### Decisions (Jev): one switch, then one per job

- A switch for Jev with the plain statement of what leaves the computer and where it goes
  (`https://api.typesafe.ai/v1/systemone`), and the key.
- Under it, one switch per job, each off until turned on, each saying what it sends:
  value and stars; kind and work or personal; transcript trust (invented, overfull); speaker
  suggestions (when built).
- "What Jev decides while this is on": one line per decision with the name it is logged under.
- The thresholds that turn Jev's answers into labels (warning rules, invented threshold, reason
  threshold, stars to value) in an Advanced group, with Reset to default.

## Configuration

One typed schema (`config.ts`) holds every value, with its default next to it. The renderer never
repeats a default: it reads the saved value. Groups follow the pages above. Developer-only values
(timeouts, batch sizes, retry spacing) live under Developer > Advanced, each with its default shown
and a Reset.

Fix first, before new controls:

1. Secrets: encrypt `geminiApiKey` and `localAsrHfToken` at rest; `config:get` returns "set / not
   set" for every secret instead of the value; keys are written through their own IPC.
2. Machine paths: `localAsrPath` defaults to empty with a folder picker; the Codex companion path
   is detected, then configurable.
3. Keys that do nothing: wire `embeddings.chunkSize`, `chunkOverlap`, `chat.maxContextChunks` to
   RAG, `ui.startOfWeek` to the calendar (week and month grids disagree today: Monday and Sunday),
   `storage.maxRecordingsGB` to a real quota warning, or remove them.
4. One source per default: the Gemini model id is inlined in 11 places; language falls back to
   es, unknown, auto or en depending on the engine; the audio extension list differs in three files.
5. Microsoft 365 syncs on a schedule (the host has `scheduleSync`, main never calls it).
6. The Ollama URL is also in the renderer CSP; changing it in Settings must update what the CSP
   allows.

## Phases

1. Shell: menu, search, one page per area, overview and about. Existing cards move as they are.
   (This PR.)
2. Services pages in the list-and-detail pattern.
3. Decisions (Jev) page with per-job switches (needs main-process gates per job).
4. Security and Secrets: encryption at rest, redacted `config:get`, a Secrets page listing every
   stored credential with set, replace and remove.
5. Preferences pages: Display (theme, language and locale, date and time format, week start,
   density, start page), Library, Player (skip, speeds, default speed), Calendar (office hours,
   work days, visible hours), Notifications (toast and undo durations), Shortcuts (the list).
6. The remaining hardcoded values into config, page by page, with Developer > Advanced for the
   internal ones.

Each phase: tests, a short review, merge, build.
