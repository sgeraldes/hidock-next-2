# Batch speech-to-text with speaker diarization: API contracts (checked 23 Sep 2026)

Scope: pre-recorded files, called over plain HTTPS from an Electron main process (Node fetch + FormData), no vendor SDK. No paid API was called and no account was created. Everything below comes from the vendors' own docs pages unless marked UNVERIFIED. The docs were read through a fetch-and-summarize tool, so field names were taken from quoted code blocks where possible; anything only paraphrased is flagged.

## Comparison at a glance

| | Gemini 3.5 Transcribe | OpenAI gpt-4o-transcribe-diarize | AssemblyAI Universal-3.5 Pro | Meta Muse Voice Transcribe | pyannoteAI Precision-3 |
|---|---|---|---|---|---|
| Call style | POST /v1beta/interactions (sync, or background + poll) | POST /v1/audio/transcriptions (sync, multipart) | upload, create job, poll or webhook | POST /v1/asr/transcribe (sync, multipart) | upload, create job, poll or webhook |
| Max audio per request with diarization | 30 min (1 h without) | 25 MB file; no stated duration | 10 h, 2.2 GB upload / 5 GB by URL | 10 min, 32 MB, WAV PCM only | 24 h, 1 GiB |
| Max speakers | 8 (3+ is "experimental") | not stated; up to 4 named references | default 10 (2-10 min audio) / 30 (10+ min), settable | "20+" | settable (numSpeakers / min / max) |
| Timestamps | word level, with speaker per word | segment level only | word and utterance level, in ms | turn level only, in ms | segment; word and turn level if transcription on |
| Known speakers / voiceprints | no | yes: up to 4 audio clips of 2-10 s as data URLs | names/roles inferred from content, no voice matching | no | yes: storable voiceprint string, identify endpoint |
| Returns speaker embeddings | no | no | no | no | yes (opaque base64 voiceprint) |
| Spanish | yes (85+ locales) | yes | yes (1 of 18 languages) | yes (1 of 25 validated) | diarization is language-agnostic; STT 99 languages |
| Price | about $0.005/min blended ($0.30/h) paid tier | $0.006/min ($0.36/h) | $0.21/h + $0.02/h diarization = $0.23/h | $0.18/h | €0.112/h (Developer) or €0.096/h (Starter), diarization only; €0.168/h with hosted STT |
| Training on your data | paid tier no, free tier yes | no | yes by default after PII redaction, unless opted out, BAA, or EU servers | UNVERIFIED | UNVERIFIED (GDPR-compliant claim only) |
| Retention | interactions stored 55 days paid (1 day free) unless store=false; files 48 h | none by default for this endpoint; ZDR eligible | audio deleted 24-48 h, transcripts 30 days, DELETE endpoint | ZDR on request via sales; default not stated | media 48 h, job output 24 h |

---

## 1. Google Gemini 3.5 Transcribe (`gemini-3.5-transcribe`)

Status: public preview according to MarkTechPost's launch coverage (27 Aug 2026, "Both developer and enterprise tracks are in public preview"). The ai.google.dev model page and pricing page, as fetched, did not carry a preview label. Treat it as preview until Google's page says otherwise.

Streaming sibling `gemini-3.5-transcribe-live` does not support diarization or word timestamps, so diarization is batch-only.

### Auth
`x-goog-api-key: $GEMINI_API_KEY`

### Upload (Files API, resumable, REST)
The transcription page shows audio passed by `uri` from the Files API. Files API: 2 GB per file, 20 GB per project, files kept 48 hours, free. Use the Files API when the total request exceeds 100 MB. Whether the Interactions API also accepts inline base64 audio for this model is UNVERIFIED; the docs example only uses `uri`.

The resumable upload is the standard Gemini Files API protocol (the page confirms the headers; the command below is the documented shape, reproduced from the long-standing docs pattern, UNVERIFIED verbatim for this date):

```bash
# 1. start
curl "https://generativelanguage.googleapis.com/upload/v1beta/files" \
  -D headers.txt \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "X-Goog-Upload-Protocol: resumable" \
  -H "X-Goog-Upload-Command: start" \
  -H "X-Goog-Upload-Header-Content-Length: $NUM_BYTES" \
  -H "X-Goog-Upload-Header-Content-Type: audio/mpeg" \
  -H "Content-Type: application/json" \
  -d '{"file": {"display_name": "rec-001"}}'
# upload URL is in the x-goog-upload-url response header
# 2. upload + finalize
curl "$UPLOAD_URL" \
  -H "Content-Length: $NUM_BYTES" \
  -H "X-Goog-Upload-Offset: 0" \
  -H "X-Goog-Upload-Command: upload, finalize" \
  --data-binary "@rec-001.mp3"
# response: {"file": {"name": "files/...", "uri": "https://generativelanguage.googleapis.com/v1beta/files/...", ...}}
```

### Transcription request (verbatim from ai.google.dev/gemini-api/docs/transcribe)

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-transcribe",
    "input": [
      { "type": "audio", "uri": "YOUR_FILE_URI", "mime_type": "audio/mp3" }
    ],
    "generation_config": {
      "transcription_config": {
        "mode": {
          "type": "verbatim",
          "diarization_mode": "speaker",
          "timestamp_granularities": ["word"]
        }
      }
    }
  }'
```

Other `transcription_config` fields:
- `language_codes`: BCP-47 list, e.g. `["es-AR"]` or `["es-ES"]`; omit or `[]` for auto-detect with code-switching.
- `custom_vocabulary`: up to 1,000 terms. Not compatible with diarization or word timestamps, so no vocabulary biasing on a diarized call.
- `mode.type` must be `"verbatim"` when diarization or timestamps are on.

Long jobs: the Interactions API accepts `background: true` and is polled with `GET /v1beta/interactions/{id}`. `store: false` disables server-side storage but is incompatible with background execution. So a 30-minute file either runs synchronously with `store:false` (hold the HTTP connection open) or in background with storage on.

### Response (trimmed, from the docs)

```json
{
  "id": "interactions/abc123xyz",
  "status": "completed",
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "Hello world",
          "annotations": [
            { "type": "word_info", "text": "Hello", "speaker": "spk_1",
              "start_offset": "0.100s", "end_offset": "0.450s" }
          ]
        }
      ]
    }
  ]
}
```
Full text is also exposed as `output_text`. Offsets are duration strings (`"0.100s"`) and need parsing. Speaker labels are `spk_1`, `spk_2`, and so on. Turns have to be built client-side by grouping consecutive words with the same speaker.

### Limits
- 1 hour per request; 30 minutes when diarization or word timestamps are on.
- Up to 8 speakers; 3 or more is labelled experimental.
- Formats: WAV, MP3, AIFF, AAC, OGG, FLAC, MPEG, M4A, L16, Opus, ALAW, MULAW, WebM.
- Rate limits: not stated on the pages read.

### Price (ai.google.dev/gemini-api/docs/pricing)
Paid tier: input $2.00 per 1M tokens (about $0.003/min), output $12.00 per 1M tokens (about $0.002/min); Google's blended estimate is about $0.005/min (25 audio tokens per second in, 175 text tokens per minute out). Free tier: free of charge, and content is used to improve Google products. Whether diarization or word timestamps increase output tokens (and thus cost) is not stated; the annotation payload is large, so expect higher output cost than the blended estimate (UNVERIFIED).

### Privacy
- Paid tier: content not used to improve products. Free tier: used.
- Interactions retained 55 days on paid (1 day free) unless `store:false`; retention can be set to 7/14/28/55 days in AI Studio.
- Uploaded files auto-delete after 48 hours (can be deleted earlier with `DELETE /v1beta/files/{name}`, standard Files API).

### Sources
- https://ai.google.dev/gemini-api/docs/transcribe
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/files
- https://ai.google.dev/gemini-api/docs/interactions
- https://www.marktechpost.com/2026/08/27/google-ai-releases-gemini-3-5-transcribe-a-speech-to-text-model-reporting-2-6-average-wer-across-85-languages/ (preview status; secondary source)

---

## 2. OpenAI `gpt-4o-transcribe-diarize` (and `gpt-transcribe`)

`gpt-transcribe` (released 28 July 2026, $0.0045/min) is now OpenAI's recommended transcription model, but the speech-to-text guide states it does not support diarization. Diarization still requires `gpt-4o-transcribe-diarize`. The diarize model's page shows no deprecation notice.

### Auth
`Authorization: Bearer $OPENAI_API_KEY`

### Request (verbatim from developers.openai.com speech-to-text guide)

```bash
curl --request POST \
  --url https://api.openai.com/v1/audio/transcriptions \
  --header "Authorization: Bearer $OPENAI_API_KEY" \
  --header 'Content-Type: multipart/form-data' \
  --form file=@/path/to/file/meeting.wav \
  --form model=gpt-4o-transcribe-diarize \
  --form response_format=diarized_json \
  --form chunking_strategy=auto \
  --form 'known_speaker_names[]=agent' \
  --form 'known_speaker_references[]=data:audio/wav;base64,AAA...'
```

Parameters that matter:
- `response_format`: `json`, `text`, or `diarized_json`. Only `diarized_json` returns speaker labels.
- `chunking_strategy`: required for audio longer than 30 seconds; `auto` or a server VAD object.
- `known_speaker_names[]` + `known_speaker_references[]`: up to 4 pairs; each reference is a 2 to 10 second clip sent as a data URL. Segments that match get the given name; others get letters (`A`, `B`, ...). Repeat the form field per entry (a litellm bug report notes proxies that collapse repeated fields break this).
- `language`: optional hint (`es`).
- `prompt`, `include[]=logprobs`, `timestamp_granularities[]`: the guide says prompts are not supported with the diarize model; word timestamps are not available for it (segment level only). The logprobs/timestamp exclusion is from the guide's paraphrase, UNVERIFIED verbatim.
- `stream=true`: emits `transcript.text.segment` events as each segment completes.

### Response (diarized_json, from the API reference)

```json
{
  "task": "transcribe",
  "duration": 27.4,
  "text": "Full concatenated transcript",
  "segments": [
    { "id": "seg_001", "start": 0.0, "end": 4.7, "text": "Segment transcript",
      "speaker": "agent", "type": "transcript.text.segment" }
  ],
  "usage": { "type": "duration", "seconds": 27 }
}
```
Times are seconds (float).

### Limits
- 25 MB per file. Formats: mp3, mp4, mpeg, mpga, m4a, wav, webm.
- No stated maximum duration; the 25 MB cap is the practical limit (about 50 min of 64 kbps mono MP3). Longer recordings must be split client-side, and speaker letters will not match across splits unless known-speaker references are sent with every split.
- Model page: 16,000-token context, 2,000 max output tokens. How that interacts with chunked long audio is not explained (UNVERIFIED; test before relying on long files).
- Rate limits: Tier 1 500 RPM / 10,000 TPM up to Tier 5 10,000 RPM / 6,000,000 TPM.

### Price
$0.006 per minute (token rates: $2.50 input / $10.00 output per 1M tokens). `gpt-transcribe` without diarization: $0.0045/min.

### Privacy
Data-controls table row for `/v1/audio/transcriptions`: not used for training, no abuse-monitoring retention, no application state, Zero Data Retention eligible. (Read from the summarized table; confirm on the page before telling anyone it is "zero retention by default".)

### Sources
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize
- https://developers.openai.com/api/docs/models/gpt-transcribe
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/your-data
- https://github.com/BerriAI/litellm/issues/29766 (repeated form fields pitfall)

---

## 3. AssemblyAI Universal-3.5 Pro (`universal-3-5-pro`, released 7 July 2026)

### Auth
`authorization: $ASSEMBLYAI_API_KEY` (raw key, no `Bearer`).
Base URL `https://api.assemblyai.com`. EU base URL `https://api.eu.assemblyai.com` is UNVERIFIED (docs mention "European servers" but the pages read did not print the host).

### Flow

```bash
# 1. upload local file (max 2.2 GB); returns {"upload_url": "https://cdn.assemblyai.com/upload/..."}
curl -s -X POST https://api.assemblyai.com/v2/upload \
  -H "authorization: $ASSEMBLYAI_API_KEY" \
  --data-binary @./rec-001.mp3

# 2. create transcript
curl -s -X POST https://api.assemblyai.com/v2/transcript \
  -H "authorization: $ASSEMBLYAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "audio_url": "https://cdn.assemblyai.com/upload/...",
    "speech_models": ["universal-3-5-pro"],
    "language_code": "es",
    "speaker_labels": true,
    "speaker_options": { "min_speakers_expected": 2, "max_speakers_expected": 6 }
  }'
# returns {"id": "...", "status": "queued", ...}

# 3. poll until status is completed or error (queued -> processing -> completed | error)
curl -s https://api.assemblyai.com/v2/transcript/$ID \
  -H "authorization: $ASSEMBLYAI_API_KEY"

# 4. delete when done (removes transcript and the uploaded file)
curl -s -X DELETE https://api.assemblyai.com/v2/transcript/$ID \
  -H "authorization: $ASSEMBLYAI_API_KEY"
```
`language_code` vs `language_detection: true`: both exist; Universal-3.5 Pro code-switches natively across its 18 languages. A `webhook_url` field is the standard alternative to polling (not shown on the pages read, UNVERIFIED for this model).

Diarization parameters: `speaker_labels` (bool), `speakers_expected` (exact count), `speaker_options.min_speakers_expected` / `max_speakers_expected` (hard limits), `speaker_options.include_speaker_confidence` (bool). Default speaker ceiling: 10 for 2-10 minute files, 30 for files over 10 minutes.

### Response (trimmed)

```json
{
  "id": "...",
  "status": "completed",
  "text": "...",
  "words": [ { "text": "Smoke", "start": 250, "end": 650, "confidence": 0.97, "speaker": "A" } ],
  "utterances": [
    { "speaker": "A", "text": "Smoke from hundreds of wildfires in Canada is triggering air quality alerts.",
      "start": 250, "end": 28840, "confidence": 0.97, "words": [ ... ] }
  ]
}
```
Times are milliseconds. The per-word `speaker` field follows AssemblyAI's long-standing schema (UNVERIFIED on the page read for 3.5).

### Speaker Identification (names, not voices)
`speech_understanding.request.speaker_identification` with `speaker_type: "name" | "role"` and `speakers: [{name, description?, ...}]`. It infers identity from what is said in the conversation, not from voice samples. Response adds `speech_understanding.response.speaker_identification.mapping` (e.g. `{"A": "Michel Martin"}`) and rewrites utterance speakers. Priced at +$0.02/h. No embeddings are returned.

### Limits
10 hours and 5 GB per transcript (2.2 GB via `/v2/upload`). Languages for 3.5 Pro: English, Spanish, French, German, Italian, Portuguese, Arabic, Danish, Dutch, Finnish, Hebrew, Hindi, Japanese, Mandarin, Norwegian, Swedish, Turkish, Vietnamese.

### Price
$0.21/h for Universal-3.5 Pro, +$0.02/h diarization, +$0.02/h speaker identification. EU same as US on the pricing page (a search snippet claimed in-region is 10% higher; the official pricing page read says same price). $50 free credits.

### Privacy
- Pre-recorded, no BAA: audio deletion starts at 24 h (done by 48 h); transcripts auto-deleted from 30 days; DELETE endpoint removes transcript and uploaded file immediately.
- Model training: by default AssemblyAI may train on submitted files after PII redaction. Not used if you opt out, have a BAA, or use the EU servers.
- Zero data retention is offered for the Streaming product (when opted out of training), not stated for async.
- HIPAA BAA self-serve.

### Sources
- https://www.assemblyai.com/docs/pre-recorded-audio/speaker-diarization
- https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file
- https://www.assemblyai.com/docs/speech-understanding/speaker-identification
- https://www.assemblyai.com/blog/universal-3-5-pro-async
- https://www.assemblyai.com/pricing
- https://www.assemblyai.com/docs/faq/are-there-any-limits-on-file-size-or-file-duration-for-files-submitted-to-the-api
- https://assemblyai.com/docs/faq/does-assemblyai-offer-zero-data-retention

---

## 4. Meta Muse Voice Transcribe (`muse-voice-transcribe-1.0`)

A public API exists. Launched 3 Sep 2026, generally available on Meta Model API (`https://api.meta.ai/v1`), alongside Meta AI for Mac and Muse Code. Built mainly for streaming; the file endpoint is short-form.

### Auth
File endpoint: `Authorization: Bearer $MODEL_API_KEY`. WebSocket: key goes inside the handshake JSON frame (`"authorization": {"accessToken": "Bearer <API_KEY>"}`), HTTP headers are ignored.

### File request (from dev.meta.ai/docs/speech-to-text)

```bash
curl -X POST 'https://api.meta.ai/v1/asr/transcribe?sessionId=my-id' \
  -H "Authorization: Bearer $API_KEY" \
  -F 'request={"mode":"DIARIZATION","model":"muse-voice-transcribe-1.0"};type=application/json' \
  -F 'audio=@file.wav'
```
Request fields: `mode` (`PUSH_TO_TALK` default, `ENDPOINTING`, `DIARIZATION`), `model`, `audioEncoding` (`WAV` for files; `PCM_16KHZ` / `PCM_24KHZ` for streaming), `languageBias` (list), `keywords` (list). The exact JSON spelling of `languageBias` values (e.g. `"es"` vs `"SPANISH"`) is UNVERIFIED.

Streaming: `wss://api.meta.ai/v1/asr/realtime`, sessions up to 60 minutes. That is the only way to get more than 10 minutes in one diarized session.

### Response

```json
{
  "sessionId": "...",
  "transcript": "complete text",
  "audioDurationMs": 8240,
  "turns": [
    { "turnId": 1, "startMs": 1520, "endMs": 4640, "transcript": "...", "speaker": "A" }
  ]
}
```
Turn-level timestamps only, no word timestamps. Speaker labels are session-scoped letters.

### Limits
- File: 32 MB body, 10 minutes, mono 16-bit PCM WAV at 16 or 24 kHz only. MP3/Opus must be decoded client-side first.
- Speakers: marketing says "20+"; the docs page as read only says one speaker per turn. No hard number found.
- 128 concurrent streams and 16,000 streams per hour, shared by file and realtime.
- Languages: 25 validated at launch including Spanish; trained on 70+.

### Price
$0.18 per hour ($3.00 per 1,000 minutes), billed per whole second; failed and rate-limited requests not charged; platform free-tier credits apply.

### Privacy
- Zero Data Retention exists for "qualified" accounts, enabled only through the sales contact form, and "may vary by model"; whether it covers speech-to-text is not stated.
- Default retention period and whether API audio is used for training: not found in the docs read. UNVERIFIED. The pricing page mentions a "discounted training-eligible tier" that is not offered for this model at launch, which implies the standard tier is not training-eligible, but that is an inference.
- Country availability: not stated. UNVERIFIED whether Argentina/Uruguay accounts can sign up.

### Sources
- https://dev.meta.ai/models/muse-voice-transcribe
- https://dev.meta.ai/docs/speech-to-text/
- https://dev.meta.ai/docs/overview
- https://dev.meta.ai/docs/pricing-rate-limits
- https://dev.meta.ai/help/policies-and-privacy/zero-data-retention
- https://dev.meta.ai/resources/blog/meet-muse-voice-transcribe-streaming-speech-to-text/

---

## 5. pyannoteAI hosted API

Diarization first; transcription is now an option on the same job (`transcription: true`, "STT orchestration"), with hosted STT or bring-your-own.

### Auth
`Authorization: Bearer $PYANNOTE_API_KEY`, base `https://api.pyannote.ai`.

### Upload a local file

```bash
# 1. declare a media key; response carries a presigned PUT URL
curl -X POST https://api.pyannote.ai/v1/media/input \
  -H "Authorization: Bearer $PYANNOTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "media://rec-001"}'
# 2. PUT the bytes
curl -X PUT "$PRESIGNED_URL" -H "Content-Type: application/octet-stream" --data-binary @rec-001.mp3
```
Media is removed within 48 hours.

### Diarize

```bash
curl -X POST https://api.pyannote.ai/v1/diarize \
  -H "Authorization: Bearer $PYANNOTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "media://rec-001", "model": "precision-3", "minSpeakers": 2, "maxSpeakers": 6,
        "confidence": true, "exclusive": true, "transcription": false }'
# -> {"jobId": "...", "status": "created", "warning": null}
```
Body fields: `url`, `model` (`precision-2` default, `precision-3`, `community-1`), `numSpeakers`, `minSpeakers`, `maxSpeakers`, `webhook`, `webhookStatusOnly`, `turnLevelConfidence`, `exclusive` (no overlapping segments; handy for aligning with a separate STT), `confidence`, `transcription`, `transcriptionConfig`, `speechProbability`, `crosstalkProbability`, `speakerProbability`.

Poll `GET /v1/jobs/{jobId}` (statuses: pending, created, running, succeeded, failed, canceled):

```json
{
  "jobId": "fb16c565-...",
  "status": "succeeded",
  "output": {
    "diarization": [
      { "speaker": "SPEAKER_00", "start": 15, "end": 30.5,
        "confidence": { "SPEAKER_00": 93, "SPEAKER_01": 7 } }
    ],
    "wordLevelTranscription": [ { "start": 0.5, "end": 0.8, "text": "Hello", "speaker": "SPEAKER_00" } ],
    "turnLevelTranscription": [ { "start": 0.5, "end": 2.3, "text": "Hello, how are you?", "speaker": "SPEAKER_00" } ]
  }
}
```
Job output is kept 24 hours after completion. Times are seconds.

### Voiceprints and cross-recording identification
This is the only service in the list that hands back a reusable voice signature.
- `POST /v1/voiceprint` with `{ "url": "...", "model": "precision-3" }`; sample must be at most 30 seconds. Job output: `{ "voiceprint": "U29tZVZvaWNlUHJpbnREYXRhMQ==" }`, an opaque base64 string that you store yourself (it is deleted from pyannote after 24 h).
- `POST /v1/identify`:
  ```json
  { "url": "media://rec-002",
    "voiceprints": [ { "label": "Yaravi", "voiceprint": "U29t..." } ],
    "matching": { "threshold": 50, "exclusive": true } }
  ```
  Output has an `identification` array (segments with `speaker`, `start`, `end`, `match`) and a `voiceprints` array with per-label confidence, e.g. `"confidence": { "John Doe": 86 }`.
- The voiceprint is opaque: you cannot compare two voiceprints locally or feed them into a local model; matching only happens through `/v1/identify`. The format is not documented as a raw embedding vector.

### Limits
24 hours of audio and 1 GiB per file (FAQ). Diarization is language-agnostic.

### Price (pyannote.ai/md/models)
- Precision-3 diarization: €0.112/h (Developer plan, €19/month incl. 125 h) or €0.096/h (Starter, €99/month incl. 825 h).
- Community-1 hosted: €0.035/h.
- With hosted STT: €0.168/h Developer, €0.144/h Starter; with your own STT €0.146/h / €0.125/h.
- Voiceprint: €0.015 each, one-time. Precision-3 only per the models page (the voiceprint endpoint also lists precision-2).
- 30-day trial with 150 hours, no card (search snippet of the pricing page).

### Privacy
Media deleted within 48 h, outputs within 24 h. "GDPR compliant on all plans. EU data residency available on Enterprise." Training use and ZDR: not stated in the pages read, UNVERIFIED.

### Sources
- https://docs.pyannote.ai/api-reference/diarize
- https://docs.pyannote.ai/api-reference/get-job
- https://docs.pyannote.ai/api-reference/voiceprint
- https://docs.pyannote.ai/tutorials/identification-with-voiceprints
- https://docs.pyannote.ai/tutorials/how-to-upload-files
- https://docs.pyannote.ai/support/faqs
- https://www.pyannote.ai/md/models
- https://www.pyannote.ai/pricing

---

## Known speakers / embeddings summary

| Service | Mechanism | Works across recordings |
|---|---|---|
| Gemini 3.5 Transcribe | none; labels `spk_N` per request | no |
| OpenAI diarize | `known_speaker_references[]` audio clips (max 4, 2-10 s) per request | yes, if the same clips are resent every call; capped at 4 people |
| AssemblyAI | Speaker Identification by name/role from conversation content | only when names are spoken or roles are obvious; no voice matching |
| Meta Muse | none documented | no |
| pyannoteAI | stored voiceprint strings + `/v1/identify` | yes, unlimited stored voiceprints, matched with a confidence score |

None of the five returns a raw embedding vector that could be compared locally.

## Notes for the HiDock integration
- HiDock recordings are MP3 bytes inside a `.wav`/`.hda` container whose header lies. Send them with the MP3 MIME type and extension (`audio/mpeg`, `.mp3`), or transcode. Meta is the only one that needs real PCM WAV and would require decoding.
- Recordings longer than 30 minutes need splitting for Gemini (diarized), over roughly 25 MB for OpenAI, and over 10 minutes for Meta's file endpoint. Splitting breaks speaker label continuity; AssemblyAI (10 h) and pyannote (24 h) take a full meeting in one job.
- Pure REST works for all five with Node `fetch` and `FormData`/`Blob`; no SDK is required. AssemblyAI and pyannote need a poll loop (or a webhook, which a desktop app cannot receive without a relay).
