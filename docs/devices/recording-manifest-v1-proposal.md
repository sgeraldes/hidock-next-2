# Recording manifest v1 — client/firmware coordination proposal

Status: **logical direction agreed by the firmware owner, with the amendments and
unimplemented boundaries below**. Client validation must incorporate the legacy-marker
and measured-clock rules before association. No metadata
opcode, transport, sidecar filename or firmware capability is allocated by this document.
Current custom6.3.2 and prospective custom6.3.4 do not implement this manifest. RSTR2 is a separate restore
protocol; its expected source SHA is not a device-computed capture digest.

## Client validation checkpoint

`apps/electron/src/shared/recording-manifest.ts` incorporates the firmware-owner
legacy-marker and independently measured-clock amendments. The previous checkpoint
passed 147 tests across the parser, Unicode, adversarial and isolated SQLite association
suites, plus main/web typechecks. Independent review subsequently identified missing
checks for non-finite measured durations and capture-frame counts inconsistent with
measured audio. Those corrections and the numeric representability guard now pass
172 tests across the four parser suites. The coordinator reran the combined parser,
association and recorded-audio-state checks: six suites and 221 tests passed,
including isolated SQLite export/reopen, presentation updates, rollback and connection
quarantine. Frontend typecheck passed. The firmware owner corrected the concurrent
restore diagnostics; the coordinator subsequently reran main typecheck successfully.
The backend association service requires owner-provided capability and origin
attestation callbacks before persisting source roles. Neither module is registered
with download hooks, IPC or native capabilities, and neither has been deployed.
These tests do not establish native availability or firmware origin.
The strengthened v1 binding requires caller-supplied evidence bound to the original
SHA, an evidence ID of at most 128 UTF-8 bytes, exact frame/rate/delay/padding
agreement, and PCM frame measurement with zero encoder delay/padding. The current
client measures decoded tracks at 16 kHz; a non-null clock is therefore accepted
only for directly comparable 16 kHz PCM with durationSource=decoded-frames and a
frame count consistent with that measured duration. All measured durations must be
positive and finite, including when clock is null. Numeric comparisons reject when
floating-point slack reaches half a sample period; the earlier millisecond tolerance
is not accepted.
MPEG clocks remain structurally representable, but v1 association rejects a non-null
MPEG clock because the evidence cannot express the independently measured relation
between encoded/decoded samples, encoder trimming and the capture clock. Use null
until that relationship has a supported representation; no calibration is inferred.
Structural parsing allows capture and encoded rates to differ. Association rejects
that case in v1 because this schema cannot express an independently measured relation
between the two clocks; use a null clock until that relation is representable.
Consumers must resolve source roles by channelIndex rather than JSON array order.
An unidentified legacy marker may retain a known type only when independent evidence
establishes that type; the historical native footer supplies no such classification.

The original association service rejects a changed raw manifest payload for an
existing local recording and original digest, including harmless JSON whitespace or
filename changes. The firmware owner agreed to a separate presentation-metadata
update operation: a fresh owner attestation must bind the exact new JSON, and every
semantic field except file.name must remain unchanged. Whitespace and key-order
changes may be idempotent only after that fresh attestation. Source maps are compared
by channelIndex. Roles, markers, clock and identity changes require a different,
explicit operation and remain rejected here.
This seam is implemented as updatePresentationMetadata and tested in isolated SQLite;
runtime integration remains unavailable. Recording identity, content generation and original file digest survive
a presentation rename. The immutable backup/restore receipt original_filename must
not change, because restore depends on that original name.
The service saves each newly attested raw JSON payload and its digest in revision
history. Legacy rows without that raw evidence explicitly retain null. A failed
rollback or cleanup release quarantines the connection across service instances;
further reads and writes require a newly opened connection rather than exposing or
committing unresolved partial state.

## Logical fields

The proposed transport returns an external manifest bound to the exact original file.
Keeping it outside the hashed recording avoids a self-referential embedded digest.
If the firmware owner chooses an embedded representation, its hash coverage and a
separate full-artifact hash must be specified before acceptance.

```json
{
  "schemaVersion": 1,
  "recordingId": "opaque-device-recording-id",
  "contentGeneration": "opaque-content-generation",
  "state": "finalized",
  "file": {
    "name": "2026Oct09-130550-Rec76.wav",
    "byteLength": 960044,
    "sha256": "<64 lowercase hexadecimal characters>"
  },
  "audio": {
    "container": "wav",
    "codec": "pcm_s16le",
    "sampleRateHz": 16000,
    "channels": 2,
    "bitsPerSample": 16,
    "clock": {
      "sampleRateHz": 16000,
      "frameCount": 240000,
      "encoderDelayFrames": 0,
      "encoderPaddingFrames": 0
    },
    "sourceMap": [
      { "channelIndex": 0, "role": "unknown" },
      { "channelIndex": 1, "role": "unknown" }
    ]
  },
  "markers": []
}
```

The example IDs/numbers are illustrative, not physical evidence. Required and bounded
fields: schemaVersion exactly1; recordingId/contentGeneration nonempty opaque UTF-8
strings up to128bytes each; state `open` or `finalized`; file name up to255UTF-8bytes
without path separators/control characters; byteLength safe integer (positive when
finalized, zero permitted while open); sha256
required for finalized files, absent for open files. Transport/firmware-specific name
and size limits can be stricter and must be advertised separately.

Audio container `wav`, `mp3` or explicitly `riff-mpeg` for legacy RIFF-wrapped MPEG;
codec `pcm_s16le` for current WAV, `mp3` for MPEG audio.
channels1or2; sampleRateHz positive integer <=192000. WAV requires bitsPerSample16 and
must omit bitrateKbps. MP3 requires total bitrateKbps64/96/128/160 and must omit
bitsPerSample. No guessed fields from today's global settings.

`clock` is required and must explicitly be null when unmeasured. Otherwise it carries
the **capture clock before encoder delay/padding**, positive integer sampleRateHz,
positive safe-integer frameCount, and nonnegative integer encoderDelayFrames and
encoderPaddingFrames, all in that same rate. Zero is a measured zero, not unknown.
The exact relationship to decoder output must be calibrated per codec; do not silently
rescale marker offsets or pretend all MP3 timestamps are calibrated.

sourceMap contains exactly one entry for each actual channel, indexed0..channels-1,
roles `unknown`, `microphone` or `system`. A known role asserts preserved physical
source wiring for this particular capture. Firmware must use unknown when it cannot
establish this, including unsupported routes/modes; source role never asserts person ID.

## Markers

At most1000entries. Each has `markerId` (opaque UTF-8<=128bytes or explicitly null
for unidentifiable legacy markers), `type` (`manual`, `automatic` or `unknown`),
optional `label` (UTF-8<=256bytes), and exactly one position:

- `position: {unit: "capture-frame", value: <nonnegative safe integer>}` requires
  measured clock, an actual persisted marker ID and value <=frameCount; or
- `position: {unit: "legacy-ms", value: <nonnegative safe integer>}` is retained as
  legacy milliseconds, with explicit uncalibrated precision. It does not create a
  sample-exact marker. A historical `HiDockVM` entry has `markerId:null` and
  `type:"unknown"` because the footer supplies neither. Firmware must not fabricate
  IDs or manual/automatic classifications for those entries.

Duplicate non-null IDs or positions outside measured duration are rejected. Null
legacy IDs are not treated as one shared identity. Marker IDs are
scoped by recordingId and contentGeneration. A null clock keeps legacy markers usable
without inventing exact alignment.

## Validation, binding and downgrade rules

1. Maximum manifest payload64KiB, supported schema, strict field/type/enum/size checks.
   A malformed or unsupported manifest is a metadata failure, not proof of corrupt audio.
2. Before adopting metadata, compare byteLength and finalized sha256 against the full
   downloaded original artifact, and compare format/rate/channel count against decoder
   measurements. Any mismatch rejects the association and retains unknown source roles.
   Do not relabel an existing transcript or submit another ASR job automatically.
3. Only the authorized device/firmware path may attest manifest origin. A user-uploaded
   JSON file passing structural validation is **not** verified-recorded-metadata.
   Exact source hash and evidence identity must accompany persistence.
4. Missing capability/manifest permits complete bounded download, measured format and
   separate transcription with unknown roles. It must not synthesize device ID/generation
   from local UUID, filename, size, MD5prefix or expected restore SHA.
5. Safe resume requires the same advertised immutable recordingId/contentGeneration,
   finalized byteLength and full-file SHA. If these change, retain/quarantine the partial
   and require a fresh explicit download. Do not silently append/retry.
6. Legacy prefix/overlap resume keeps its existing weaker verification classification;
   it cannot be advertised as immutable-generation resume. Final full-artifact SHA is
   only a device-content comparison when the device supplies its computed digest.
7. Open recording: no transcription/publication as a finalized artifact and no verified
   resume promise. Observe finalization through the existing sole USB owner.
8. A non-null capture clock must be matched to independent measured frame/rate and
   encoder calibration evidence. Structural validation and a matching audio SHA alone
   do not validate arbitrary frameCount/delay/padding. When the client lacks that
   evidence, reject association of claimed clock fields; do not silently convert them
   into a sample-exact clock or rescale legacy millisecond markers.

## Firmware-owner decisions requested

Confirm identity/generation lifecycle across rename, append, overwrite, reboot and
restoration; digest availability/computation cost; transport representation and payload
limits; capture-clock vs encoder calibration; known-source guarantees per recording
mode. Specify supported/unsupported capabilities honestly. This proposal does not
authorize flashing, a second USB owner, or processing personal recordings11/12October.

## Firmware-owner decisions, 12 October 2026

The external representation, full-original-byte SHA coverage, explicit unknown roles
and clock, absent-capability behavior and strict generation-change refusal are agreed.
These decisions define future behavior; they are not implemented native guarantees.

- IDs are opaque and case-sensitive; comparisons preserve their exact UTF-8 bytes.
  Successful finalized metadata must survive reboot. A missing, corrupt or unbound
  identity record means identity unavailable, never reconstruction from filename,
  size or MD5prefix.
- A content-preserving rename keeps recordingId, contentGeneration and digest, while
  updating the name through an explicit current manifest. Content/footer modification
  invalidates the finalized digest and produces a new generation; open content is not
  an immutable snapshot. Reusing a filename for a distinct recording creates a new ID.
- Restore without an independently bound original manifest creates a new destination
  recording identity/generation. RSTR2 expected SHA does not restore native metadata
  identity or attest a computed native digest. Original manifest import would require
  its own explicit ownership and full-byte verification contract.
- SHA256 covers every original file byte, including header, encoded payload, marker
  footer and padding. A sidecar is outside that coverage. Native computation must be
  cooperative and bounded, with stable finalization/identity checked before and after;
  actual cost, storage lifetime and recovery require qualification before advertising.
- The logical payload bound is 64 KiB, not a promise of one native Jensen frame. The
  existing physical receive slot is 8192 bytes. Future transport must segment into
  bounded correlated reads and declare exact total/offset/completion, without silent
  marker/label truncation. Opcode, sidecar namespace, cursor lifetime and concrete
  native resource limits remain unallocated pending implementation and measurement.
- H1E names remain flat ASCII and at most27bytes. RSTR2 restore is limited to2GiB-1;
  the present byte-range signed end and57-byte entry-page arithmetic have separate
  limits. Generic255-byte logical names do not expand those advertised device limits.
- Source roles default to unknown. No supported mode may claim microphone/system
  routing until its capture path and physical isolation are verified for that mode.
  Current global settings and one controlled tone experiment do not attest historical
  per-file routing. Firmware labels never assign speaker/person identity.

Native manifest capability, durable lifecycle hooks, computed digest, per-mode routing
and encoder-clock calibration remain implementation/acceptance work after RSTR2
hardware qualification. Client pure validation can proceed against this contract now;
it does not establish origin, native availability or changed-generation safe resume.
