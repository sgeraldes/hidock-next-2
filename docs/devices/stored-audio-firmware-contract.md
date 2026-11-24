# Stored audio and custom firmware integration

The client preserves independent channels by default. Channel 0 and channel 1 are
source tracks, not person identities. It decodes them sequentially to bounded PCM16
16 kHz tracks, retains the original recording clock and overlap, and checkpoints each
transcription separately. An explicit mixed-channel setting remains available.

## Per-recording metadata required from firmware

These are integration requirements, not claims that firmware already implements them.
No new Jensen command numbers are assigned here.

- Stable recording ID, immutable content generation/version, final byte size and
  finalized/open state. Resume must reject a different generation rather than append
  bytes from different recordings. A whole-file digest plus offset-range integrity
  makes verification independent of filename or listing order.
- Actual container and codec, sample rate, channel count, and decoded sample/frame
  count when available. MP3 bitrate is **total kbps**, with 64/96/128/160 supported;
  WAV PCM uses bits per sample, rate and channel count instead of MP3 bitrate.
- **Per-file** channel source map: microphone/system/unknown, channel indexes and
  mapping schema version. Current global device settings cannot establish the source
  map of a historical recording. Preserve source isolation before encoding; joint
  stereo metadata alone does not establish microphone/conference separation.
- Marker ID, recording ID/version, timestamp on the original sample clock, marker
  type and optional bounded UTF-8 label. Define whether timestamps are frames or
  milliseconds, and how encoder delay is represented. Avoid wall-clock timestamps
  as the sole audio position.

Until source mapping is verified or confirmed for that recording, the UI uses
**Channel 1 / Channel 2**, without inventing microphone/system roles or identities.

## Listing, resume and uploads

List entries should carry the same stable ID/version, size and finalization fields.
Specify pagination cursor lifetime, end-of-list and delete/rename behavior explicitly.
Resume reads require an exact offset and acknowledged returned range; final integrity
verification happens before promoting a partial file to the library.

Uploads should declare supported formats, limits, target identity and expected digest;
write to a temporary generation and commit atomically. Specify interruption cleanup
and conflict handling. The separate device/firmware qualification work owns these
transport commands; this audio integration must not introduce a competing USB owner.

## Acceptance scenarios

Mono and stereo WAV/MP3; every listed MP3 bitrate; opposite-phase stereo; overlapping
speech; a quiet source; unknown or reversed source mapping; cancellation; channel-2
failure with channel-1 checkpoint retained; repeat execution without duplicate paid
work; edits preserving source provenance; interrupted download with unchanged and
changed file generations. Hardware listing/resume/upload require the single existing
device owner and cannot be established by synthetic decoder tests.

## Current firmware evidence and remaining gaps

The dock runs custom6.3.2/393986, SHA256
`6940d83d790992d39d41791609b264d8b76041384b367076d7fbab1744c018f7`.
Keep custom installed; returning to stock is reserved for an actual recovery need.
All physical results below use newly owned controlled fixtures without ASR/provider
requests. Existing11/12October personal recordings remain excluded from processing.

| Requirement | Current implementation and observed boundary | Remaining gap |
| --- | --- | --- |
| Codec/rate/channels/quality | Downloaded physical WAV is paired PCM16,16kHz. Four MP3 captures decode as stereo16kHz,total64/96/128/160kb/s. [Evidence](../../research/rea/completion630-lab/runtime/upload2-native-mp3-profiles.json). | Listing does not transmit those codec fields. Measure each file; current global settings cannot describe historical files. |
| Sample clock/individual tracks | Physical WAV:284472paired frames/17.7795s; actual app exports both mono lanes with every sample equal to the original. [Evidence](../../research/rea/completion630-lab/runtime/upload2-physical-wav-track-export.json). | MP3 encoder delay/padding and native marker/sample-clock alignment are not fully calibrated. |
| Per-file source map | No firmware/file manifest carries physical source roles. Controlled HiDock1kHz playback strongly reaches B; A differs independently. [Evidence](../../research/rea/completion630-lab/audio-calibration-study/REPORT-CORRECTED-PHYSICAL-AUTO.md). | This does not establish all modes or a historical file's map. Persist unknown roles unless evidence is bound to the exact original SHA; do not invent firmware-manifest provenance. |
| Stable ID/content generation | Local recording UUID and whole-file SHA identify the published local artifact. | Native filename+size+MD5prefix are change indicators, not immutable device generations. No native stable recording UUID/generation is transmitted. |
| Finalized/open state | Host excludes the freshly reported active filename from a complete catalog; native CMD18/CMD29 report current recording state. | No per-entry immutable finalization generation; state/listing races and same-size mutation outside checked regions need qualification. |
| Native markers | Trailer `HiDockVM`,LE32count,LE32millisecond offsets. Native/programmatic/default-off automatic marking physically observed; app imports11111/17433ms. [Evidence](../../research/rea/completion630-lab/runtime/upload2-native-wav-automatic-marker-capture.json). | No native markerUUID,type,label,recording-generation or original-frame position. Host IDs/UTF-8 labels are local sidecar metadata. |
| Listing/pages/ranges | CMD4/CMD26 catalogs and CMD21 byte ranges, strict correlation/completion and bounded1MiB host requests. [Protocol](protocol.md). | Byte offsets differ from entry-index pagination. No immutable snapshot cursor; earlier cold count mismatch remains open. |
| Resume/integrity | Durable1MiB checkpoints,local prefix/overlap SHA,exact range counts and atomic local publication. Stock same-process/cross-process resume equals a whole-file baseline. [Evidence](../../research/rea/completion630-lab/runtime/stock-resume-publication.json). | Device signature is MD5 of at most1024actual bytes. Same-size/same-prefix changes outside overlap cannot be ruled out by that signature. Native whole-file digest/generation remains missing. |
| Current write-back | Installed f118/61720 writes owned `REAxxxxxxxx.hda` fixtures up to8MiB. Actual2092/556-byte CRC/commit/list/fullSHA checks pass; encrypted ownership survives reconnect and app restart. [Evidence](../../research/rea/completion630-lab/runtime/upload2-owned-scratch-sealed.json). | Original-name/full-backup restoration is not furnished by f118. |
| Next restore extension | f119/61721 RSTR2 implemented but uninstalled, future393988/6.3.4:flat ASCII.hda/.wav names≤27bytes,size≤2GiB−1,BEintegers,token16bytes,sourceSHA32bytes,APPEND≤1024bytes,dual512-byte journals,bounded4096-byte verify steps. [Exact evolving contract](../../research/rea/completion630-lab/firmware/restore-build393988/restore-contract.json). | Stored SHA is expected provenance, not device-computed SHA. Physical FAT/close/rename/power-loss behavior remains unqualified. State5FINISHED differs from f118state4. |

Minimum missing firmware metadata: a versioned per-recording manifest with stable
ID/content generation, explicit finalized state, actual format/clock fields, source
roles defaulting to unknown, marker provenance, and final file digest binding. A
sidecar or container chunk must be checked against native listing filters and legacy
decoders before acceptance. This document assigns no new metadata opcode or
unimplemented capability.

`RecordedAudioState.saveLayout` and `saveTracks` can persist independently measured
format/track data under the original SHA. `setMapping` requires verified per-file
evidence or confirmation for that recording; the current firmware does not furnish
such a mapping automatically. Physical new-firmware→remote ASR integration and
changed-generation resume remain acceptance work, distinct from decoding/export.
