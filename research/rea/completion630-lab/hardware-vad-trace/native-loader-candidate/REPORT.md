# Native object loader and snapshot reader (conditional offline source candidate)

Source only. Nothing here is linked into an image, placed at an address, flashed or run on a device. The existing image 393988 is unchanged. No hardware, USB, reset or Git command was used, and no file outside this folder was edited. The telemetry records the word the native caller already consumes after a successful read. It is not ASR or transcription, and it does not show that anyone is speaking.

## What was built

| File | Role |
| --- | --- |
| `h1e_vad_native_loader.c` | `int h1e_vad_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)` and `vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[VADT_REPLY_SIZE])` |
| `h1e_vad_native_loader.h` | Conditional-integration gate, the written warning, and the layout constants. Owns no prototype |
| `h1e_vad_native_loader_host_config.h` | Host seam, forced in with `-include`: typed fake slot read and guard |
| `h1e_vad_native_loader_test.c` | Host test of the real loader and reader bodies |
| `h1e_vad_native_loader.ck803.objdump.txt`, `link_isolated_testonly.txt` | Captured tool output |

Prototypes come from the read-only owners: `h1e_vad_load_object` from `../native-poll-candidate/h1e_vad_native_poll.h` and `h1e_vad_snapshot_read` from `../native-dispatch-candidate/h1e_vad_snapshot.h`. The loader header includes both, so the compiler sees them next to the definitions and a signature mismatch fails the build. That one-argument shim extern is the one the dispatch candidate calls (`console630_f11a.c` passes it to `vadt_f11a_response`). I did not test a deliberate mismatch.

## The conditional-integration gate

A C-SKY build is refused unless it passes `-DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1`. Nothing in this folder defines it. The header carries a WARNING block saying that the macro asserts five prerequisites and proves none of them:

1. All seven delayed-publication constructor hunks are applied, so the object is 0x60 bytes, zeroed before publication, and slot `0x852c0` becomes non-NULL only after constructor success.
2. A published object has no free in the audited runtime path. Teardown, ROM paths, indirect consumers and interrupts are not audited.
3. The loader and reader run only after the one-shot startup order of `early-reader-order/REPORT.md`, under the normal C-SKY callee-save ABI (r4 to r7 preserved).
4. The caller holds the IRQ guard. The loader takes none; `vadt_binding_read` does, through the ops table.
5. The 0x60 allocation succeeded and is 4-byte aligned. The loader rejects a misaligned base but cannot see a short allocation.

The header also refuses the macro set to anything but 1, refuses the host seam macros on the target, refuses `H1E_VAD_NATIVE_LOADER_HOST_TEST` on the target (added in the correction below), and asserts a 32-bit pointer at compile time. A build for any other target stops with an `#error`.

## Loader behavior

Order is fixed: write `*tail = NULL` and `*native_state = 0`, read the slot once through a `volatile uintptr_t`, reject NULL, reject a base above `UINTPTR_MAX - 0x5f` (the 0x60-byte extent would wrap), reject a misaligned `object+0x40`, and only then read the state byte at `object+0` and return `base + 0x40`. The telemetry words are never touched by the loader. The state byte is returned as it is: no state 5 check, no second slot read, no readiness claim. Failure returns 1 with `*tail` NULL and `*native_state` 0.

The reader is a `static const vadt_binding_ops_t` (NULL ctx, `vadt_csky_guard_enter/exit`, `h1e_vad_load_object`) and one call to `vadt_binding_read`. `ctx` is ignored.

Audit of the source, by grep and by the symbol and relocation list of the CK803 object:
- No non-const static or global. The only static is the `const` ops table, so no object pointer survives past a call.
- No getter, clock, `malloc`, `free` or DSP call. The object file's only undefined symbols are `vadt_binding_read`, `vadt_csky_guard_enter` and `vadt_csky_guard_exit`, with one `bsr` in the whole object.
- The loader writes only through its two output parameters.
- The reader never calls the getter. The poll wrapper is a separate file.

## Compiler flags

- C-SKY, T-HEAD `csky-abiv2-elf-gcc` 6.3.0 (in WSL): `-std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror -I../native-frame-candidate -I../fresh-sample-candidate -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1 -c`.
- Host, Ubuntu `cc` 13.3.0: `-std=c99 -Wall -Wextra -Wpedantic -Werror -O2 -D_DEFAULT_SOURCE=1 -include h1e_vad_native_loader_host_config.h`, with the loader, `vadt_core.c`, `vadt_binding.c` and the test built together.

## Build gate results (CK803)

| Build | Result |
| --- | --- |
| With `=1` | compiles clean, exit 0 |
| Without the macro | `#error ... asserts unproven prerequisites`, exit 1 |
| Macro set to `0` | same `#error`, exit 1 |
| Macro plus `-DH1E_VAD_SLOT_READ()=0u` | `#error ... host-test seams ... refused on the target`, exit 1 |

An isolated link of the loader object with the core, binding and guard objects at a made-up base `0x01000000` succeeds (exit 0). It is not an image, and the base is arbitrary. That link ran before the header correction below and was not repeated. The correction adds only a preprocessor check, and the object disassembly hash is unchanged.

The "Without the macro" row above also predates the correction. The reason it failed is the same `#error` as before.

## Disassembly (ck803, read by hand)

```
h1e_vad_load_object:
  movi r3,0 ; st.w r3,(r1) ; st.b r3,(r2)     ; *tail = NULL, *state = 0
  movi r3,0x5280 ; bseti r3,19 ; ld.w r3,(r3,0x40)   ; slot read at 0x85280 + 0x40
  subi r12,r3,1 ; r0 = 0 - 97 ; cmphs r0,r12 ; bf reject   ; base-1 > 0xFFFFFF9F -> reject
  andi r0,r3,3 ; bnez reject                  ; (base + 0x40) % 4, same as base % 4
  ld.b r12,(r3) ; st.b r12,(r2) ; addi r3,64 ; st.w r3,(r1) ; return 0
reject: movi r0,1 ; return
h1e_vad_snapshot_read: push r15 ; lrw r0,<ops> ; bsr vadt_binding_read ; pop r15
```

The constant 97 is `0x60 + 1`. The unsigned compare `base - 1 > 0xFFFFFF9F` also rejects NULL, and it equals `base > 0xFFFFFFA0` on a 32-bit target, which is `UINTPTR_MAX - 0x5f`. That is where the 32-bit overflow limit is verified, by reading the code. The compiler splits the slot address `0x852c0` into `movi 21120` plus `bseti 19`, which build `0x85280`, and a load offset of `0x40`. The sum is `0x852c0`. The ops table is loaded through an absolute literal.

## Host behavior (62 checks, 0 failures)

The host build is 64-bit, so the wrap tests below use 64-bit addresses and the limit `UINTPTR_MAX - 0x5f` at that width. The 32-bit limit rests on the disassembly above, not on a 32-bit run.

- Rejections (NULL, base +1, +2, +3 inside a PROT_NONE page, aligned base just past the limit, top of the address space, all ones, one past the limit): each returns 1 with `*tail` NULL, `*native_state` 0, and exactly one slot read. A misaligned base sits in a PROT_NONE page and the NULL and wrapping bases are unmapped, so an early state-byte or telemetry access would kill the test.
- A valid object is placed so that its last byte ends the readable page. States 0x00, 0x03, 0x05 and 0xFF each come back unchanged, the tail is `object+0x40`, the telemetry words are unchanged, and the slot is read once.
- Reader, populated tail (one success with word `0x01020304`, then a failure with status -5): all 32 reply bytes match, status OK, with `nativeState` 0x07 and 0x00 taken from the object. The sample stays after the later failure.
- Reader, fresh zero tail and a non-NULL ctx: OK, no sample, counters 0, native state 0xFF; ctx is ignored.
- Reader, NULL slot, misaligned base and wrapping base: UNAVAILABLE, header only, native state 0, no access.
- In every reader case the guard is entered once and restored once with the exact saved key, and the slot is read once, inside the guard.

Core, frame, SDK and poll behavior is not retested here.

## Preconditions versus proof

| Item | Status |
| --- | --- |
| Loader order (NULL, wrap, alignment, then access) and failure outputs | Proven by host test and disassembly |
| Reader delegates to `vadt_binding_read` with guard and the same loader, no getter, no clock | Proven by source and object symbols |
| No retained object pointer, no allocation or free in this code | Proven for these two functions only |
| Delayed publication hunks applied, 0x60 object zeroed before publication | Precondition, asserted by the macro |
| No free of a published object | Precondition, only the audited startup path supports it |
| Single-startup order | Supported for the observed path (early-reader audit), not proven globally |
| r4 to r7 preserved by the zeroing target and the GPIO method | Precondition. Their bodies are unresolved |
| 0x60 allocation success and 4-byte base alignment | Not qualified. The loader rejects misalignment but cannot see a short allocation |
| CPU ordering | Not qualified. The core uses compiler barriers only |
| Exclusion of another task, core or the DSP | Not provided. The PSR guard masks same-core interrupts only |

The addendum's remark that the seqlock validates payload only after dereferencing the tail applies here too: it cannot protect the tail's lifetime, and nothing in this loader does either. The lifetime is the macro's precondition.

## Open items and release gates

- No image link until the hook targets are reconciled with the frozen layout. The addendum records that the sample entry `0x0112c000` in `native-poll-candidate/REPORT.md` overlaps `.upload_text`. My earlier report still presents that value as a worked example only. I did not edit that folder; it needs a note from its owner.
- Teardown, ROM paths, interrupt and asynchronous users of slot `0x852c0` stay unaudited.
- The one-argument response shim is not reviewed here. Its extern is matched by the shared header only.
- The 32-byte wire framing depends on runtime values the addendum lists as unbound.
- No hardware, flash, reset or power action is authorized. The working-day gate stays in force.
- Not committed. No `delivery-gate` pass or adversarial review has run on this folder.

## Hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `h1e_vad_native_loader.c` | `a7ffe66574ef8b65a1ea9595765b2ba9524568022b02a1124ea34c7445866c99` |
| `h1e_vad_native_loader.h` | `23d2ee31956b004268227687ff0a4a9033da60cd68b8c25ec22a8d945045e657` (after the correction below; first version `4045ef111be3ec1a2907608c4e440300b31dd354923428e88d7ec0a2bb43ee58`) |
| `h1e_vad_native_loader_host_config.h` | `12dc537a8b130452668988f82cb1a814dd2e05e339ddb94a6e170c39c5e2f336` |
| `h1e_vad_native_loader_test.c` | `9322054c23dffdd2df655e6c78a946ad40894b4f1ffb7afe1d0e241217fdf13f` |
| `h1e_vad_native_loader.ck803.objdump.txt` | `bb700b61e1e24b82958781bbff89c088389877aae4d3f191ea34d5368dfc5b40` |
| `link_isolated_testonly.txt` | `8b26efc1d0c784f59dc68387aa8da6f397c4d796626a41871437cfb57342312d` |

`link_isolated_testonly.txt` is the captured link output plus two echo lines of mine, one of which is a stray note.

Read-only inputs at the end of the run, none edited:

| File | SHA-256 |
| --- | --- |
| `fresh-sample-candidate/vadt_core.h` | `f8dae82ce77a3fc2f0599f9feb2be77cf688694e9c6b103f83cd803faeb9bbd4` |
| `fresh-sample-candidate/vadt_core.c` | `e2efb05c8e0adb60a2e4a7309a23a83aa15272042f173d3af7d3381712ffc276` |
| `fresh-sample-candidate/vadt_binding.h` | `5c89d77206a0f8cf5e3e219312c367d5cef1402365432ed04f34366473012f89` |
| `fresh-sample-candidate/vadt_binding.c` | `edbd510b6babf15d20c4b4ae2feb8282f54957d14360e2d4f7c3fb521cd7f2bc` |
| `fresh-sample-candidate/vadt_csky_guard.c` | `42a761942e7dacfe86d3f75ed226e1991b859ecdad54347db0f11bbc79c5df59` |
| `native-poll-candidate/h1e_vad_native_poll.h` | `faf68945119b8de42dad80dd721410d8be74e367b3643d274a1f836e4455823e` |
| `native-poll-candidate/vadt_layout_check.h` | `bfca97abcd6b3470bee9a0fe8079e1d8a85a256b821f0cbe3407e13d1728c832` |
| `native-frame-candidate/vadt_frame.h` | `335c847f7656eb296bbaf21ff197690faa71f440737dd1034dd9390ede74ed5e` |
| `native-dispatch-candidate/h1e_vad_snapshot.h` | `c6b8754c630cd05f983300e7f1c580080c519245017005bcd71265dbb5a003a2` |
| `lifecycle-followup/late-publication/REPORT.md` | `8628085acc5bfa01e83fe99c5bb30d07c9282da70ec7d175791c8393c5bd1ea2` |
| `lifecycle-followup/early-reader-order/REPORT.md` | `ff22e231de23629137f4f52bd3072034692db9c6eebb42a909df7401f03bedee` |
| `combined-source-review/native-integration-addendum.md` | `19401330bc7ce235e02c95803325ebd23894d451cfafae430082c104721a0eb5` |

These belong to other owners and may change after this run.

## Correction: host-test branch bypassed the target gate

A review found a hole in the first version of the header. It tested `H1E_VAD_NATIVE_LOADER_HOST_TEST` before `__csky__`. A C-SKY build that also defined the host-test macro and the three seam macros took the host branch and skipped the macro-equals-1 check and the seam refusal. My earlier "Build gate results" table did not try that combination, so it did not show the hole.

Fix: one new first branch in `h1e_vad_native_loader.h`.

```
#if defined(__csky__) && defined(H1E_VAD_NATIVE_LOADER_HOST_TEST)
#error "refusing host-test build on the C-SKY target: ..."
#elif defined(H1E_VAD_NATIVE_LOADER_HOST_TEST)
   ... existing host branch ...
```

No function, layout, routing or runtime code changed, and no NULL checks were added.

Evidence from this run:

| Build | Result |
| --- | --- |
| CK803, `-include h1e_vad_native_loader_host_config.h` (host-test and seam macros), production macro also set to 1 | fails with the new `#error "refusing host-test build on the C-SKY target ..."`, exit 1 |
| CK803, production macro 1, no host config | compiles clean, exit 0 |
| Host `cc` with the host config (non-C-SKY branch) | compiles, 62 checks, 0 failures |

The first row set the production macro on purpose: the build is refused even with the prerequisite macro supplied. I did not run that combination against the old header, so I have no run showing it was accepted before. The old behavior comes from reading the old `#if` order.

Hashes after the correction: `h1e_vad_native_loader.h` `23d2ee31956b004268227687ff0a4a9033da60cd68b8c25ec22a8d945045e657`; `h1e_vad_native_loader.c` unchanged at `a7ffe66574ef8b65a1ea9595765b2ba9524568022b02a1124ea34c7445866c99`; `h1e_vad_native_loader.ck803.objdump.txt` regenerated and byte-identical to before at `bb700b61e1e24b82958781bbff89c088389877aae4d3f191ea34d5368dfc5b40`.

## Build leftovers

Outputs sit in WSL `/tmp` with the prefix `h1e_nlc_`: `h1e_nlc_host_test`, `h1e_nlc_loader.o`, `h1e_nlc_core.o`, `h1e_nlc_binding.o`, `h1e_nlc_guard.o`, `h1e_nlc_link.elf`, and the failed-build outputs `h1e_nlc_nomacro.o`, `h1e_nlc_zero.o`, `h1e_nlc_seam.o` and `h1e_nlc_hostcsky.o` if the compiler wrote any. They are outside the project, so I left them in place.
