# Paste to Library

Press Ctrl+V anywhere in the HiDock Next window (Cmd+V on macOS). Inputs,
textareas and editable content keep normal paste behavior. The header's **New**
menu offers **Paste**, **Import file**, and **New note**. Paste reads the same
clipboard; Import file uses the same import routing. New note opens the existing
empty note editor. The recorder branch adds Record to `NewMenu()` in
`apps/electron/src/components/layout/PcRecording.tsx`.

| Clipboard content | Library behavior |
| --- | --- |
| Images or screenshot bitmap | Stored as image artifacts; bitmap becomes PNG in the configured data/captures storage. No vision request. |
| PDF | Original PDF stored with locally extracted text. Scanned PDFs can have no readable text. |
| Audio | Copied through the existing external recording importer. Paste does not start transcription. |
| Video (`mp4`, `mov`, `mkv`, `avi`, `m4v`, `webm`) | Original stored as a video artifact. Bundled ffmpeg extracts its first audio track to WAV, imported as a recording and linked in artifact metadata. Open the video source's audio/transcript action to reach that recording. Transcription follows the existing auto-transcribe setting and feature availability. |
| Plain text | A Library note artifact, titled from its first line (up to 80 characters). |
| Text/Markdown/JSON files | Existing document/note artifact import, preserving the original file and extracted text. |
| Slack message/thread/channel URL | A configured connector for that workspace reads messages through the existing Slack client and mapper; the snapshot stores up to 100 messages with connector provenance. No automatic channel subscription or attachment downloads. Missing/inaccessible connector falls back to a link. |
| Jira issue URL | Link fallback: no Jira connector is registered in this checkout. |
| Other HTTP(S) URL | Link artifact stores URL, page title and readable text. Electron net fetch uses no credentials, a 10-second deadline, a 1 MiB response limit and a 100,000-character text limit. Script/style content is stripped. A failed fetch preserves the URL with an explanatory notice. |
| Other files | Existing artifact store preserves the file; unregistered formats may have no preview or extracted text. |

Each successful item shows **Added to Library: &lt;title&gt;** with **Open**.
Failures name the source and reason; batches continue after a failed file. If a
video has no audio or ffmpeg fails, the original video remains stored and the
error explains that audio processing failed. Re-pasting an already stored video
with extracted audio does not create another audio recording.

Explicit paste/import does not call vision, enrichment or embedding providers.
Only video audio may enter the user's configured transcription pipeline. Later
explicit AI actions and normal background indexing retain the app's settings.
No additional tables or dependencies are introduced: link and video are new
artifact type registrations over the existing artifacts/knowledge_captures
store; external audio stays in recordings. Empty editor notes use the existing
notes table.

Pasted videos support files up to 512 MiB. Larger files show “Video exceeds the
512 MB limit.” before storage or audio extraction. Hashing and copying stream
asynchronously; video bytes are never loaded for text extraction.

Readable web links allow only public HTTP(S) destinations. DNS answers and each
redirect are checked, connections use the checked address, and all responses
are torn down within the fetch deadline.
