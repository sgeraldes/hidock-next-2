# CK802 compile and link of the accepted VAD source (conditional offline)

Source only. No hardware, USB, reset, flash, provider call, firmware image, decoded firmware, OTA or container. The accepted sources, the older CK803 ELF and its documents were read and not edited. The only files written are in this folder. The ELF is `...-NOTINSTALL.elf`. It is not an image and it does not qualify any CPU or device.

## Result

| Build | Outcome |
| --- | --- |
| CK803 control, same recipe | Links. Reproduces the earlier `native-link-candidate` output (see below) |
| CK802, same inputs only | Does not link: `undefined reference to __umodsi3` and `__udivsi3` |
| CK802 plus the toolchain's CK802 `libgcc.a` | Links, exit 0 |

The CK802 failure comes from `decimal()` in `console630_f11a.c`, which does `value % 10u` and `value /= 10u`. CK803 compiled these to `divu` and `mult`. CK802 has no such instruction in the compiler output, so the compiler emits calls to the libgcc routines. The linker command in `native-link-candidate/build-offline.sh` has no libgcc input, so the CK802 link cannot resolve them.

I did not edit the source or work around it with hand-written assembly. The recipe has an explicit switch, `LIBGCC=1`, that adds `libgcc.a` for the chosen core as one more link input. That variant has its own output directory (`output-ck802-libgcc`) and is labeled as a different input set from the accepted one. Whether to accept libgcc code in the module, or have the owner of `console630_f11a.c` avoid the divide, is a decision for the source owner and reviewer. I made neither change.

## Inputs, before and after

`check-inputs.py` hashes the same 36 files that `build-offline.sh` hashes (frozen 393988 decoded image, symbols, `module.ld`, `console-hooks.S`, all `.c` and `.h` in the five candidate folders, `late-publication.s`, the link `module.ld`, `poll-hook.S`, `build-offline.sh`, and the three reports) and compares them with `native-link-candidate/accepted-inputs.json`.

| Check | Result |
| --- | --- |
| Before the CK802 build | 36 of 36 match, nothing changed, nothing added |
| After the build | the recipe asserts pre equals post. It passed |
| Once more at the end of this session | 36 of 36 match |

The per-run lists are in `output-ck802-libgcc/input-hashes-pre.json` and `input-hashes-post.json`. The recipe stops with exit 3 if a pinned input changed. The pinned frozen image hash and the four imported upload and restore addresses are also asserted by the script, and they matched.

The libgcc archive is a new linker input outside the 36. It is `lib/gcc/csky-elfabiv2/6.3.0/ck802/libgcc.a` under the REA toolchain, 1,550,560 bytes, SHA-256 `f0f80000e86c05cc3b7120762bad7b899f22ab1b3469eb83f8025520d31f40f3`.

## Compiler and flags

T-HEAD `csky-abiv2-elf-gcc` 6.3.0 (V3.10.29), in WSL. The flags are the ones in `build-offline.sh` with only the core changed:

`-std=c99 -mcpu=ck802 -Os -Wall -Wextra -Werror -I fresh-sample-candidate -I native-frame-candidate -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1`

The three assembly files (`console-hooks.S` from the frozen folder, `late-publication.s`, `poll-hook.S`) assembled with `-mcpu=ck802` unchanged. Link: `csky-abiv2-elf-ld -nostdlib -T native-link-candidate/module.ld`, with `libgcc.a` appended in the libgcc variant. All eight C files compiled with no warning under `-Werror`. There was no unsupported opcode and no assembler error.

## Target gates still hold on CK802

| Build of `h1e_vad_native_loader.c` for `-mcpu=ck802` | Result |
| --- | --- |
| No prerequisite macro | refused, `#error ... asserts unproven prerequisites` |
| Macro set to 0 | refused, same `#error` |
| Macro 1 plus the forced host-test config | refused, `#error "refusing host-test build on the C-SKY target ..."` |
| Macro 1, normal | compiles (part of the link) |

The macro is passed only by the recipe. Nothing in this folder defines it by default.

## Module facts (CK802 with libgcc, against CK803)

| Item | CK803 | CK802 with libgcc |
| --- | --- | --- |
| `.vad_text` at `0x0112f000` | `0xa2c` (2604 B) | `0xa7c` (2684 B) |
| `.constructor_edit` | `0x8c` at `0x01021054` | same |
| `.poll_hook`, `.parser_hook`, `.response_hook` | 4 B each | 4 B each |
| `.data`, `.bss` | no such section, and the `module.ld` ASSERT on their size passed | no such section, the ASSERT passed, and `size` on the ELF reports data 0, bss 0 |
| Undefined symbols | none | none (the recipe fails on any) |
| Upload and restore aliases | `0112c2c4`, `0112ca1c`, `0112d7d8`, `0112e162` | same |
| ELF ISA tag | ck803, flags `0xa80e` | ck802, flags `0x2806` |

The 16 KiB budget and the 4-byte hook sizes are `ASSERT`s in the unchanged `module.ld`. The link passed them.

CK802 adds 80 bytes to `.vad_text`. libgcc contributes `__udiv32` (78 B) and `__umodsi3` (52 B), 130 B in total. By arithmetic the other functions net to 50 bytes smaller. I derived that from the totals and did not account for alignment padding.

## Hooks and constructor edits (file bytes shown as objdump words)

| Site | CK803 | CK802 with libgcc |
| --- | --- | --- |
| `01020b62` poll, 4 B | `e008752f` to `0112f5c0` `h1e_vad_native_poll_bridge` | `e0087515` to `0112f58c` same symbol |
| `0103a996` parser, 4 B | `e007a7b3` to `0112f8fc` `console630_parser_hook` | `e007a79d` to `0112f8d0` same symbol |
| `0103907a` response, 4 B | `e007b465` to `0112f944` `console630_response_hook` | `e007b44f` to `0112f918` same symbol |
| `01021070` publication, 4 B | `e008749a` to `0112f9a4` `late_publication_stub` | `e00874c2` to `0112f9f4` same symbol |
| `01021054`, `0102105c`, `0102106a`, `0102109e`, `010210a8`, `010210de`, 2 B each | `3060`, `6dc3`, `6c1f`, `3260`, `6ddf`, `6cdf` | identical |

The four branch words differ only in their displacement, because the code moved inside the module. The six two-byte constructor edits are the same on both cores. The constructor section is still one `0x8c` region with zero padding between the sites, as in the earlier review. Copying that whole section over firmware would overwrite constructor code. I did not run `export-sparse-hunks.py` for CK802, because it reads a fixed `native-link-candidate/output` path.

## CK802 against CK803, only where code changes

- Identical mnemonic sequences in both: `vadt_init`, `vadt_getter_adapter`, `vadt_csky_guard_enter` and `_exit`, `load_word`, `target_resolve`, `console630_parser_hook`, `console630_response_hook`, the other `console_*` helpers, `late_publication_stub`, the two ops tables and the constructor edits. The guard stays `mfcr r0,cr<0,0>`, `psrclr ie`, `jmp r15` and `mtcr r1,cr<0,0>`, with the same encodings on both cores.
- Different mnemonic sequences in 23 functions: `put_be32`, `vadt_record_completed`, `vadt_poll`, `vadt_snapshot`, `vadt_age`, `encode_reply`, `vadt_encode_reply`, `vadt_encode_reply_with_age`, `vadt_binding_poll`, `vadt_binding_read`, `vadt_f11a_parse_frame`, `vadt_f11a_response_frame`, `target_pending`, `vadt_f11a_parse`, `vadt_f11a_response`, `h1e_vad_native_poll_bridge`, `decimal`, `version`, `equal`, `console630_parse`, `console630_response`, `h1e_vad_load_object`, `h1e_vad_snapshot_read`. The CK803 side uses `bez` and `bnez` where the CK802 side has no such instruction. I did not diff each pair beyond that. Sizes move by a few bytes either way, for example `vadt_record_completed` 102 B to 86 B, `vadt_f11a_response_frame` 268 B to 282 B, and `decimal` 60 B to 78 B.
- Emitted only in the CK803 output: `divu`, `mult`, `bez`, `bnez`, `bseti`, `movih`, `zext`, `ldr.b`, `str.b`.
- Emitted only in the CK802 output: `xtrb1` and `xtrb2` in `console630_response`, and in libgcc `ff1`, `lsl`, `lslc`, `lsr`, `nor` and `trap`.
- libgcc `__udiv32` and `__umodsi3` each contain `trap 3` on divide-by-zero. In this module the divisor is the constant 10 (read in `decimal()`), so I expect that path is not taken. I did not execute it. What `trap 3` does on the target is not known to me, and I did not check it.

I read these differences from the disassembly. I did not run either build and I did not check the CK802 instruction encodings against the architecture manual. The assembler and linker accepted every instruction.

## CK803 control

The control matches the earlier `native-link-candidate` output where the code lives:

| Compared | Result |
| --- | --- |
| `candidate.objdump.txt` after the header lines | 0 diff lines |
| `symbols.txt` | identical |
| `.vad_text` bytes (objcopy) | same SHA-256 `0749f802c52817b33e1e9568ead25ee16adb9fb020a3d1d394d434b478c48aca` |
| `sections.txt` | differs: my recipe adds `readelf -A`, and the string table is `0x4d` bytes larger |
| Whole ELF SHA-256 | differs: control `52d3d3b7525c9a899dca3e974ca04b093a0f76e4dd54002b3029770adfc10dea`, earlier `0cc0c025c7d3ff03eef22c2858d0a15efb716522119d8dc6672a3386e341dd65` |

The string-table growth is consistent with longer object paths in the symbol table of my output folder. I did not check that. The old ELF, its map and its documents are unchanged (its hash still equals the `LINK-REVIEW.md` value) and stay as the historical CK803 profile.

## Repeatable recipe

From WSL, in this folder:

```
CPU=ck803 ./build-ck802.sh            # control, output-ck803/
CPU=ck802 ./build-ck802.sh            # same inputs only, fails at link, output-ck802/
CPU=ck802 LIBGCC=1 ./build-ck802.sh   # adds libgcc.a, output-ck802-libgcc/
```

`output-ck802/` keeps the objects and partial map of the failed same-inputs attempt as evidence. It has no ELF and no receipt.

## Hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `build-ck802.sh` | `3278fd76bc5799afb8673ab74d0ec95fd97114fcd1b4873291d7a8e856ee4e06` |
| `check-inputs.py` | `7086bb132565d642c1b9fd4d5003ab713836e5a5d66b67af6fe35c7f852d52f9` |
| `output-ck802-libgcc/conditional-source-ck802-NOTINSTALL.elf` | `00ff881658905c61a39b339506fd61894e28060900cf0420faf56176d5a491ae` |
| `output-ck802-libgcc/candidate.map` | `59ab06ef9e100eb341d0cc230b45b37bffc36058d3e0246ab2b5302fff6472c7` |
| `output-ck802-libgcc/candidate.objdump.txt` | `5bd1cf0fafcb147a3e05271f4682ee6cdd7a7df1f7d5259f96553d254960a82c` |
| `output-ck802-libgcc/sections.txt` | `251a1a4312cb0285b9466e6873028d923080876caae37dae5a916215734013d5` |
| `output-ck802-libgcc/symbols.txt` | `9765956593197cbe01db81b88bdf00a7bf1e327027d4d9d53dd7d47ad501c90d` |
| `output-ck802-libgcc/link-receipt.json` | `7d6111b41919f04f581fa488b6fbec2fe744b46afa7180601a7ec89a699adcd7` |
| `output-ck803/conditional-source-ck803-NOTINSTALL.elf` | `52d3d3b7525c9a899dca3e974ca04b093a0f76e4dd54002b3029770adfc10dea` |
| `output-ck803/candidate.objdump.txt` | `70fa95b406318b58c262c8581aab4aca54b7e288725ca7068f1a7123b46a4e57` |
| `output-ck803/link-receipt.json` | `f8258db23f93fd434192068a33a052fb3455f6eb7c015cf9a4b863cd605decf4` |

## What this does and does not show

It shows that the accepted VAD source, the unchanged native console hook assembly and the seven constructor hunks compile and link for the CK802 profile at the same example base `0x0112f000`, with the gates intact, once libgcc supplies the integer divide. It does not show that the target is CK802, that the CK802 instructions behave correctly on a device, or that the delayed-publication prerequisites, the callee-save assumption (r4 to r7), CPU ordering and lifetime hold. Those stay as asserted by the macro. The module placement `0x0112f000` is still only an example. Nothing was run, flashed or sent to a device. No `delivery-gate` pass or adversarial review has run on this folder, and nothing is committed.

## Build leftovers

Outputs outside the project, in WSL `/tmp`: `h1e_ck802_precheck.json`, `h1e_ck802_cmp.bin`, `h1e_ck802_fn.txt`, `h1e_ck802_final_check.json`. They are small and I left them in place.
