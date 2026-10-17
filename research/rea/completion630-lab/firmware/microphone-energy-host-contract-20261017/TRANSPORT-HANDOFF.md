# F11A v2 transport handoff

`TRANSPORT.patch` is an unapplied, source-only proposal for `JensenDevice.getNativeVoiceEnergyObservation`. It adds no new transport or installer: it follows the existing `getNativeVadObservation` path in `packages/jensen-protocol/src/jensen-device.ts`, using that class's `runExclusive`, queued firmware dispatch, and connection-session identity fence.

The proposed method accepts the same bounded timeout and optional `AbortSignal`. One exclusive operation and one deadline cover the existing F111 custom-recording capability read followed by exactly one F11A command carrying the codec's one-byte `02` request. It checks the same device handle, serial, and connection-session ID before dispatch and after each reply. Abort, timeout, rejected capability response, transport error, changed session, or malformed F11A body returns `null`. It does not retry. A valid response is parsed by `parseNativeVoiceEnergyObservationReply`; the codec leaves voice, source, and freshness unknown, age null, and image attestation false.

## Firmware qualification is intentionally blocked

The patch contains `exactV2FirmwarePair = null` as a fail-closed integration marker. While null, the method sends no F111 or F11A request. The SDK owner must replace that marker only after receiving the exact combined image's paired firmware number and version string, with accepted-image receipt and boot/version QA evidence. Do not substitute a placeholder, neighboring build, version range, or command-number inference. In particular, diagnostic images 393998 and 393999 are not admitted: the retained evidence does not establish this v2 provider in those builds.

Until that exact pair is available, keep the method patch unapplied. When it is available, also apply/reconcile `SDK-EXPORT.patch` if the codec should be public from the package barrel, then run the SDK owner's focused method tests and typecheck. This handoff includes no claim that the transport is enabled, no USB observation, and no runtime or hardware validation.

## Patch integrity

The first hand-authored diff had incorrect hunk counts and did not pass `git apply --check`. I replaced it with a unified diff generated from a temporary source copy and corrected destination paths. The final `git apply --check research/rea/completion630-lab/firmware/microphone-energy-host-contract-20261017/TRANSPORT.patch` passed (exit 0) on 2026-10-17. The patch was not applied; `jensen-device.ts` was not edited.
