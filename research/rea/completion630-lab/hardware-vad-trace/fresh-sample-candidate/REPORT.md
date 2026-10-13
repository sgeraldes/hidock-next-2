# Fresh-sample telemetry candidate: report, revision 3

Source preparation and host execution only. This is not firmware qualification. No hardware, Git, USB, firmware generation, patch, flash, app, SDK, network or Ghidra project action took place. The device stays custom393988 and `runtime/frozen393988` is unchanged. Results below are host tests and isolated C-SKY objects only. Nothing is qualified on the target. The binding stays unconnected: no object loader, hook or frame handler exists.

## Revision 3 changes

| Review issue | Change |
| --- | --- |
| nativeState byte 3 | The shared reply encoder now normalizes the status first (OK with a NULL snapshot becomes UNAVAILABLE) and writes byte 3 = 0 for UNAVAILABLE. BUSY and OK write the passed native state. Both `vadt_encode_reply` and `vadt_encode_reply_with_age` go through that one function. CONTRACT.md states the rule exactly. |
| Guard flags clobber | Both asm statements in `vadt_csky_guard.c` declare `"memory"` and `"cc"`. `mtcr psr` rewrites the condition flag along with IE, so the exit needs it; enter has it conservatively. Compilation succeeded with the clobbers, so none was removed. |
| Builder CPU | Isolated objects are now built with `-mcpu=ck803` instead of ck802. |
| Stale claims | CONTRACT.md no longer says the order fix or the source encodings are unknown. It separates the current image from the proposal in `lifecycle-followup/lifetime-fix/REPORT.md`, and marks every proposed cell as not applied. |

## Proposed versus applied

Applied to any image: nothing. Proposed, with isolated assembler and linker evidence from `lifetime-fix/REPORT.md`: allocation and clear size `0x40` to `0x60` (`6030`, `6032`), hold the pointer in `r7` at `0102105c` (`c36d`), publish after the zeroing at `010210a8` (`e0b5`), and a ten-byte cleanup reorder at `[01021074,0102107e)` that clears the slot before the free (`0033 60b5 01e0f4c8 0034`). Those artifacts show the encodings assemble. They do not show that readers cannot hold a pointer across the free, that the object is ready when published, that other users accept `0x60`, or that the ROM wrapper at `0008009e` preserves `r7`.

## Files and SHA-256

| File | SHA-256 |
| --- | --- |
| `vadt_core.h` | `f8dae82ce77a3fc2f0599f9feb2be77cf688694e9c6b103f83cd803faeb9bbd4` |
| `vadt_core.c` | `e2efb05c8e0adb60a2e4a7309a23a83aa15272042f173d3af7d3381712ffc276` |
| `vadt_binding.h` | `5c89d77206a0f8cf5e3e219312c367d5cef1402365432ed04f34366473012f89` (unchanged) |
| `vadt_binding.c` | `edbd510b6babf15d20c4b4ae2feb8282f54957d14360e2d4f7c3fb521cd7f2bc` (unchanged) |
| `vadt_csky_guard.c` | `42a761942e7dacfe86d3f75ed226e1991b859ecdad54347db0f11bbc79c5df59` |
| `vadt_test.c` | `3604034837f414e966a75190319400faa5a975927c0fadca6f853330863e8010` |

`CONTRACT.md`, `RUN.md` and this file were edited after these hashes were taken and are not hashed here.

## Test run (one run after the changes)

Host: WSL Ubuntu `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, `-std=c99 -Wall -Wextra -Wpedantic -Werror -O2`.

- `vadt_core.c` and `vadt_binding.c` built without the test hook: clean.
- Test build and run: exit 0, 118 PASS lines, no FAIL line, last line `118 checks, 0 failures`. The previous 111 checks all remain; 7 are new.
- New checks (all PASS): explicit UNAVAILABLE with native state 7 gives byte 3 = 0, and version set with flags and bytes 4..31 zero; OK with a NULL snapshot and native state 7 gives byte 3 = 0; the same two cases through the age encoder; BUSY with native state 7 keeps byte 3 = 7 through both encoders.
- Isolated C-SKY objects, `csky-abiv2-elf-gcc` T-HEAD 6.3.0, `-std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror -c`: `vadt_core.o`, `vadt_binding.o`, `vadt_csky_guard.o` compiled clean, no link, no image.
- Guard disassembly (`objdump -d`): `vadt_csky_guard_enter` is `mfcr r0, cr<0,0>`, `psrclr ie`, `jmp r15`; `vadt_csky_guard_exit` is `mtcr r1, cr<0,0>`, `jmp r15`. PSR save, IE clear and restore are unchanged by the added clobber, which affects the compiler and not the emitted instructions. The image's own sequence at `01074606`, `0107460a`, `0107464c` uses the same three instructions (bytes `00 c0 24 60`, `80 c0 20 70`, `04 c0 20 64`, read from the hashed image in the earlier revision).

I did not run a mutation campaign or any broader test this revision. The `"cc"` clobber has no host test: it only constrains the compiler, and I checked it by compiling and disassembling.

## Blockers (unchanged by this revision)

- Constructor ordering and readiness: the proposed reorder and delayed publication are not applied and not reviewed. Publication still happens before byte `+2`, the `0108e250` call and the `+8` store, so a loader needs a verified readiness condition. Detaching does not revoke a pointer a reader already copied.
- No normal successful teardown is known, and a local IRQ mask does not cover another core or the DSP.
- Heap size and alignment for the `0x60` request, the 13 other literal users of slot `0x852c0`, and the ROM wrapper's `r7` preservation are unchecked.
- The Jensen reader's context and core are not established.
- No wrapper code, address or `bsr` displacement exists for `01020b62`.
- Lower transport unit, write width, freshness and physical channel behind `0101f0ec` are unqualified.
- The optional clock needs its own qualification (`01090054` pair semantics and writer unidentified).
- Context-task and namespace proof are progressing separately and are not part of this folder.

Effort: requested medium; I cannot confirm the effective level.
