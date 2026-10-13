# Tentative f11a VAD telemetry command binding

## Result and evidence boundary

This is a source-level integration map for a possible read-only VAD snapshot command. No handler was added, no image generated or tested, and no command sent to hardware. The frozen target metadata identifies 393988 / `6.3.4_restore001`, container SHA-256 `4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8`, and decoded system SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f` (`map/COMMAND-MAP393988.md:5`). The frozen source `generation-restore4/console630.c` hashes to `5dbfc45ea0f48e0899809a772b26a376f562213e52da6440398c02ecbf945e90`, matching its patch manifest.

The physical runtime receipt `completion630-lab/runtime/current393988-flash.json` says the custom container booted, but `imageBytesAttestedByDevice` is false. The map is source-derived and explicitly not an exhaustive enumeration of all 16-bit IDs or a physical 53-command test. Treat `f11a` as a tentative candidate, not as proved globally free.

## Namespace and SDK

The recognized source-derived custom IDs are `f110`, `f111`, `f113`–`f119`; `f112` is explicitly unassigned. `f11a` has no row in the 393988 supplement and no implementation in the existing `packages/jensen-protocol/src` custom-command modules. This supports no collision in the retained custom map, but cannot prove the entire 16-bit command space free. Existing `f110/f113/f115` setters write owned NV records; their paired getters read them. `f117` is a read-only firmware-console bridge; `f118/f119` are developer-only parked file extensions. The existing SDK `f117` parser accepts only its documented text responses, so a future VAD SDK parser must be a distinct API and require exactly 32 response bytes.

## Native module hook and bounds

The frozen module source is `firmware/restore-build393988/generation-restore4/console630.c`, with parser/response hooks at `0103a996` and `0103907a` respectively (`patch-manifest.json`). The parser hook is after stock header, magic, declared-length, and OTA checks. Its module contract is `int parse(frame, body, length)`; the response contract is `int response(frame)`. The parser receives the active body length and pointer in the original dispatcher registers. It currently routes `f119` and `f118` to their handlers, handles `f117`, and sends other IDs to native parser `01128698` (`console630.c:13-25`). The response hook has the current command, output buffer, response header, and body capacity, and sends unhandled IDs to native response `01128798` (`console630.c:30-41`).

The response capacity at frame `+0x20` counts available **body bytes**, excluding the 12-byte Jensen header. The output pointer is the header base; body begins at `out+12`. This is documented from the hook contract in `control630-lab/REPORT-CONTROL-630.md:43-44`. A valid VAD reply of 32 total body bytes therefore needs `capacity >= 32`; the status byte is already byte 0 of those 32 bytes. If capacity is smaller, return the existing insufficient-capacity result (`-2`) and let the native error cleanup run, with no partial success reply.

The generic full-frame guard (`generation-restore4/guard630.c:64-100`) verifies a complete ordinary non-stream frame and declared-body equality, bounds total body length, and currently defaults unknown body selectors to accepted (`guard630.c:97-98`). It does not recognize `f11a`, enforce its one-byte schema, or authorize reading `body[0]`. Add the `f11a` parser branch ahead of the native fallback and validate, before any body read: valid parser pointers under the existing dispatcher contract; pending command `0x855dc == 0xf11a`; no outstanding fragment (`ctx+0x10 == 0`); declared BE32 body length equals the passed `length`; nonnull body; `length == 1`; and `body[0] == 0x01`. Keep the generic full-frame guard. Do not tighten its unknown-command case in a way that preempts the command parser's malformed-request response.

For a complete, well-framed `f11a` request whose body shape/version is invalid, mirror the existing custom-parser failure convention: record failure and have the response handler write only one byte `0x01`, after checking `capacity >= 1`. A host parser that requires exactly 32 bytes rejects this one-byte error. Requests rejected earlier by the generic framing guard (for example, a header-declared length inconsistent with received bytes) remain native framing errors and may receive no command reply; they do not reach this one-byte custom error path. The one-byte body is not a fourth status value in the 32-byte snapshot format.

## Proposed request and response contract

Request body: exactly one byte, `01` (protocol version). No address, offset, length, write selector, or arbitrary payload.

On a recognized request, return exactly 32 body bytes using the existing proposal in `hardware-vad-trace/fresh-sample-candidate/CONTRACT.md:74-96`:

| Offset | Field |
|---|---|
| 0 | status: `0` OK, `1` BUSY, `2` UNAVAILABLE |
| 1 | protocol version `1` |
| 2 | flags: has sample, age valid, clock regression |
| 3 | native state byte |
| 4–7 | attempted reads, BE32 |
| 8–11 | successful reads, BE32 |
| 12–15 | last attempt status, BE32 two's complement |
| 16–19 | last successful raw word, BE32 |
| 20–27 | age, low then high BE32 |
| 28–31 | snapshot sequence, BE32 |

For BUSY/UNAVAILABLE, only bytes 0–3 are meaningful and the remainder is zero. Preserve status separately from the raw word. This exposes the firmware getter's sampled value; it does not make that value a calibrated voice-present boolean or prove microphone route/polarity. The provider output width and metric semantics remain unresolved in `hardware-vad-trace/reader-provider-followup/REPORT.md`.

## Context and snapshot synchronization limit

The Jensen request path runs in the `usbiap2` receive/command path: retained instruction evidence shows transport loop `0103bd8c` calling dispatcher `0103a82c` at `0103bed4`; dispatcher and response constructor identify `usbiap2` in their strings/call path. The module hooks sit inside those parser/response paths. Native VAD polling is different: `sugr_app` main loop `01032e70` dispatches the scheduler and state machine; selector 5 schedules the poller `01020b58` with delay value 50 (`hardware-vad-trace/lifecycle-followup/REPORT.md`). These are separate task contexts in the same recovered C-SKY firmware image, not one synchronous call chain.

The current image contains a save-PSR / clear-IE / restore-saved-PSR sequence (`hardware-vad-trace/lifecycle-followup/irq-snapshot/REPORT.md`). A very short saved-key section around only the RAM snapshot is a plausible same-core interrupt/preemption guard; do not put the DSP getter, clock call, logging, allocation, wait, or yield inside it. The retained evidence does not prove that disabling IE alone excludes every RTOS task switch, nor does it synchronize a DSP or another core. Provider/slot lifetime and writer synchronization also remain acceptance gates. No cross-DSP safety claim follows from this command map.

## Handoff

The future source implementation should add only an `f11a` parser/response branch in the frozen module path, use the existing status codes and exact 32-byte body, and add a separate strict SDK codec. Keep raw status and raw value visible. Before any image generation or device test, source-review the snapshot lifetime/locking and provider contract; then validate malformed one-byte errors and insufficient capacity through the native hooks. This report alone does not authorize or qualify those steps.
