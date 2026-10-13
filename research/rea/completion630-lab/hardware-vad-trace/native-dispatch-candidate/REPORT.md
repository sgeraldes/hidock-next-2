# Native dispatch candidate: console630 fork with tentative f11a

Source-only. No hardware, USB, reset, flash, image generation, Git or index action. Frozen firmware 393988 is unchanged. `f11a` is not installed, allocated or linked into any image. The snapshot reader symbol is deliberately unresolved. Host results are host-only; the CK803 object is compile-only and was not linked or run.

## What was built

| File | Role |
| --- | --- |
| `console630_f11a.c` | Fork of the frozen `generation-restore4/console630.c` (SHA-256 `5dbfc45e...f945e90`, re-hashed, unchanged). Same `console630_parse(frame, body, length)` and one-argument `console630_response(frame)`. |
| `console630_f11a.diff` | CR-stripped unified diff, frozen to fork. |
| `h1e_vad_snapshot.h` | Declares `vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[32])`. Defined nowhere in this folder. |
| `h1e_dispatch_host_seams_testonly.h` | Test-only. Replaces the fixed target addresses and the 32-bit word-to-pointer cast, only under `-DH1E_DISPATCH_HOST_TEST`. |
| `console630_f11a_test.c` | 42 checks that run the real dispatch functions. Holds the test-only fake reader, explicitly marked. |
| `console630_f11a.ck803.o`, `.objdump.txt` | Isolated CK803 production-mode object and disassembly. |

## Exact changes to the frozen source (32 diff lines as first written; 38 after Correction 1 below)

1. `#include "h1e_vad_snapshot.h"` added.
2. A block of accessor macros after the extern declarations. Without `H1E_DISPATCH_HOST_TEST` they expand to the same casts and addresses the frozen code wrote inline: pending command `0x000855dc`, f117 idle byte `0x000855cc`, fallbacks `0x01128698` and `0x01128798`, kernel getter `0x0103c664`, firmware word `0x00100f84`, uptime getter `0x01090054`, and the identity cast for frame words. With the define, they come from the test-only header.
3. Parser: one new line after the f118 branch, `if(cmd==0xf11au)return vadt_f11a_parse(frame,body,length);`. It sits before the `cmd!=0xf117u` fallback test.
4. Response: one new clause after the f118 clause, `if(cmd==0xf11au)return vadt_f11a_response(frame,h1e_vad_snapshot_read,NULL);`.
5. The remaining changed lines only replace inline casts with the macros.

f117, f118 and f119 routing, the f117 text responses and both fallbacks are otherwise textually unchanged. The frozen file uses CRLF line endings and the fork uses LF, so a plain diff shows every line changed; the diff file here strips CR.

## Checks and outcomes

- Host `-std=c99 -O2 -Wall -Wextra -Wpedantic -Werror -DH1E_DISPATCH_HOST_TEST`: exit 0, 42 PASS, no FAIL, `42 checks, 0 failures`.
- Host `-O1 -g -fsanitize=address,undefined -fno-sanitize-recover=undefined`, same warnings as errors: exit 0, `42 checks, 0 failures`, no sanitizer report.
- The first run had one FAIL, `f117 parse: pending mismatch returns -1, head untouched`. My expectation was wrong: the fixture stores the declared length in `head[8..11]`, so `head[9]` was 0, not the fill byte. I changed the test to compare the whole head before and after, not the code, and reran. The numbers above are from the rerun.
- The shared f11a logic under test is the real `native-frame-candidate/vadt_frame.c`. The two stand-ins for the C-SKY adapter record their arguments and then call the real `vadt_f11a_parse_frame` and `vadt_f11a_response_frame`. The 70 frame tests were not duplicated.
- What the 42 checks cover: ABI shape; f11a parse routed once with the same frame, body and length, recording `head[8]=0 head[9]=1`; during an f11a parse the pending command is read once, through the shared f11a code's own pending reader, and the f117 pending-command and idle-byte seams are not called (the f117 path does read both, as the f117 parse checks below show); the f11a response is a one-argument call returning 32 with the reader called once with a NULL ctx and `out[12..43]` equal to the reply and the header and tail untouched; a bad version is recorded and the response writes only `out[12]=1` with the reader not called; f117 help, version and uptime parse and response including the pending, idle, capacity-0 and error cases and the three getters; f119 and f118 routed to restore and upload with identical arguments and nothing else entered; unknown `0x1234` and neighbour `0xf11b` forwarded to the fallbacks with identical arguments, no f11a call and no output write.
- No DSP getter on the USB path: the host seams show the kernel, firmware and uptime getters untouched in every f11a check. The disassembly of the fork has zero references to `1fb68`, the DSP getter's address.

## CK803 isolated object

`csky-abiv2-elf-gcc -std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror`, production mode (no test define): compiled clean.

- Size: text 809 bytes, no data or bss. The frozen `console630.c`, compiled the same way in `/tmp` for comparison and deleted, is 773 bytes, so the fork adds 36.
- Undefined symbols: `h1e_vad_snapshot_read`, `vadt_f11a_parse`, `vadt_f11a_response`, `restore630_parse`, `restore630_response`, `upload630_parse`, `upload630_response`. The frozen object has only the last four.
- Relocations: the parser calls `vadt_f11a_parse` (pcrel at `0xc0`), the response calls `vadt_f11a_response` (pcrel at `0x19a`), and the reader pointer is an `R_CKCORE_ADDR32` to `h1e_vad_snapshot_read` (at `0x2c0`).
- Absolute-address literal set, frozen versus fork: identical (`0x0103c664`, `0x01090054`, `0x01128698`, `0x01128798`). The pending and idle cells are built as `0x855c0` plus offsets `0x1c` and `0xc` in the fork's disassembly, which gives `0x855dc` and `0x855cc`.

## Hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `console630_f11a.c` (current, after Correction 1) | `1ba30cdbb7f298c95b5cb972e482beb6005bb1944accb9a82b69c5da85661a8f` |
| `console630_f11a.diff` (current, after Correction 1) | `2468800f95ed8fc75e594ab55b24420c841735eecefad827bef871856a1cd0bb` |
| `h1e_vad_snapshot.h` | `c6b8754c630cd05f983300e7f1c580080c519245017005bcd71265dbb5a003a2` |
| `h1e_dispatch_host_seams_testonly.h` | `a2f1489db0fc75323a0a9d90566fedecb7c47cadda56f41c2574cc08d2681b08` |
| `console630_f11a_test.c` | `29aa6b387801ece4a511a9d7a62865498589265ab60835ad1899ebbd2ca2dbab` |
| `console630_f11a.ck803.o` | `106a73a508542d1783f1af2578123c63b3e12d762380fd1a3de966f2fb18ed5c` |
| `console630_f11a.ck803.objdump.txt` | `79ab2b43522db8d218b632abcbbc024e60bcf15e29e031a2c6267c71d13b8d30` |

Read-only dependents were hashed before and after: 16 files (the `native-poll-candidate` header and source, the `native-frame-candidate` sources and objects, the six `fresh-sample-candidate` sources, and the frozen `console630.c`), 16 of 16 unchanged.

## Remaining integration gates

- `h1e_vad_snapshot_read` has no production definition and no fake was linked to hide that. A definition needs the accepted object loader, the constructor-order fix and a readiness condition, the lifetime and teardown story, the reader context, and the IRQ guard, as listed in `fresh-sample-candidate/CONTRACT.md` section 8. Until then any link of this object fails on that symbol, on purpose.
- To resolve `vadt_f11a_parse` and `vadt_f11a_response` the build needs `native-frame-candidate`'s `vadt_frame.ck803.o` and `vadt_frame_target.ck803.o`. No link was attempted.
- Response headroom. The reply body is 32 bytes, so the compiled 512 and 64-byte packet geometries do not trigger the native one-byte length extension, and the SDK's strict 32-byte contract is unchanged. The live values behind `FUN_0104f520()` and `FUN_0104f730()` are unverified. `response-framing/REPORT.md` says that if the extension cannot be ruled out the response needs `capacity >= 33`. The adapter in `native-frame-candidate` requires only `capacity >= 32` and I did not change it. A decision is needed there.
- The hook insertion points (`0103a996`, `0103907a`), the generator and the image build were not touched.
- Host seams replace the target addresses, so the real address reads (`0x855dc`, `0x855cc`) and the fallbacks are checked by disassembly and literal comparison, not executed.
- Frame offsets still come from the frozen source and are shared with the frame tests; they are not independently re-derived.
- The reply carries a raw sampled word. Nothing here infers readiness or voice presence.

Effort: requested medium; I cannot confirm the effective level.

## Correction 1: configuration guards

Source-only. The sections above keep their original results; this section changes the current source and the current hash rows (marked in the table above).

Review found that `H1E_DISPATCH_HOST_TEST` could be selected on a C-SKY build even though the test header says it never ships to the target. `console630_f11a.c` now has two guards at the macro block:

- `H1E_DISPATCH_HOST_TEST` together with `__csky__` stops with `#error "H1E_DISPATCH_HOST_TEST replaces the target addresses and must never be selected on a C-SKY build"`.
- The production branch without `__csky__` stops with `#error "the production branch hard-codes C-SKY target addresses; build it with a C-SKY compiler, or select H1E_DISPATCH_HOST_TEST for the host test"`.

No NULL or frame-pointer guard was added. The frozen contract that the native dispatcher passes a valid frame is retained, not a new regression. No routing or runtime logic changed; the diff against the frozen source grew from 32 to 38 changed lines, all of them the six `#ifdef`/`#error`/`#endif` lines.

Observed outcomes (one run each):

| Configuration | Result |
| --- | --- |
| CK803 production, `-std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror`, no define | exit 0. The saved object is byte-identical to the freshly built one. Text 809 bytes, same size as before. Undefined symbols unchanged: `h1e_vad_snapshot_read`, `vadt_f11a_parse`, `vadt_f11a_response`, `restore630_*`, `upload630_*`. |
| CK803 with `-DH1E_DISPATCH_HOST_TEST` | exit 1, the first `#error` at line 13, no object written. |
| Host `cc` without `-DH1E_DISPATCH_HOST_TEST` | exit 1, the second `#error` at line 18, no object written. |
| Host test runner with `-DH1E_DISPATCH_HOST_TEST`, `-O2 -Wall -Wextra -Wpedantic -Werror` | build exit 0, run exit 0, 42 PASS, `42 checks, 0 failures`. Sanitizers were not repeated. |

The CK803 object and disassembly come out byte-identical to the earlier ones, so their hashes did not change: `console630_f11a.ck803.o` `106a73a5...ed5c` and `console630_f11a.ck803.objdump.txt` `79ab2b43...3d30` (full values in the table above). Current hashes of the two files that changed are in the table above. `console630_f11a_test.c` is unchanged from the rerun (`29aa6b38...dbab`). The 16 read-only dependents were re-hashed: 16 of 16 unchanged.

## Corrections to earlier statements

- The f117 pending-command statement is reworded in the checks list above. The f117 parse path does read the pending command and the idle byte (the f117 parse checks show one call to each). What the f11a checks observe is that, during an f11a parse, the f117 pending and idle seams are not called; the f11a path reads the pending command once through the shared frame code's own reader.
- "Response headroom": `command-binding/response-framing/endpoint-helper-binding.md` says the serializer's alignment field is the runtime halfword at `0x000867d6`, zeroed at startup and stored with `0x200` (512) at `0x0104f490` and `0x40` (64) at `0x0104f6fc`, and that the non-mode-1 branch's body capacity is `0x2000 - 0x0c = 8180`. For a 32-byte body, `L = 44`, and neither `44 % 64` nor `44 % 512` is zero, so the one-byte extension is not taken for either visible value. I do not pad the reply to 33 and the adapter and SDK strict 32-byte contract are unchanged. The earlier gate about the divisor value is narrowed: the live value, the mode, and whether a response can reach the serializer before the driver writes either size remain unmeasured, so the no-padding result is source-conditioned.
- "Unresolved reader": the statement that `h1e_vad_snapshot_read` has no definition is about this folder only and about this folder's history. A production-shape snapshot reader is being built separately in `native-loader-candidate/` by another owner. I did not read or touch those files, and nothing here claims the symbol is absent from the repository.

Effort: the effective effort is unknown to me.
