# Reproducible ASR accuracy pilot

This directory calls no models and changes no default. Run every candidate on the
same manifest/audio hashes, preserve failed outputs, then score independently.
Existing `.diagnostics/asr-client-boundary/*/report.json` files establish execution
and timing. Their model-generated `result.text` is **not a reference**. The known
five-second Spanish example is a smoke test only. Do not turn agreement between
models on the 90-second meeting into ground truth.

## Corpus

Primary source: [Google FLEURS](https://huggingface.co/datasets/google/fleurs),
CC-BY-4.0, Spanish Latin America `es_419`, test split. Pinned revision:
`70bb2e84b976b7e960aa89f1c648e09c59f894dd`.

- `data/es_419/test.tsv`: 599,882 bytes; original transcription is column 3,
  published normalized transcription column 4, sample count column 6.
- `data/es_419/audio/test.tar.gz`: 582,112,372 bytes; download ceiling 600 MiB.
- The corresponding parquet is 703,040,007 bytes; it is unnecessary here.

`fetch_fleurs.py` fixes 30 distinct sentence IDs, 3–30 seconds each, using the
SHA256 ordering of `hidock-es419-v1:<sentenceId>` and the first lexical filename
for each ID. Selection is saved before audio download/inference. It hashes the
archive and each exact audio file, extracts only selected regular members without
using archive paths, and emits raw and published-normalized references.

```powershell
python apps/model-host/scripts/asr-accuracy/fetch_fleurs.py --out .diagnostics/asr-accuracy/fleurs-es419
```

This is read speech, not a meeting/noise/overlap benchmark. Dataset-test separation
does not establish absence from model training. FLEURS metadata here supplies no
speaker identity or time-aligned speaker annotation; gender is **not** speaker ID.
Do not calculate DER or speaker accuracy for this corpus. Human-reviewed meeting
references with explicit speaker turns are needed to choose a diarizer.

## Input contract

Reference JSON:
```json
{
  "purpose": "pilot",
  "provenance": {"referenceKind": "human", "source": "named independent annotation", "heldOut": true},
  "items": [{"id": "clip1", "audioSha256": "<64 hex characters>", "text": "Texto revisado", "durationSeconds": 5}]
}
```
Allowed reference kinds: `human`, `published-reference`, `public-dataset`.
Hypothesis JSON:
```json
{"model":"exact-model-and-revision", "items":[{"id":"clip1", "audioSha256":"<same hash>", "status":"completed", "text":"Texto reconocido"}]}
```
Missing/failed items count as empty hypotheses (all reference words deleted), and
block selection eligibility. Include failures with the same audio hash and
`status: "failed"`; never omit failures from the denominator. Unexpected/duplicate
IDs and audio hash mismatches fail. For speech-free references, rate is null when
the denominator is zero; insertion counts remain visible and enter corpus totals.

Optional `segments: [{speaker, text}]` in both inputs permits concatenated minimum
permutation WER (cpWER), in input chronological order. Unresolved speaker labels
are refused. Optional separate `timedSpeakers: [{speaker,start,end}]` plus explicit
`durationSeconds` permits DER. Timing must be independently annotated in the
reference; ASR-generated timestamps must never populate reference timing.

```powershell
python apps/model-host/scripts/asr-accuracy/score.py --reference reference.json --hypothesis model.json --out new-score.json
python -m unittest discover -s apps/model-host/scripts/asr-accuracy -p test_score.py -v
```

## Definitions and audit limits

- Strict: Unicode NFC and collapsed whitespace; preserve case, punctuation,
  accents and number spelling.
- Normalized: strict plus Unicode casefold and punctuation→space. Preserve
  accents, filler words and number spelling. No translation, stemming, synonym
  matching, accent stripping or model-dependent text cleaning.
- WER: `(substitutions + deletions + insertions) / reference words`.
- CER: the same edit distance over Unicode code points, **including canonical
  single spaces**. Both modes are reported; rates are fractions, may exceed 1.
- Corpus WER/CER: sum error counts / sum reference counts, not the average of clip
  percentages. Detailed S/D/I and denominators are retained per clip.
- cpWER: exact global one-to-one speaker permutation minimizing total word edits;
  dummy speakers charge missing/extra speaker text. At most eight speakers.
- DER: exact interval integration over `[0,duration]`, zero collar, overlap
  included, one global mapping maximizing shared speaking duration. Miss, false
  alarm and confusion seconds are divided by reference **speaker-seconds**.
  Therefore overlapping reference speakers contribute separately.
- WER/CER alignment has a 25-million-cell budget and linear-row memory. Split
  long recordings into predeclared reference utterances instead of raising caps.
- Output includes reference/hypothesis JSON hashes and never overwrites a report.

`selectionEligible` defaults false. It requires purpose `selection`, independent
provenance, held-out declaration, zero missing/failed outputs, and an explicit
predeclared `selectionPolicy: {minItems, minReferenceWords}` satisfied by the
sample. This is only a coverage check, **not automatic model selection**. The
shipped FLEURS manifest remains purpose `pilot`, no default recommendation. A
default decision additionally needs representative human-reviewed meeting audio,
all candidate runs, paired per-item comparison, uncertainty analysis, and an
explicit quality-versus-latency/resource policy established before selecting.
