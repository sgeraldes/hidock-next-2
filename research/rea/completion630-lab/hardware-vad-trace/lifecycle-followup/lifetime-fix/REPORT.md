# Constructor lifetime fix audit

## Result and scope

The source-only constructor proposal remains viable for review. It changes the allocation and clear size from `0x40` to `0x60`, keeps the returned pointer in callee-saved `r7` while the object is cleared, publishes it after the clear, and detaches the state slot before the failure-path free.

The cleanup reorder changes ten bytes at `[0x01021074, 0x0102107e)`. The following `subi r4,1` at `0x0102107e` and branch at `0x01021080` remain unchanged. Thus the cleanup path from the free call through that branch spans twelve bytes `[0x01021074,0x01021082)`, while the rewritten byte window is ten bytes.

No firmware image was patched, generated, or built, and no hardware was used. The assembler/linker work below is limited to isolated instruction snippets saved in this folder.

The pinned official image is `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`, load base `0x01000000`. Direct comparison of the 324-byte constructor-and-literal span at `0x01021024` against the frozen offline 393988 candidate (`system-decoded-NOTINSTALL.bin`, SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`) found byte-for-byte equality; both span SHA-256 values are `1bd6c09f9d15e6095cc11104930b0dd8418594807a845ce516f9ce52955794dd`. This is source-image parity, not an attestation of installed-device bytes.

## Constructor instruction map

Addresses are image virtual addresses. `r5` is the constructor's state-slot address register; prior lifecycle evidence resolves the slot to RAM `0x852c0`.

| Address | Current encoding and instruction | Proposed encoding and instruction | Effect |
| --- | --- | --- | --- |
| `01021054` | `4030` — `movi r0,0x40` | `6030` — `movi r0,0x60` | Allocates 96 bytes. |
| `0102105c` | `00b5` — `st.w r0,(r5,0)` | `c36d` — `mov r7,r0` | Holds the result privately while preserving the allocation-null compare flags for `bt 0102109e` at `0102105e`. |
| `0102109e` | `4032` — `movi r2,0x40` | `6032` — `movi r2,0x60` | Clears 96 bytes. |
| `010210a8` | `e095` — `ld.w r7,(r5,0)` | `e0b5` — `st.w r7,(r5,0)` | Publishes the saved pointer after the zeroing wrapper returns. |

The instruction forms and bytes above were confirmed with the isolated C-SKY assembler and linker. `constructor-edit-encodings.s/.o/.elf/.objdump.txt` links the four forms sequentially at `0x01021054` as an encoding check; it is not a reconstructed constructor function. The linked raw bytes are `6030 c36d 6032 e0b5`, and disassembly matches the four proposed instructions.

The zeroing call at `010210a4` is to copied-RAM wrapper `0x0008009e`. Startup evidence maps it to source address `0x0111532e` / file offset `0x11532e`; pinned bytes begin `D0 14 A4 33 62 43 61 93 CD 7B 90 14`, and the wrapper uses `r3`, not `r7`. The wrapper dispatches through a ROM table; its final callee was not recovered. The proposed `r7` live range crosses only this wrapper. The C-SKY V2 ABI preserves `r4-r7` across calls, and the existing constructor also relies on `r7` surviving the later call at `010210b0` before using it at `010210b6`. Therefore this change assumes the ROM table target obeys that ABI; direct inspection of that target is unavailable.

`mov r7,r0` does not set condition flags, so the existing `bt 0102109e` still uses the null comparison at `0102105a`. The wrapper receives the unchanged `r0` pointer and existing zero/size arguments.

## Failure-path detach-before-free reorder

The current sequence loads the pointer from the state slot at `0102106a`, tests it for null, and tests the pending return value. Only the guarded nonzero/error path reaches the free call. The current slot clear occurs after free, leaving the pointer visible in the slot during the free call.

The existing instruction map in `01021024.tsv` shows these original boundaries:

| Address | Original bytes | Original instruction |
| --- | --- | --- |
| `01021074` | `01e0f6c8` | four-byte `bsr 0105a260` |
| `01021078` | `0033` | `movi r3,0` |
| `0102107a` | `0034` | `movi r4,0` |
| `0102107c` | `60b5` | `st.w r3,(r5,0)` |
| `0102107e` | `002c` | `subi r4,1` |
| `01021080` | `dd07` | `br 0102103a` |

The replacement for the ten bytes `[01021074,0102107e)` is:

| Address | Proposed bytes | Proposed instruction |
| --- | --- | --- |
| `01021074` | `0033` | `movi r3,0` |
| `01021076` | `60b5` | `st.w r3,(r5,0)` |
| `01021078` | `01e0f4c8` | `bsr 0105a260` |
| `0102107c` | `0034` | `movi r4,0` |

The standalone C-SKY object `cleanup-reorder.o` was linked using `ld -Ttext=0x01021074 --defsym=native_free=0x0105a260`. `cleanup-reorder.objdump.txt` shows the linked `.text` bytes `0033 60b5 01e0f4c8 0034` and disassembles the call at `01021078` to exactly `0105a260`. The `subi` at `0102107e` and branch at `01021080` are outside this isolated ten-byte snippet and remain unchanged in the proposal. The retained constructor TSV contains no branch target inside `[01021074,0102107e)`; control falls through the replacement window, then executes the existing subtract and branch.

The free argument stays in `r0`, loaded at `0102106a`; `movi` and `st.w` use `r3` and leave it intact. The return register is still set to `-1` by the existing `movi r4,0` at `0102107c` followed by the unchanged subtract at `0102107e`. The null and zero-return guards and the branch target are unchanged.

## Conditions still unresolved

- Delayed publication prevents readers from seeing the allocation's pre-clear contents. It publishes a zeroed object before the constructor writes byte `+2`, invokes `0108e250`, and stores that result at `+8`; the proposal does not prove the object is fully ready at publication. A reader needs a verified readiness/state protocol or later publication placement.
- Every user of slot `0x852c0` and the object layout must agree with extending allocation/clear from `0x40` to `0x60`. This audit does not establish all consumers or allocator limits.
- Detaching blocks a fresh slot lookup from seeing the freed pointer after the store, but does not revoke a pointer already copied by a concurrent reader. A matching reader/free synchronization or lifetime guarantee remains necessary.
- The only bounded free found here is the constructor failure path. Successful teardown, shutdown ownership, and later slot clearing remain unproven.
- The frozen 393988 `NOTINSTALL` comparison is offline image parity; it does not identify the bytes running on a physical device.

## Evidence

- Constructor instructions and decompilation: `research/rea/protocol-depth630-lab/audio-host/native/01021024.tsv` and `.c`.
- Exact byte-span parity: `research/rea/completion630-lab/hardware-vad-trace/cache-bridge-candidate/binding-source-parity.json`; raw bytes were independently compared for this audit.
- Startup-copy range and `0x8009e` mapping: `research/rea/completion630-lab/hardware-vad-trace/reader-provider-followup/ram-initializer/REPORT.md`.
- Assembled encoding check: `constructor-edit-encodings.s/.o/.elf/.objdump.txt`; `publish-store.s/.o/.elf/.objdump.txt` confirms the `e0b5` store at `010210a8`.
- Linked cleanup reorder: `cleanup-reorder.s/.o/.elf/.objdump.txt`.
- Toolchain: T-Head C-SKY ABI-v2 package from the [T-Head OSS-hosted tool archive](https://occ-oss-prod.oss-cn-hangzhou.aliyuncs.com/resource/1356021/1619529111421/csky-elfabiv2-tools-x86_64-minilibc-20210423.tar.gz); GNU Binutils 2.27 `csky-elfabiv2-as`, `ld`, and `objdump`. Downloaded archive SHA-256: `8b9a353c157e4d44001a21974254a21cc0f3c7ea2bf3c894f18a905509a7048f`.
- ABI reference: [C-SKY V2 Applications Binary Interface Standards Manual](https://github.com/c-sky/csky-doc/blob/master/C-SKY_V2_CPU_Applications_Binary_Interface_Standards_Manual.pdf), which specifies `r4-r7` as callee-saved.
