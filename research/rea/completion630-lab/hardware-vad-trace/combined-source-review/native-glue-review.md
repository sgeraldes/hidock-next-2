# Native glue review

Reviewed 2026-10-13. This is a bounded source review of the f11a dispatcher, object loader, and offline link recipe. It does not qualify installed firmware or hardware behavior.

## Decision

The dispatcher and loader are source-compatible for a conditional offline source link under the production C-SKY flags shown in `native-link-candidate/build-offline.sh`, with the delayed-publication prerequisites asserted. Both now reject host-test macros when `__csky__` is defined, and the dispatcher rejects production mode off C-SKY. The parser keeps the native three-argument signature; the response keeps the native one-argument signature and adapts it to the snapshot reader internally. The snapshot path reads the object slot once, never retains its pointer beyond the guarded binding call, and adds no DSP getter.

The coordinator's manifest gate requires `accepted-inputs.json` with status `conditional_source_only_not_target_qualified` and exact hashes for source, reports, and this review. That manifest is not present yet, so the link remains closed. The loader's object extent and lifetime still depend on the explicitly stated constructor, no-free, and caller-guard assumptions. This review permits an offline source link only; it does not permit image generation, installation, or hardware qualification.

## Findings

### 1. Target host-test gate is fixed

The loader now tests `defined(__csky__) && defined(H1E_VAD_NATIVE_LOADER_HOST_TEST)` before selecting either branch and errors immediately (`native-loader-candidate/h1e_vad_native_loader.h:55-56`). Its later C-SKY branch continues to require the delayed-publication assertion, refuse host seam macros, and assert 32-bit pointers. The dispatch source likewise errors when `H1E_DISPATCH_HOST_TEST` is selected on C-SKY, and errors when the production branch is selected off C-SKY (`native-dispatch-candidate/console630_f11a.c:11-19`). The original bypass is fixed in both sources. The loader report was refreshed to describe this guard. No new tests were run for this review.

The offline recipe does not set host-test macros. These gates make the source-selection boundary explicit; the delayed-publication macro remains an assertion of prerequisites, not evidence that they hold.

### 2. Link recipe now requires a coordinator-pinned review manifest

An initial version checked only for nonempty report files. The coordinator revised `native-link-candidate/build-offline.sh:10-13,22-33` to require `accepted-inputs.json`, assert the conditional-source-only status, and compare an exact hash map that includes both reports and this review before compiling; it also checks those inputs again after linking. This resolves the weak-report-gate finding in the current script. Both candidate reports now exist, but the accepted manifest is still absent, so the script correctly remains closed. Once the loader gate is fixed and these reviews are final, the coordinator must create the manifest from those exact files before an offline link.

The linker script places the offline candidate at `0x0112f000` (`native-link-candidate/module.ld:7-18`), after the frozen upload and restore reservations described by the parent source map. The earlier hypothetical `0x0112c000` would collide with upload text and is not used here. This `.vad_text` base is still only an offline ELF example: no linker map was generated, no firmware image was generated, and this review does not authorize that address for an installed image.

## Source contract checks

- **Native ABI and routing:** `console630_f11a.c:26-31` adds f11a to the existing parser without changing its `(frame, body, length)` arguments. Lines 44-46 route the one-argument native `console630_response(frame)` to the f11a response adapter. That adapter receives the internal `(ctx, reply[32])` callback and a null context; the callback type is not being substituted for the native hook ABI. The dispatcher report records preservation of f117/f118/f119 and fallback routing. The existing dispatcher already assumes a valid native frame/header; lack of a new frame-null check is not a regression introduced by this glue.
- **Getter count and reader behavior:** The dispatcher report records one snapshot-reader call for f11a response and no references to the DSP getter address `0x0101fb68`. The loader's snapshot function (`h1e_vad_native_loader.c:68-72`) delegates to `vadt_binding_read`; it does not invoke the getter, a clock, or an allocator. The separate poll bridge retains the existing one-argument getter call. No readiness flag or voice-presence inference was added.
- **Slot checks and pointer lifetime:** `h1e_vad_native_loader.c:32-53` initializes outputs, performs one volatile slot read, rejects null, checks that a 0x60-byte extent cannot wrap, checks four-byte alignment, then reads only the native state byte and forms the telemetry-tail pointer. `vadt_binding_read` holds the guard while loading and copying the snapshot, and encodes the reply after restoring the guard (`fresh-sample-candidate/vadt_binding.c:32-51`). The pointer is local to that guarded call and is not stored globally. These arithmetic checks do not prove that the allocation is actually 0x60 bytes or that it remains live; the loader cannot discover a shorter object or independently prove its lifetime.
- **Guard and lifetime limits:** The C-SKY guard saves the PSR, clears interrupt enable, and restores the saved PSR with compiler memory/condition-code clobbers (`fresh-sample-candidate/vadt_csky_guard.c:18-31`). This supports the same-core interrupt exclusion assumed by the binding. It does not establish ordering with another core or DSP, or prevent reclamation through an unaudited teardown/indirect path. The loader header explicitly makes successful 0x60 allocation, delayed publication, no free during use, guarded call sites, and normal C-SKY r4-r7 callee-save behavior prerequisites (`h1e_vad_native_loader.h:19-39`). The lifecycle reports support conditional construction: known legacy readers are post-constructor, and the constructor's self-reload must use its private pointer. Opaque interrupt/ROM paths and teardown are still unknown; they are release limits, not grounds to block this bounded source candidate.
- **Response extent:** The dispatcher report records the 32-byte f11a reply placed in response bytes `out[12..43]`. The endpoint helper audit identifies 64- and 512-byte values for the native endpoint read-size/alignment field; they are not response body capacities. For a 32-byte body the total length is 44, and neither visible field value triggers the one-byte length extension. The ordinary non-mode-1 body capacity is 8180 bytes; the mode-1 capacity depends on its frame argument. Which endpoint value is active on a live connection remains unverified. No wire-format or live-endpoint qualification is claimed here.

## Evidence pinned for this review

The loader and dispatch reports now exist and their hashes below identify the reviewed versions. Hashes do not authorize a link without the coordinator-pinned manifest.

| Input | SHA-256 |
| --- | --- |
| `native-dispatch-candidate/console630_f11a.c` | `1ba30cdbb7f298c95b5cb972e482beb6005bb1944acbba82b69c5da85661a8f` |
| `native-dispatch-candidate/REPORT.md` | `86144445de865fc3e65f5e7eb5192ca33a97e57110812e7b94fdb7ee2958f917` |
| `native-loader-candidate/h1e_vad_native_loader.c` | `a7ffe66574ef8b65a1ea9595765b2ba9524568022b02a1124ea34c7445866c99` |
| `native-loader-candidate/h1e_vad_native_loader.h` | `23d2ee31956b004268227687ff0a4a9033da60cd68b8c25ec22a8d945045e657` |
| `native-loader-candidate/REPORT.md` | `a0505273aaf05dd4c8e8bb498ea68986c30e61c01346d4c51e7f7bfddec16ef3` |
| `native-link-candidate/build-offline.sh` | `0c80274ebbf8a23035c1086cf31fbb1ef419d9c8fcfe71574ea769d37f271e23` |
| `native-link-candidate/module.ld` | `b3e26eb9ff6e2f64c216dfb6915f601e70abb29a2ec4118ed7dd93a0afce8ab3` |
| `native-poll-candidate/h1e_vad_native_poll.h` | `faf68945119b8de42dad80dd721410d8be74e367b3643d274a1f836e4455823e` |
| `lifecycle-followup/early-reader-order/REPORT.md` | `ff22e231de23629137f4f52bd3072034692db9c6eebb42a909df7401f03bedee` |
| `command-binding/response-framing/endpoint-helper-binding.md` | `36b2500257c2109736358dc75750dc51466da57930022118255deaa72432985f` |

No source files were changed and no tests, compiles, links, image operations, or hardware actions were run for this review. The dispatch report's host and isolated-object results are reported evidence, not newly rerun checks.
