# Native poll bridge: one-argument wrapper for 01020b62 (source candidate)

This folder holds source only. Nothing here is linked into an image, placed at an address, flashed or sent to a device. The existing image 393988 is unchanged. No hardware was touched, no Git or index command was run, and no file outside this folder was edited. The work is VAD telemetry: it records the word the native caller already consumes after a successful read. It is not ASR, transcription or a backend, and it does not show that anyone is speaking.

## What was built

| File | Role |
| --- | --- |
| `h1e_vad_native_poll.h` | Only owner of the wrapper and loader prototypes |
| `h1e_vad_native_poll.c` | `int32_t h1e_vad_native_poll_bridge(uint32_t *native_word)`, a thin call into `vadt_binding_poll` with a `static const` ops table |
| `vadt_layout_check.h` | C99 `offsetof` and `sizeof` asserts for the 32-byte tail, plus the written loader requirements. Includes `vadt_core.h` and does not edit it |
| `h1e_vad_host_test_config.h` | Host seam, forced in with `-include`. Swaps the getter, guard and loader for typed fakes |
| `h1e_vad_native_poll_test.c` | Host boundary test of the real wrapper body |
| `h1e_vad_loader_stub_testonly.c` | TEST ONLY loader that always returns 1 (unavailable). Carries the symbol `h1e_vad_loader_stub_version` = `TESTONLY-UNAVAILABLE-STUB-v1 not a real binding` |
| `hook_site_01020b62.S` | One `bsr` with the target taken from `--defsym` |
| `*.objdump.txt`, `hook_site_01020b62.encoding.txt`, `stub_link_testonly.txt` | Captured tool output |

`h1e_vad_load_object` is declared and has no definition anywhere except the test-only stub. A link of the wrapper without the stub fails:

```
/tmp/h1e_npc_poll.o:(.rodata+0xc): undefined reference to `h1e_vad_load_object'
```

The wrapper reads the getter, guard enter, guard exit and loader through macros (`H1E_VAD_NATIVE_GETTER` and three more). Without the host config they resolve to the real getter constant `0x0101fb68`, `vadt_csky_guard_enter/exit` and `h1e_vad_load_object`. The file stops the build off C-SKY unless `H1E_VAD_NATIVE_POLL_HOST_TEST` is defined. The host test therefore compiles the same function body that the C-SKY build uses. There is no duplicate helper.

## Source hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `h1e_vad_native_poll.c` | `454d10055a2b1f24a78a639188e76ce74f1b2c5f842223fa545d831c807851f0` |
| `h1e_vad_native_poll.h` | `faf68945119b8de42dad80dd721410d8be74e367b3643d274a1f836e4455823e` |
| `vadt_layout_check.h` | `bfca97abcd6b3470bee9a0fe8079e1d8a85a256b821f0cbe3407e13d1728c832` |
| `h1e_vad_host_test_config.h` | `0e8f607e11b022489ba3c77b0f2ce43a66dbe809b3b7447b9ff59741451392fc` |
| `h1e_vad_native_poll_test.c` | `bfc329ac614d6b7cf6191a73aeb420a00dc7607f178d2ead5e826226a013e6f7` |
| `h1e_vad_loader_stub_testonly.c` | `f4671c47ad368de856d179c9a75da47c83da120ffc34cabdc53d16a51b47f6d4` |
| `hook_site_01020b62.S` | `5437b96db0adb7b13cc3c744abc58040132204fcb20a0e5058b15cf2d0d815ca` |
| `hook_site_01020b62.encoding.txt` | `66403e280fc326ac53dcb0c0b88e58b5a34ab8db284807a388acff8e7bc534ca` |
| `h1e_vad_native_poll.ck803.objdump.txt` | `995e369288fa276fbe70966d1d77de87fbc7cf8b12f075262b3148b4b2a4a509` |
| `vadt_binding.ck803.objdump.txt` | `dd47a84305206a7e4cf15c4bb785e1b97642c1589da2c6b911cb19766e80c178` |

Read-only inputs at the end of the run, none edited:

| File | SHA-256 |
| --- | --- |
| `fresh-sample-candidate/vadt_core.h` | `f8dae82ce77a3fc2f0599f9feb2be77cf688694e9c6b103f83cd803faeb9bbd4` |
| `fresh-sample-candidate/vadt_core.c` | `e2efb05c8e0adb60a2e4a7309a23a83aa15272042f173d3af7d3381712ffc276` |
| `fresh-sample-candidate/vadt_binding.h` | `5c89d77206a0f8cf5e3e219312c367d5cef1402365432ed04f34366473012f89` |
| `fresh-sample-candidate/vadt_binding.c` | `edbd510b6babf15d20c4b4ae2feb8282f54957d14360e2d4f7c3fb521cd7f2bc` |
| `fresh-sample-candidate/vadt_csky_guard.c` | `42a761942e7dacfe86d3f75ed226e1991b859ecdad54347db0f11bbc79c5df59` |
| `combined-source-review/REPORT.md` | `30c37a0be05a7440e3da65ee94991d5916d7cfa9bba6ae008aafa9c54d06f9d6` |

These inputs belong to other owners and may change after this run.

## Compiler flags

- C-SKY, T-HEAD `csky-abiv2-elf-gcc` 6.3.0 (V3.10.29, in WSL): `-std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror -c`. Built clean: the wrapper, the test-only stub, `vadt_core.c`, `vadt_binding.c`, `vadt_csky_guard.c`.
- Host, Ubuntu `cc` 13.3.0: `-std=c99 -Wall -Wextra -Wpedantic -Werror -O2 -include h1e_vad_host_test_config.h`, building the wrapper, `vadt_core.c`, `vadt_binding.c` and the test together.
- Hook site: `csky-abiv2-elf-gcc -mcpu=ck803 -c`, then `csky-abiv2-elf-ld -nostdlib -Ttext=0x01020b62 --defsym h1e_hook_target=<addr>`.

## Wrapper disassembly (ck803, as captured)

```
push r15
mov  r2, r0                 ; caller's pointer becomes argument 3
lrw  r1, 0x101fb68          ; getter constant, argument 2
lrw  r0, <ops table>        ; argument 1
bsr  vadt_binding_poll
pop  r15                    ; return, r0 still holds the status
```

The input pointer arrives in r0 and goes on to `vadt_binding_poll` unchanged. The status comes back in r0 and nothing between the `bsr` and the `pop` touches it. The wrapper pushes only r15, so `lr` is saved and restored.

In `vadt_binding_poll` the disassembly shows `mov r0, r2` then `jsr r1` for the single getter call, with the caller's pointer in r0. The status is saved in r6 and put back in r0 before return (`mov r0, r6`). The word is loaded (`ld.w r5,(r5,0)`) only on the status-0 path (`bnez` skips it). The guard calls go through the ops table: enter, then the loader, then exit with the saved key. No store to the caller's word appears anywhere in the function.

The ops table is in `.rodata` and is loaded through an absolute `lrw` literal. The getter address `0x0101fb68` is an absolute constant, so it holds only if the image loads at the base used in the earlier contract.

## Hook site at 01020b62

The `.S` file assembled at `0x01020b62` against `0x0101fb68` reproduces the original bytes exactly: `ff e3 03 f8`, width 4. That check shows the assembler procedure matches the native encoding.

The same file against the hypothetical, unallocated entry `0x0112c000` (defsym only) gives `08 e0 4f 5a`. I decoded both words by hand: opcode field `111000`, a signed 26-bit offset in halfwords (-2045 for the original, +547407 for the hypothetical), target `0x101fb68` and `0x112c000`, and link register `0x01020b66` for both. The distance is inside the 64 MiB reach of `bsr`.

These bytes are a worked example. No placement was chosen or allocated. They must be recomputed once a real link symbol exists, and they are not the actual hook bytes until then.

## Observed boundary (host test, 49 checks, 0 failures)

The test calls the real wrapper body against typed fakes and checks:

- The fake getter receives the caller's own pointer, runs exactly once and runs outside the guard. The word it receives is the caller's zero-initialized value.
- The word the getter writes stays as written, and the status returns unchanged for 0, a negative status, `INT32_MIN`, `INT32_MAX` and 1.
- Event order is getter, guard enter, loader, guard exit. The loader runs inside the guard and metadata is written before the guard is restored.
- With a fake object available, metadata is recorded once: counters, word and status, HAS_SAMPLE set and no time recorded.
- A getter failure records an attempt with no success and no sample, and leaves the caller's word alone.
- A failed loader skips all metadata, still returns the getter status and still restores the guard with the saved key.
- The guard key is restored exactly as saved, including 0, `0xFFFFFFFF`, `0x80000000` and a value with the interrupt bit clear.

Wrap, age and BUSY behavior are not repeated here. The core tests cover them. The layout asserts compile under `-Werror` for both the host and ck803. A deliberate bad assert (`flags` at offset 24) fails to compile with a negative array size, so the check does work.

An isolated link of the wrapper, core, binding and guard with the test-only stub succeeds at a made-up base `0x01000000`. That link is not an image and not a binding. It shows the symbols resolve and that `vadt_binding_poll` is reached by relative `bsr`.

## Not done, and not claimed

- No object loader exists. The requirements are written in `vadt_layout_check.h`: read the slot inside the guard, reject NULL, reject a base that is not 4-byte aligned before any word access, return success only for an object that cannot be freed or replaced while the guard is held, and do not use state byte 5 or a second slot read as a lifetime guarantee.
- Object lifetime is open. The constructor failure path frees before it clears the slot. A peer is working on a late-publication constructor plan and I did not implement any state heuristic. Until that exists and is reviewed, no loader may be written.
- CPU ordering is not qualified. The core uses a compiler barrier only. The saved-PSR guard is a same-core interrupt mask, and the review says not to treat it as task exclusion, or as a lock against another core or the DSP.
- `attemptedReads` counts only attempts recorded while the tail was loadable, not every native getter call since boot.
- I have not checked that the native call site relies on nothing beyond the normal call contract. The wrapper clobbers r1 to r3 the way any callee may, and I did not recheck the native code after `01020b66`.
- The 0x60-byte allocation, its base alignment and the allocator behavior are not qualified.
- Nothing here shows a live voice or VAD signal, DSP freshness, or what the word means. The word is whatever the native caller consumes after a successful read.
- This work has not had a `delivery-gate` pass or an adversarial review, and it is not committed.

## Build leftovers

The build outputs sit in WSL `/tmp` with the prefix `h1e_npc_`: `h1e_npc_host_test`, `h1e_npc_poll.o`, `h1e_npc_stub.o`, `h1e_npc_core.o`, `h1e_npc_binding.o`, `h1e_npc_guard.o`, `h1e_npc_hook.o`, `h1e_npc_hook_orig.elf`, `h1e_npc_hook_orig.bin`, `h1e_npc_hook_hyp.elf`, `h1e_npc_hook_hyp.bin`, `h1e_npc_stublink.elf` and `h1e_npc_neg.c`. They are outside the project, so I left them in place. They go away when WSL is restarted, or they can be removed by those exact names.
