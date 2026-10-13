# CK802 SDK-profile build of the accepted VAD source (conditional offline)

Source only. No hardware, USB, reset, app, Git, firmware image, container or release. The 36 accepted inputs, the earlier CK803 and CK802 outputs and their reports were read and not edited. Everything this phase wrote is in `native-ck802-candidate/sdk-profile/`. The ELF is named `conditional-source-ck802-sdk-NOTINSTALL.elf` and is not an image.

Result: all eight C units use the SDK CK802 flag set; the three literal assembly units use `-mcpu=ck802` only. The conditional link has no undefined symbols, `.data` and `.bss` both 0, four hooks of 4 bytes each, and ten sparse hunks of 28 bytes exported against the pinned 393988 image. This is not full assembler command-line parity with the SDK `aflags`.

## Flags

Every C unit uses the same command line (the recipe checks that all eight lines in `output/compile-commands.txt` contain the profile string):

```
-std=c99 -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks
-Wall -Wextra -Werror
-I fresh-sample-candidate -I native-frame-candidate
-DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1
```

The eight units are `vadt_core`, `vadt_binding`, `vadt_csky_guard`, `vadt_frame`, `vadt_frame_target`, `h1e_vad_native_poll`, `console630_f11a` and `h1e_vad_native_loader`. The three assembly inputs (`console-hooks.S`, `late-publication.s`, `poll-hook.S`) assemble with `-mcpu=ck802`. The recipe reads the ELF attributes of all eleven objects and stops unless each says `ck802`. Compiler: T-HEAD `csky-abiv2-elf-gcc` 6.3.0 (V3.10.29) in WSL. The loader gate is unchanged. Without the macro the build is refused, as in the earlier phase. I did not repeat those refusal builds.

## What the flags change

A probe (`enum-probe.c`, metadata only, never linked) was compiled with the earlier profile and with the SDK profile. The bytes are `telemetry size, char signed, age-enum size, status-enum size`, labeled by symbol address from `nm`:

| Profile | `sizeof(vadt_telemetry_t)` | plain `char` signed | `sizeof(vadt_age_status_t)` | `sizeof(vadt_status_t)` |
| --- | --- | --- | --- | --- |
| `-mcpu=ck802 -Os` (earlier CK803 and CK802 builds used this default) | 32 | no | 4 | 4 |
| SDK profile | 32 | yes | 1 | 1 |

So the earlier outputs were built with 4-byte enums and unsigned plain `char`. The 32-byte telemetry layout and its static asserts hold under both. The asserts compiled under `-Werror`.

Effect on code: I compared the linked disassembly of this build with the earlier CK802 build (`output-ck802-libgcc`) for all 44 functions, after normalizing addresses. One function changed, `vadt_f11a_response_frame`. The earlier build did `zextb r3, r0` on the value returned by the read callback before comparing it with a byte loaded from the staged reply. The SDK build compares `r0` directly with the loaded byte and picks different registers for two `cmpnei` tests, so the function is 2 bytes shorter. That fits a one-byte enum return, but I did not bisect which of the four flags caused it. The function's slot is padded to 4 bytes, so every symbol address in the two builds is identical (`symbols.txt` diffs clean) and the four `bsr` words are identical to the earlier CK802 build.

The direct consequence for the enum-return callbacks: `vadt_status_t` is now a one-byte value returned in `r0`, and the caller relies on the callee returning it already extended. All eight units use the same flags, so caller and callee agree. An object built without the SDK flags that called or was called through these callbacks would not agree. Compiler flag parity says nothing about the opaque ROM paths, the lifetime assumptions or the physical silicon.

## ABI of the integer hooks

Read from the SDK-profile disassembly:

- `h1e_vad_native_poll_bridge(uint32_t *)` returns `int32_t`, no enum. It pushes only `r15`, moves the incoming `r0` into `r2`, loads the getter constant `0x0101fb68` into `r1` and the ops table into `r0`, calls `vadt_binding_poll`, and returns with `r0` untouched. Identical to the earlier CK802 build.
- `h1e_vad_snapshot_read(ctx, reply)` puts the ops table into `r0`, leaves `r1` (the reply pointer) as it came in, calls `vadt_binding_read` and returns its `r0`. The enum travels straight through with no conversion.
- `console630_parser_hook` and `console630_response_hook` keep the same `push r4-r7, r15` frame as `console-hooks.S` expects and call the `int`-returning dispatch functions. The response hook compares the returned `int` with `-1` and `-2`. No enum crosses the native boundary.

## Helpers from libgcc

The accepted owner decision is to include the compiler-runtime integer division, so `decimal()` stays as written. The recipe:

1. Asks the compiler for the libgcc of the SDK-profile multilib and stops unless the path ends in `/ck802/libgcc.a`.
2. Checks that archive against a pinned hash before using it (`sha256sum -c`).
3. Extracts only `_udivsi3.o` and `_umodsi3.o` and links those two objects explicitly. Nothing else from the archive can enter the module.

| Item | Value |
| --- | --- |
| Archive | `.../csky-elfabiv2/6.3.0/ck802/libgcc.a`, 1,550,560 bytes |
| Archive SHA-256 | `f0f80000e86c05cc3b7120762bad7b899f22ab1b3469eb83f8025520d31f40f3` |
| `_udivsi3.o` | SHA-256 `f463e0602e3d61173b3d5ee9c52e6d1fff027b17e5dc40df6562e7aa9b3ab389`, `.text` at `0x0112f978`, `0x4a` bytes, symbols `__udivsi3` and `__udiv32` (same address) |
| `_umodsi3.o` | SHA-256 `ac22cacc77c0fd9665aaa205fef3cd6afc359e1cb17d20822ad9e6c2a1ec31bb`, `.text` at `0x0112f9c4`, `0x30` bytes, symbol `__umodsi3` |

The two helpers span `0x0112f978` to `0x0112f9f4`, 124 bytes with 2 bytes of alignment padding. Both contain `trap 3` on a zero divisor. The only divisor in this module is the constant 10 in `decimal()`, so I expect that path is never taken, but I did not execute it. What `trap 3` does on the target is not established here. The helpers also bring in `ff1`, `lsl`, `lslc`, `lsr` and `nor`, which the assembler accepted.

### Correction to the earlier CK802 report

`native-ck802-candidate/REPORT.md` says libgcc contributes `__udiv32` at 78 B and `__umodsi3` at 52 B, 130 B in total, and that the rest of the code nets 50 B smaller. Those sizes came from my own disassembly parser and are wrong. The linker map shows `0x4a` and `0x30` (122 B, 124 B with padding). The `.vad_text` growth from CK803 to CK802 is still 80 B (`0xa7c` against `0xa2c`). By section arithmetic the rest of the code is 44 B smaller than on CK803, not 50 B. I left that earlier report unchanged, as instructed.

## Linked module

| Item | Value |
| --- | --- |
| `.vad_text` | `0x0112f000`, size `0xa7c` (2684 B), `AX`, 4-byte aligned. `module.ld` asserts it is at most 16 KiB |
| `.constructor_edit` | `0x8c` bytes at `0x01021054` |
| `.poll_hook`, `.parser_hook`, `.response_hook` | 4 bytes each at `01020b62`, `0103a996`, `0103907a` (asserted by `module.ld`) |
| `size` | text 2836, data 0, bss 0. No `.data` or `.bss` section. The recipe checks the size output and stops otherwise |
| Undefined symbols | none (`nm -u` is checked and the build stops otherwise) |
| ELF attributes | `ck802`, ISA flags `0x2806` |
| Imported aliases | `upload630_parse 0112c2c4`, `upload630_response 0112ca1c`, `restore630_parse 0112d7d8`, `restore630_response 0112e162` |

The region at `0x0112f000` is the same hypothetical one the earlier link used, after the old upload and restore reservations. It is not a reservation for the combined firmware, and capacity and placement are not decided. I took the frozen layout from the earlier link review and did not re-derive it.

## Hook and constructor hunks

`output/sparse-source-hunks.json` holds ten hunks, 28 instruction bytes, matched to the pinned 393988 decoded image (`b338e4d5...c2f`). The 124 bytes of zero padding between the constructor sites are excluded. Nothing is applied and no image is produced. `before_hex` and `after_hex` are the raw file bytes, little-endian per halfword. The objdump listing shows each instruction as a word, which is a different byte order, so for example the poll branch prints as `e0087515` and its file bytes are `08 e0 15 75`. For each four-byte `bsr`, the exporter decodes the target from the raw bytes and asserts it equals the linked symbol.

| Address | Bytes | Before | After | Target and link register |
| --- | --- | --- | --- | --- |
| `01020b62` | 4 | `ffe303f8` | `08e01575` | `h1e_vad_native_poll_bridge` `0112f58c`, LR `01020b66` |
| `01021054` | 2 | `4030` | `6030` | `movi r0,96` |
| `0102105c` | 2 | `00b5` | `c36d` | `mov r7,r0` |
| `0102106a` | 2 | `0095` | `1f6c` | `mov r0,r7` |
| `01021070` | 4 | `403ce30f` | `08e0c274` | `late_publication_stub` `0112f9f4`, LR `01021074` |
| `0102109e` | 2 | `4032` | `6032` | `movi r2,96` |
| `010210a8` | 2 | `e095` | `df6d` | `mov r7,r7` |
| `010210de` | 2 | `6095` | `df6c` | `mov r3,r7` |
| `0103907a` | 4 | `07e08194` | `07e04fb4` | `console630_response_hook` `0112f918`, LR `0103907e` |
| `0103a996` | 4 | `07e0cf87` | `07e09da7` | `console630_parser_hook` `0112f8d0`, LR `0103a99a` |

The six constructor halfword edits are the same bytes as in the CK803 and earlier CK802 builds. The four `bsr` words match the earlier CK802 build, since all addresses are unchanged. Copying the whole `.constructor_edit` section over firmware would overwrite constructor code, so a future patch builder must take only these hunks.

## Inputs, before and after

`check-inputs.py` (the copy in `native-ck802-candidate/`, unchanged) hashes the same 36 files as `native-link-candidate/build-offline.sh` and compares them with `accepted-inputs.json`. Before the build: 36 of 36 match, nothing changed or added. After the build: 36 of 36 match, and the recipe asserts the two hash sets are equal. The pinned frozen image hash and the four imported upload and restore addresses are asserted too. The earlier outputs I re-hashed after the build are unchanged: the CK803 and CK802 ELFs and `native-ck802-candidate/REPORT.md`.

The libgcc archive and the two extracted members are linker inputs outside those 36, pinned above. The receipt is written before the sparse export. This second-run receipt includes the manifest retained from the first run; its hash matches the current manifest. That ordering is not a fresh post-export receipt. The current manifest hash is also listed below.

## Repeat the build

From WSL:

```
cd research/rea/completion630-lab/hardware-vad-trace/native-ck802-candidate/sdk-profile
./build-sdk-profile.sh
```

It writes only `output/` and stops with exit 3 if a pinned input changed. The run behind these numbers is the second one. The first run passed too, and the second overwrote its files.

## Hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `build-sdk-profile.sh` | `b333cd3e755f70d058b1f9522d6b7d7823a2ec0aca9738191c27ced69533c916` |
| `export-sparse-hunks-sdk.py` | `760fc056cff09ddc0f9b804fed35867196bf69d100ae32b02e922906b00c5aac` |
| `enum-probe.c` | `558bf3d5998a1c689810c779d9c587c3385db2f8e405cc4eccd37833c9b93e97` |
| `output/conditional-source-ck802-sdk-NOTINSTALL.elf` | `576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366` |
| `output/candidate.map` | `6acf9fe371f4495d56283ee5f9003413bee99bcde2e81dc18f55206c5657b967` |
| `output/candidate.objdump.txt` | `12a34576dffc88be31c91aa2263f079dfd83e0a94551f6f363bccd476a1ff03d` |
| `output/sections.txt` | `f532f641fb0672f5886d9badb23ba821d65323c8caaf263cd0394988bde28b52` |
| `output/symbols.txt` | `9765956593197cbe01db81b88bdf00a7bf1e327027d4d9d53dd7d47ad501c90d` |
| `output/size.txt` | `282dba17512498061684f0a6f153ff1f9a9afb43f025e9035b73a6159463f8d8` |
| `output/enum-probe.txt` | `591a9bdabb363593085ce5348431e64af83f94acadaf648374be5b0972b2b1d3` |
| `output/compile-commands.txt` | `97a1ef2bd96b0f013348f8214dc603755761011ae0d0d0f37d86e883c4380d10` |
| `output/link-receipt.json` | `7458d9c8c9e755753e252274f23cf5649a949515f71d98ab40fc0dd8d9e77a86` |
| `output/sparse-source-hunks.json` | `73ce3d0889955701b2a7874e91cd653f30439054a5b3f1e273b4327aeed3ed35` |
| `output/libgcc-members.sha256` | `3c5c84a6456c3db4b64b986add543752ca0a1e07cb4997ad0bc081e7fd1af40c` |

## Not shown

- This is compiler-profile parity. Nothing was run on a CK802 or anywhere else, and the assembler accepting an instruction does not show the target executes it.
- The constructor keeps its private pointer in `r7` across the zeroing wrapper, the GPIO lookup, logging and an indirect method. That relies on `r4` to `r7` being preserved by callees I have not read. A clean build cannot close it.
- Delayed publication, object lifetime, CPU ordering, the startup order and the hook placement stay asserted by the macro and are not target-qualified.
- I did not bisect the four flags, so the single code change is attributed to the enum width by inspection only.
- No `delivery-gate` pass, no adversarial review, nothing committed.
- Outside the project, WSL `/tmp` still holds small files from earlier phases (`h1e_ck802_*`, `h1e_nlc_*`, `h1e_npc_*`). This phase wrote none there.
