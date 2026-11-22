# Spanish ASR pilot: error and comparability audit

Audit date: 2026-10-11. No model requests, reference edits, or scoring-policy changes were made for this audit.

## Finding

**The observed Cohere 12.90% versus Gemini 2.11% WER gap is not a clean model-accuracy comparison.**
Cohere's delivered transcript contains actual Unicode replacement characters (`U+FFFD`) in accented words.
These are present in its raw client `report.json` and durable `results.json`, before hypothesis extraction.
They are not merely a terminal-display problem. The end-to-end output is defective, but attributing all these
errors to acoustic recognition would misdiagnose the system.

The existing scorer reproduces these values without modification:

| Result | Cohere delivered output | Gemini delivered output |
|---|---:|---:|
| Successful clips | 30/30 | 30/30 |
| Reference words | 853 | 853 |
| Normalized WER | 12.8957% | 2.1102% |
| Word errors: substitutions / deletions / insertions | 105 / 1 / 4 | 15 / 2 / 1 |
| Normalized CER | 2.5810% | 0.4802% |
| Strict WER | 19.5780% | 4.4549% |
| Literal replacement characters in scored text | 80 | 0 |
| Word-edit operations involving a replacement-character hypothesis token | 80 | 0 |

The alignment uses the scorer's existing substitution/deletion/insertion tie order. Eighty of Cohere's 110
word errors involve damaged tokens; the remaining 30 include recognition, typography, tokenization, and
reference-orthography differences. **Do not subtract 80 and publish a repaired model WER**: recovering the
original characters from reference text would contaminate the hypothesis. A clean transport rerun is required.

## Fairness checks

- Both files contain exactly the same 30 FLEURS Spanish `es_419` reference IDs.
- Every hypothesis audio SHA256 equals both the reference hash and the independently hashed WAV file on disk.
- Scored text is the ordered concatenation of segment `text`, for both engines. No `SPEAKER_00:` labels leak
  into either hypothesis. Cohere's earlier label-containing aggregate field is retained as raw evidence but
  excluded from corrected scoring; Gemini's segment labels are excluded in the same way.
- The same `apps/model-host/scripts/asr-accuracy/score.py` computes both scores. Normalization applies NFC,
  case-folding, punctuation-to-space, and whitespace collapse. It does **not** erase accents, normalize number
  words, merge abbreviations, correct spelling, or repair replacement characters.
- The reference contains 400.68 seconds of public, held-out-split read speech. Training contamination is unknown.
  This pilot is not representative proof for meetings, overlap, voice identity, or default-provider selection.

## Concrete examples

| Clip ID | Reference excerpt | Cohere delivered excerpt | Gemini delivered excerpt | Interpretation |
|---|---|---|---|---|
| `1058162800014960731` | `acción ... deberá` | `acci�n ... deber�` | `acción ... deberá` | Two transport/encoding-affected word mismatches, not evidence of wrong words being recognized. |
| `10312331453126623791` | `verá ... función ... cuán ácida ... básica ... química` | `ver� ... funci�n ... cu�n �cida ... b�sica ... qu�mica` | Accents preserved | Six damaged words in one otherwise matching sentence. |
| `15790754130957131324` | `mejores vistas ... Kowloon ... en frente` | `mejores visitas ... Khon Long ... enfrente` | `mejores visitas ... Kowloon ... enfrente` | Both substitute visitas for vistas; Cohere additionally changes the place name. en frente/enfrente is tokenization, not dropped speech. |
| `10975282397110463233` | `Huhne ... MP ... Davey` | `Une ... M.P. ... David` | Names and MP match | Real proper-name differences coexist with abbreviation formatting. Each M.P. becomes two tokens under the unchanged punctuation policy. |
| `11603681517704231177` | `baja sea ... dicha` | `vas hacia ... dichas` | `baja sea ... dichas` | Cohere changes two lexical words; both differ on the final singular/plural. |
| `11800689084483685270` | `waterpolo ... jóquey ... carreras d Fórmula 1` | `waterpolo ... jockey/hockey ... carreras de F�rmula uno` | `cuaterpolo ... jockey/hockey ... carreras de Fórmula 1` | Gemini has a genuine waterpolo mismatch. Cohere's 1/uno is numeric formatting (one edit); both are penalized for reference spelling/token differences. |
| `11055750169191416348` | `ASUS Eee PC` | `A sus eee pc` | `ASUS EeePC` | Cohere splits the brand; Gemini joins the product tokens. These are not recording dropouts. |
| `4458380589709632418` | `influeye` | `influye` | `influye` | Both differ from the published reference's apparent typo. Reference remains untouched. |

Numeric formatting does not explain the large gap: the clear digit-to-word mismatch is `1` versus `uno`.
Whole-clip failures are absent; aggregate deletions are only one for Cohere and two for Gemini. There is no
evidence in these records of substantial missing passages. Many disagreements are substitutions, with
encoding damage dominating Cohere's delivered result. Text-only examples cannot determine whether the speaker
actually pronounced a nonstandard form; that would require independent listening, not reference-driven repair.

## Earliest observed damage and implementation risk

For clip `1058162800014960731`, both `report.json` and `results.json` already contain `acci\uFFFDn` and
`deber\uFFFD`. The source's `asr_worker.py` emits JSON with `ensure_ascii=False` (line 198 at audit time).
The shared Node launcher in `diarize.mjs` sets stdout decoding to UTF-8 (line 132), while its explicit environment
does not set `PYTHONIOENCODING` or `PYTHONUTF8` (lines 98–106). A Windows Python legacy stdout encoding therefore
has an incompatible consumer. Other new ASR workers use `ensure_ascii=True`.

This is a concrete risky boundary and a strong explanation for the systematic accent damage. It is **not yet
proof of the running host's actual Python encoding**. Verify with a tiny non-model subprocess fixture through
the same launcher, then force a consistent JSON encoding. Do not repair old results from the references.
The pipeline should reject replacement-character output rather than silently recording it as successful.

## Evidence paths and hashes

- Reference: `.diagnostics/asr-accuracy/fleurs-es419/reference.json`
- Cohere: `.diagnostics/asr-client-boundary/accuracy-8025ac2f67be/CohereLabs--cohere-transcribe-03-2026/rescored-hypothesis.json`
  - SHA256: `cbb20c74dea3306611e39dc9bae9a00152111d6a69774abb6d50b4ff51d871b2`
- Gemini: `.diagnostics/asr-gemini-boundary/fleurs-es419/hypothesis.json`
  - SHA256: `490869b2b12751d9394a50c52bea313642f43f90c1fcaddbea19a72f768bc388`
- Each Cohere row links its original report and report hash; each Gemini row records actual request usage,
  configured model, source hash, and elapsed time.

## Additional completed model: Parakeet

Parakeet `nvidia/parakeet-tdt-0.6b-v3` subsequently completed all 30 clips with no failures and no replacement
characters. Same IDs/audio hashes and ordered-segment-text extraction were checked. Its normalized WER is
**2.6964% (23/853: 20 substitutions, 3 deletions, 0 insertions)**. This is five more word errors than Gemini on
this pilot, a much smaller difference than the corrupted Cohere result suggests; it is not a statistically
established overall ranking.

A paired utterance bootstrap (10,000 resamples, seed 20261011, corpus-weighted WER, percentile interval) gives
Parakeet-minus-Gemini **+0.586 percentage points**, with a **95% interval of −0.505 to +1.935 points**. The interval
includes zero: this pilot does not distinguish a reliable winner. Gemini has fewer word errors on five clips,
Parakeet on three, and 22 tie. Utterance resampling does not model possible dependence between recordings of
the same speaker. Reproduction: `.diagnostics/asr-gemini-boundary/bootstrap.py`; results and immutable-input
hashes: `.diagnostics/asr-gemini-boundary/fleurs-es419/paired-bootstrap.json`. No scoring normalization changed.

Examples: clip `10975282397110463233` has `Huhne` → `Une`, `Ed Davey` → `David`, and later `Davey` → `David`.
Clip `11800689084483685270` includes `waterpolo` → `cuaterpolo`, hockey spelling, the reference's `d` versus `de`,
and `1` → `Uno`. This mixes lexical and formatting/reference differences just as the Gemini examples do.

Evidence: `.diagnostics/asr-client-boundary/accuracy-8025ac2f67be/nvidia--parakeet-tdt-0.6b-v3/rescored-hypothesis.json`,
SHA256 `b19897e4f58f7165bbffaa95a074b57a9744a8d013dffc01ae4a8a4ba84f1202`.

Qwen 0.6B had only nine collected clips at this snapshot. Its scorer counts the other 21 as missing; that
partial score must not be presented as its model accuracy. Append other complete, encoding-checked results
using the same frozen reference and scorer; do not compare partial runs as if they cover all 30 clips.
