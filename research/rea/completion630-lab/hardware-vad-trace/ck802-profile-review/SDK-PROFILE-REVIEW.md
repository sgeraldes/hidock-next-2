# CK802 SDK-profile review

Reviewed 2026-10-13 against the candidate artifacts in `native-ck802-candidate/sdk-profile/output/`. This is a source/ELF review of the peer-produced offline link; I did not rerun the build. It does not install or qualify firmware.

## Profile and ABI

The eight C translation units in `compile-commands.txt` all use the same SDK CK802 vector: `-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks`, plus the existing C99, warning, include and prerequisite-assertion options. That vector matches both the CK802 `cflags` and `aflags` in `research/rea/references/build-contracts/arch--csky--Makefile:11-12`. The eight files are `vadt_core.c`, `vadt_binding.c`, `vadt_csky_guard.c`, `vadt_frame.c`, `vadt_frame_target.c`, `h1e_vad_native_poll.c`, `console630_f11a.c` and `h1e_vad_native_loader.c`.

The three hand-assembly inputs are invoked with `-mcpu=ck802` only. The SDK Makefile lists the other options under `aflags` too, so the assembler command lines are not textually identical to that vector. Those files contain literal assembly and have no preprocessor conditionals; no C enum or `char` ABI crosses those assembly bodies. This remains a narrow command-level parity caveat, not evidence of a compile or instruction defect.

The probe's source declares the status, age, char and telemetry globals in that order, but `nm -n -S` shows the emitted object symbols ordered by address as telemetry, char, age, status. I mapped the `.rodata` bytes (`20 00 04 04` and `20 01 01 01`) through those symbol addresses:

| Profile | `sizeof(vadt_telemetry_t)` | Plain `char` signed | `sizeof(vadt_age_status_t)` | `sizeof(vadt_status_t)` |
| --- | ---: | ---: | ---: | --- |
| Earlier CK802 recipe (`-mcpu=ck802 -Os`) | 32 | no | 4 | 4 |
| SDK CK802 vector | 32 | yes | 1 | 1 |

The SDK flags therefore change plain `char` from unsigned to signed and shrink both enums from four bytes to one. All eight C units use the same flags, so their internal enum declarations and callbacks share one layout. The native poll boundary remains `int32_t h1e_vad_native_poll_bridge(uint32_t *)`: the hook BSR targets that symbol, and its generated bridge forwards the getter status through `vadt_binding_poll` in `r0`. Parser/response dispatch functions retain `int` returns; the assembly wrappers call them and branch on the returned `r0` value. The response reader's enum status stays within the consistently compiled C units.

## Runtime helper and link

`console630_f11a.c::decimal` divides and takes remainder by 10, which creates CK802 references to `__udivsi3` and `__umodsi3`. The link explicitly includes only those two objects from the toolchain's CK802 multilib archive; it does not link the whole archive.

| Input | Evidence |
| --- | --- |
| Archive | `/home/sebastian/.local/share/rea/tools/csky-20210423/lib/gcc/csky-elfabiv2/6.3.0/ck802/libgcc.a`; pinned and independently read-only SHA-256: `f0f80000e86c05cc3b7120762bad7b899f22ab1b3469eb83f8025520d31f40f3` |
| `_udivsi3.o` | SHA-256 `f463e0602e3d61173b3d5ee9c52e6d1fff027b17e5dc40df6562e7aa9b3ab389` |
| `_umodsi3.o` | SHA-256 `ac22cacc77c0fd9665aaa205fef3cd6afc359e1cb17d20822ad9e6c2a1ec31bb` |

The map places `_udivsi3` at `0x0112f978` with `.text` size `0x4a` (74 bytes), and `_umodsi3` at `0x0112f9c4` with `.text` size `0x30` (48 bytes). Their code totals 122 bytes; a two-byte alignment fill makes the address span 124 bytes. These map sizes supersede the earlier CK802 report's parser-derived 78-byte and 52-byte figures. The ELF has no undefined symbols. This is deliberate CK802 runtime support for scalar integer division/modulo, not evidence of an unsupported instruction or a target runtime result.

## Linked artifact and sparse edits

The ELF is tagged `ck802` / ISA flags `0x2806`. Its `.vad_text` is `0xa7c` (2684 bytes), and `size.txt` reports 2836 text bytes total, zero data and zero BSS. The unchanged linker script asserts zero writable globals, four-byte poll/parser/response hooks, and a `.vad_text` maximum of 16384 bytes (`native-link-candidate/module.ld:15-18`).

`sparse-source-hunks.json` binds the output ELF SHA-256 `576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366` to frozen decoded source SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`. It records ten non-overlapping instruction hunks totaling 28 bytes; each four-byte branch's decoded target matches its linked symbol. The constructor hunk contains 16 instruction bytes inside a 140-byte section and excludes 124 padding bytes. The poll, parser and response hook sections are four bytes apiece. Both accepted-input checks report all 36 pinned files unchanged before and after the build.

The build script writes `link-receipt.json` at step 7, before the sparse exporter runs at step 8. Because the output directory was reused for the second run, the receipt's file list includes `sparse-source-hunks.json` at SHA-256 `73ce3d0889955701b2a7874e91cd653f30439054a5b3f1e273b4327aeed3ed35` from the already-present manifest. The exporter then writes the current manifest, whose standalone SHA-256 is the same. Thus the receipt records the pre-export file at that path; the current manifest hash and its decoded contents are the evidence for the step-8 output.

## Qualification boundary

This establishes a conditional source compile/link under the SDK C profile with the two identified CK802 libgcc helpers. It does not establish the physical CPU/ISA behavior, module placement or capacity at `0x0112f000`, constructor pointer lifetime, ordering, callee-save assumptions, or the asserted delayed-publication prerequisites. No firmware image was generated, no hunk was applied, and no hardware test or release qualification is represented by these artifacts.
