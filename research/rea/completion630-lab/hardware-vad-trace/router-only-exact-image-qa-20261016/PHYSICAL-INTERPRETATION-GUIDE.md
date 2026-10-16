# Physical interpretation guide for the combined VAD candidate

This guide is for a bounded read-only observation after the separately authorized candidate operation. It does not authorize a flash, reset, recording, settings change, or extra USB action.

## What schedules the poll

The poll is driven by the firmware's `sugr_app` loop, not by the Jensen query. The state-machine selector-5 path checks its scheduler table and queues `01020b58` with delay `50` provider-clock units and flags `0`; the scheduler dispatches it once, and a later loop can queue it again while native state remains `5`. The callback calls the `RefChannelVAD` getter. Do not report a measured 50 ms cadence: the time scale is only adjacent evidence, and dispatch timing is unqualified.

One observed writer of native state `5` is `01020f74`: it calls `0101faf4(object+0x0c, 0x32)`, writes state `5` on return zero and state `2` on nonzero. The retained evidence does not establish an executed caller or a safe host command that reaches this writer. The selector-switch addendum specifically shows state `4` does not take the selector-5 VAD-registration path. State `5` is not proof that DSP loading completed or that a VAD provider is ready. Do not send an unknown command or change operating mode to force it. If normal device lifecycle does not reach state `5`, record “poll not triggered” and stop.

The F11A request path is a separate `usbiap2` command task; it snapshots the telemetry tail and does not run the `sugr_app` poll callback. In this candidate, the exact diagnostic request is command `0xf11a` with a one-byte body `01`, expecting exactly 32 response bytes. The current host integration exposes `JensenDevice.getNativeVadObservation()` through trusted IPC/preload, gated to the exact H1E 393992/6.3.8 pair and preceded by F111 capabilities. Use that existing sole-owner app API. F117 `help`, `version`, `uptime`, and `vectors` remain read-only checks, but they do not trigger or expose this poll.

## Bounded, state-preserving observation

Before querying, note device identity/version, recording state, profile, format, rules, and file-count/catalog readbacks. Keep the device idle. Send no setters, reset/restore, record start/stop, upload, or mode-change commands. Take one F11A snapshot, allow an ordinary bounded observation interval, then take at most one more. Compare before/after readbacks and stop if any setting, recording state, or catalog value changes unexpectedly. Polling can update firmware-local telemetry/cache fields; “read-only” here means no intended host setting or DSP-configuration write, not a guarantee that all native provider side effects are absent.

If the current raw-command path is unavailable, the response is not exactly 32 bytes, the version/status is malformed, or a snapshot returns BUSY/UNAVAILABLE, preserve the receipt and stop rather than retrying. If state is not `5`, or the attempt counter does not advance between snapshots, report that the poll was not observed; do not increase command rate or claim the hook failed. Do not rerun or reflash to recover from an inconclusive observation.

## Reading the result

- Reply `status` `0` means a snapshot was returned; `1` is BUSY and `2` is UNAVAILABLE. This is distinct from `lastAttemptStatus`, which is the native getter result.
- `nativeState` is the firmware state byte at `object+0`. Seeing `5` shows the state-machine selector condition, not DSP readiness or lifetime safety.
- `attemptedReads` and `successfulReads` are wrapping 32-bit counters; they are poll/telemetry counts, not utterances, time, or callback cadence. A changed attempt counter between snapshots shows that a recorded poll attempt occurred. Successful reads increment only when the getter returns zero and the object can be published.
- `lastAttemptStatus` is the latest recorded getter status. A nonzero status is a failed read. `lastGoodRawWord` is retained from the latest status-zero read, so it may be stale after a failure. `HAS_SAMPLE` distinguishes a valid raw zero from no successful sample.
- Preserve the raw word as opaque 32-bit data. The provider's implementation, output width, polarity, route, range, and freshness remain unresolved. A nonzero word does **not** mean voice is present; zero does not mean silence. Age/time flags and age words are intentionally unavailable/zero on this unclocked path.

Stop the observation on any unexpected setting/catalog change, device identity mismatch, command timeout/malformed reply, BUSY/UNAVAILABLE, getter failure, or absence of state-5/counter progress after the bounded pair. Do not infer acoustic VAD, DSP behavior, rate, channel, or installation qualification from this command.

## Evidence used

- `../lifecycle-followup/REPORT.md` — state-5 writer and scheduler loop; `../scheduler-switch-followup/ADDENDUM.md` — corrected selector mapping and selector-5 queue proof (state 4 is not the VAD-registration path).
- `../lifecycle-followup/early-reader-order/REPORT.md` — startup/task ordering only; its selector-4 interpretation is superseded by the selector-switch addendum.
- `../reader-provider-followup/REPORT.md` — getter argument and unresolved runtime provider.
- `../fresh-sample-candidate/CONTRACT.md` and `../command-binding/REPORT.md` — reply fields and their limits.
- `../sdk-codec/REPORT.md` — original codec review; its missing-host-wiring statement is superseded by the current SDK/IPC integration.
- `out-NOTINSTALL/run-combined-revision3-20261016T2024Z-hook-through/receipt.json` — six passing exact-image instruction fixtures. These use fixture RAM and a modeled getter; they are not physical VAD evidence.
