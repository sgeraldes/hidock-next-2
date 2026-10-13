# Native f11a frame candidate

Source-only. No Git, image, generator, hook installation, app, hardware, Ghidra project or version allowlist was touched. `f11a` is not installed or allocated in any image. Existing firmware 393988 is unchanged. The snapshot reader is injected and nothing connects it to a live object. Everything here is host-verified source behavior plus isolated CK803 objects; nothing is target-qualified.

The `fresh-sample-candidate` folder was only read. Its six source hashes were re-checked after the work and match revision 3 (listed below).

## What was built

| File | Role |
| --- | --- |
| `vadt_frame.h` | Interface, frame offsets, bounds contract. |
| `vadt_frame.c` | Shared parser and response logic. Pointer-free of target addresses: frame words are resolved through an injected resolver, the pending command through an injected reader. |
| `vadt_frame_binding.c` | `vadt_f11a_binding_reader`, the existing `vadt_binding_read` as the injected reader shape. Unconnected. |
| `vadt_frame_target.c` | Minimal C-SKY adapter: identity address resolver, pending reader for the volatile uint16 at `0x000855dc`, and the two native ABI entry points `vadt_f11a_parse(frame, body, length)` and `vadt_f11a_response(frame, read, read_ctx)`. |
| `vadt_frame_test.c` | 70 checks on the shared logic. |
| `*.ck803.o`, `*.ck803.objdump.txt` | Isolated CK803 objects and disassembly. Not linked into an image. |

## Interfaces

Parser `vadt_f11a_parse_frame(frame, body, length, env)`:

- Reads head from `frame+0x14` and the command from `head[2..3]` (BE16). Any other command, an unresolved head, or a pending command different from `0xf11a` returns `-1` with no writes. The pending reader runs only for `f11a`.
- Reads ctx from `frame+0x1c` and the declared body length (BE32 at `head+8`) before any write.
- Valid only when: body non-NULL, ctx resolved, `length == 1`, declared length equals `length`, fragment word at `ctx+0x10` is 0, then `body[0] == 1`. Length is checked before `body[0]` is read.
- Valid: `head[8]=0`, `head[9]=1`, returns 0. Recognized but bad: `head[8]=1`, `head[9]=0`, returns 1. Only those two head bytes change.

Response `vadt_f11a_response_frame(frame, env, read, read_ctx)`:

- Reads command from `frame+0x18`; not `f11a` returns `-1` and nothing else is read or written.
- Capacity from `frame+0x20` (excludes the 12-byte header), head from `frame+0x28`, output header base from `frame+0x1c`.
- NULL head or output, or capacity 0: `-2`, no write.
- `head[8] != 0` (recorded bad request): writes `out[12] = 1`, returns 1. Needs capacity >= 1.
- No recorded valid request (`head[9] != 1`), capacity < 32, or no reader: `-2`, reader not called for the capacity cases, no write.
- Otherwise the reader fills a local 32-byte buffer. The reply is copied to `out[12..43]` and 32 is returned only if it passes these checks: status is 0, 1 or 2 and equals `reply[0]`; `reply[1] == 1`; OK has flags `HAS_SAMPLE` only and both age words zero (unclocked); BUSY and UNAVAILABLE have flags 0 and bytes 4..31 zero; UNAVAILABLE has byte 3 = 0. A failing reply returns `-2` with the output untouched. No new status was invented.
- The 32 bytes are the final body: status is byte 0, no extra prefix.

## Run

Host (WSL Ubuntu `cc` 13.3.0), from `native-frame-candidate`, with `F` = the `fresh-sample-candidate` folder:

```powershell
wsl.exe -d Ubuntu --exec sh -c 'R=/mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace; N=$R/native-frame-candidate; F=$R/fresh-sample-candidate; cc -std=c99 -Wall -Wextra -Wpedantic -Werror -O2 -I$F -I$N $N/vadt_frame.c $N/vadt_frame_binding.c $F/vadt_core.c $F/vadt_binding.c $N/vadt_frame_test.c -o /tmp/vadf_t && /tmp/vadf_t; rm /tmp/vadf_t'
```

CK803 objects use `csky-abiv2-elf-gcc -std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror -I$F -I$N -c` with the toolchain under `/home/sebastian/.local/share/rea/tools/csky-20210423/bin`.

## Actual outcomes

- Host `-O2 -Wall -Wextra -Wpedantic -Werror`: exit 0, 70 PASS, no FAIL, `70 checks, 0 failures`.
- Host `-O1 -g -fsanitize=address,undefined -fno-sanitize-recover=undefined` plus the same warnings as errors: exit 0, `70 checks, 0 failures`, no sanitizer report.
- The first run had one FAIL (`parse: only head bytes 8 and 9 change`). The test's expectation was wrong: the fixture sets `head[10..11]` to the BE32 declared length, which the test assumed was `0x5A`. I fixed the expectation, not the code, and reran. The rerun is what is reported above.
- CK803 isolated objects, `-Os -Wall -Wextra -Werror`: `vadt_frame.o` 456 bytes, `vadt_frame_target.o` 92 bytes, `vadt_frame_binding.o` 8 bytes, all text only, no `.data` or `.bss`. The target object's only undefined symbols are `vadt_f11a_parse_frame` and `vadt_f11a_response_frame`; `vadt_frame.o` has none; the binding object needs `vadt_binding_read`. The disassembly shows `target_pending` reading a halfword from the constant `0x000855dc` (built as `21952 | 1<<19`) and `target_resolve` as `mov r0, r1`.

Covered cases: unknown command untouched (three commands, pending reader never called); exact valid request; zero-length, two-byte, version 2 and 0, NULL body, declared-length mismatch, outstanding fragment, unresolved ctx all rejected with `head[8]=1`; pending mismatch returns `-1` with no writes; capacity 0 and 31 return `-2` with the reader never called and no output write, capacity exactly 32 succeeds; error byte with capacity 1 writes only `out[12]`; NULL head, NULL output, no recorded request and no reader return `-2`; reader replies with status 3, a status/byte-0 mismatch, wrong version, AGE_VALID, a nonzero age word, a BUSY with flags, and an UNAVAILABLE with nonzero nativeState are all rejected without a partial write; the real `vadt_binding_read` as reader gives the exact 32-byte OK body for a valid-zero sample, UNAVAILABLE as status 2 with byte 3 zero, and BUSY with raw nativeState 9 kept; no DSP getter exists on this path.

## SHA-256

New folder, sources (taken at the successful run):

| File | SHA-256 |
| --- | --- |
| `vadt_frame.h` | `335c847f7656eb296bbaf21ff197690faa71f440737dd1034dd9390ede74ed5e` |
| `vadt_frame.c` | `4221342a366f6ec3b044c1a28c9b70b60319256916d5e56c0c50adeec9a65037` |
| `vadt_frame_binding.c` | `9204f9f5b96ab85f81fae635e69525ea7d149c874ae2fd67dadef66fd9952143` |
| `vadt_frame_target.c` | `ae64e2dee71e700096e9bb0b7afb1685ff937979e5809f330c645732953cad65` |
| `vadt_frame_test.c` | `c9373473c50aae935fff73cc9870c172ebcae430bd65aa461c09f6be868b16df` |

Objects and disassembly:

| File | SHA-256 |
| --- | --- |
| `vadt_frame.ck803.o` | `adfeb3ec87236d946eedceffb0acb7cfa828b073395338d80a7cd996c13ee463` |
| `vadt_frame_target.ck803.o` | `fd9e7e2bbeb31dacd07cf07c107d4e870f34456f79d9d952adbf42b2f5cd65eb` |
| `vadt_frame_binding.ck803.o` | `81faa95570ae74c1372272e5abefde29e994935ba52f737d6ee8defb784edad8` |
| `vadt_frame.ck803.objdump.txt` | `53330effc0897fa3d7555f4e78bb99b63a2a2546789fdda9f5c96b6a2b8d9db1` |
| `vadt_frame_target.ck803.objdump.txt` | `9a860eb688c2ad0bbecdee3153adb8a22f9475b74d8ad42d3dad0d445c41dae2` |

Immutable `fresh-sample-candidate` sources, unchanged: `vadt_core.h` `f8dae82c...bbd4`, `vadt_core.c` `e2efb05c...c276`, `vadt_binding.h` `5c89d772...2f89`, `vadt_binding.c` `edbd510b...f2bc`, `vadt_csky_guard.c` `42a76194...df59`, `vadt_test.c` `36040348...8010` (full values are in that folder's REPORT.md).

This REPORT.md is not hashed.

## What this does not establish

- Frame offsets are not independently pinned. The test builds its fixtures from the same `VADT_*_OFF_*` macros the code uses, so a wrong macro would pass both. The offsets come from the frozen `console630.c` (parser `0x14`/`0x1c`; response `0x18`/`0x1c`/`0x20`/`0x28`) and were not re-derived. The disassembly folds the offsets into address arithmetic and does not show them individually.
- Pointer extents are checked only for NULL. The core assumes the dispatcher contract: head at least 12 bytes, ctx at least `0x14`, body at least `length`, output at least `12 + capacity`. A bad extent cannot be detected from the frame.
- The host tests use handles resolved to buffers. The real 32-bit-word-to-pointer cast and the `0x855dc` read exist only in the target object, which was compiled and disassembled, not executed. The little-endian word load matches `elf32-csky-little`.
- The response relies on the parser having run. If the parser returns `-1`, `head[8..9]` still hold the BE32 declared length. A declared length of `0x01000000` or more would look like a recorded error to the response. The generic frame guard bounds body length; I did not verify that bound here.
- The namespace report says the common transport serializer may add one byte to the response length. The on-wire length for a 32-byte reply is unmeasured.
- Serializer padding, the real hook insertion points (`0103a996`, `0103907a`), and the fallback addresses `01128698` and `01128798` are not wired in this folder. Returning `-1` is the fallback signal; the caller owns the actual fallback call.
- The binding behind the reader is still the provisional one: no object loader, constructor-order fix, readiness condition, teardown, reader-context proof or CPU/IRQ guard qualification. The lower transport unit and write width behind `0101f0ec`, the channel and the freshness are unqualified. These are unchanged from `fresh-sample-candidate`.
- No runtime qualification of any kind: no image, no device, no emulation.

Effort: requested medium; I cannot confirm the effective level.
