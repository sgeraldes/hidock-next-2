# 393990 router-tail-only VAD source link

Status: **offline candidate only; not composed, installed, or hardware-qualified.** The single router-only build linked the accepted C and assembly inputs with CK802 SDK flags, function/data sections, LTO, and linker garbage collection.

## Measured result

The linked `.router_tail` is **1,088 bytes (`0x440`)** at `0x01128a40`. It fits the proposed 1,472-byte router window through `0x01129000`, leaving **384 bytes**. This removes the former 440-byte console-tail allocation entirely: the ELF has no `.console_tail` section. The dispatcher still forwards non-F11A traffic to the pinned current console functions at `0x0112b70c` and `0x0112b800`; those are runtime calls into the existing console, not module placement there.

Total ELF text is 1,240 bytes, including the 1,088-byte module, the 140-byte constructor edit section, and three 4-byte native hook sections. `.data` and `.bss` are zero, and the undefined-symbol list is empty. The final ELF records CK802 architecture/CPU and ISA flags `0x2806`.

All four assembly patch roots were retained: parser hook `0x01128dbc`, response hook `0x01128e04`, poll bridge `0x01128dba`, and constructor publication stub `0x01128e64`. The ten source hunks total 28 instruction bytes. Readback decodes each linked branch to its named target and verifies the exact current 393990 preimages; eight also match the older 393988 preimages. The complete proposed router window remains pinned as `0xff` in the baseline. These are byte-layout facts, not an ownership grant.

The C sources retain the SDK flags and add `-ffunction-sections -fdata-sections -flto`; the GCC link driver uses its LTO plugin and `--gc-sections`. This is a recorded compiler-profile deviation. The three assembly inputs retain the earlier `-mcpu=ck802` invocation.

## Artifacts

- `output/vad-router-only-393990-NOTINSTALL.elf` — ELF SHA-256 `e8fd8989230b3f451dda347daa456357715f43a23b84173b43f2d632f3d4b322`.
- `output/module-vad-router-tail.bin` — exact `.router_tail` export, 1,088 bytes, SHA-256 `dee15f03852cd8481c9982bcb4fe5d42dbf5312b3b812ebdb2da1cba0af21491`.
- `output/sparse-source-hunks-393990.json` — strict current-system preimage and branch-target manifest.
- `output/layout-readback.json` and `output/module-export-readback.json` — section size, bounds, data/BSS, root, and export readback.
- `output/input-pins-before.json` and `output/input-pins-after.json` — 36 accepted source pins and additional baseline, console, router, linker, and build inputs; the build verified they are byte-identical.
- `output/router-only.map`, `output/objdump.txt`, `output/sections.txt`, `output/symbols.txt`, `output/undefined.txt`, and `output/link-output.txt` — link and ABI evidence.

No SYS image was generated or changed, and no install, device query, or hardware test was performed. The proposed router-tail reservation and ownership remain unaccepted, so this output is for review before any composer consumes it. No old host-dispatch or codec suites were rerun.
