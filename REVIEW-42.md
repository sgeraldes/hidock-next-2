# Adversarial review — PR #42

## Findings

- **MUST-FIX — `apps/electron/electron/main/services/transcription.ts:550`**: The local-voice guard is checked only when the short lane starts. If both lanes are in VAD/provider setup, the short lane may start; it later enters `voices`, while the main lane independently enters `voices` at line 2267. The short lane has no stage callback, lock, or semaphore, so two pyannote workers can run together and consume the CPU budget twice. Serialize the local voice stage across lanes, rather than testing one lane’s stage once.

- **MUST-FIX — `apps/electron/resources/speaker-linking/worker.py:168`**: The 50 ms “budget” is measured only after synchronous `InferenceSession.run` returns. A DML call can therefore run without any bound, and lines 171–172 exempt the first two calls from fallback entirely. This does not enforce the workstation rule that one display-GPU call stay under about 50 ms. Use CPU until a separately bounded/probed DML path proves safe, or isolate each call behind a mechanism that can enforce a deadline before enabling DML.

- **MUST-FIX — `apps/electron/electron/main/services/speaker-linking.ts:459`**: Export readiness is “both filenames exist.” The exporter writes final paths directly before all equivalence checks finish, and timeout/failure does not remove or quarantine partial output. A killed or failed export can therefore be accepted permanently on the next call. Export into a staging directory, validate there, then atomically publish a versioned manifest plus both models.

- **SHOULD-FIX — `apps/electron/electron/main/services/speaker-linking.ts:503`**: Any detected GPU selects DML, including `other`, and DML session/provider failures become a generic worker error that fails the transcription. CPU fallback exists only after a successful DML session and a slow call. Limit selection to supported vendors and retry the ONNX worker on CPU when DML setup or inference fails.

## Checks

- Same-row lane race: **OK**; `updateQueueItem(..., 'processing')` is synchronous before `runQueueItem` first awaits.
- Pause and feature-off: **OK** by documented policy; in-flight jobs finish, subsequent dequeue stops.
- Startup repairs: **OK**; both active IDs enter `transcription-activity`, and both database and integrity resets exclude them.
- Cancel: **OK under the existing contract**; pending work is cancelled, in-flight work finishes. Lane markers clear in `finally`.
- ONNX call batching: **OK for batch width**; DML receives one batch row per call. The wall-clock bound is not enforceable, as above.
- Changed-file ESLint: pending.
- Dependencies and manifests: pending.
- Architecture and documentation: pending.
- Postman collection: none exists in this repository.
