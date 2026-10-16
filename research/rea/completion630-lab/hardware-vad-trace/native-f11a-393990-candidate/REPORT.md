# CK802 F11A-only dispatcher for 393990

Status: conditional source candidate. The SDK-profile link and focused host routing checks passed. The module is not applied to a SYS, and no target, emulator, partition-capacity, boot, or physical qualification is claimed.

## Pinned result

| Artifact | Result |
| --- | --- |
| Current decoded SYS input | SHA-256 `abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360`, 1,237,504 bytes |
| Current console ELF input | SHA-256 `105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee` |
| Linked ELF | `output/f11a-393990-ck802-sdk-NOTINSTALL.elf`, SHA-256 `8cdf67a3d019a206296207817ab55f18477e88ea96fcf611d10fa7a563b744e8` |
| Linked module section | `output/module-vad-text.bin`, 1,860 bytes (`0x744`), SHA-256 `c9f402200c48a278c997b8ac9e568b811d256994129798418cfc16a6adc8e472` |
| Sparse source manifest | `output/sparse-source-hunks-393990.json`, SHA-256 `a0568b6555111d272786ace658a41835291cb4d4bae10db37dcab4bc1539d01c` |
| Link receipt | `output/link-receipt.json`, SHA-256 `6bb86eb9ac91d376f21cfa98c1a8dc62af903977d0b6844640692092a7baa686` |
| Module-section export receipt | `output/module-export-readback.json`, SHA-256 `35aa0e8619735f33e344de7a6a28eacc93f978788f0c6f0b232640a388d6de65` |

The build’s existing CK802 acceptance check matched all 36 pinned VAD source inputs. The new build-input receipt captured 52 inputs before and after the link; both JSON files are byte-identical. This includes the exact current SYS, current console binary/ELF/symbols/source, the previous CK802 VAD inputs, the 393990 lifecycle-closure report, and the new dispatcher sources.

## Dispatcher behavior

The new [f11a_console_dispatch.c](f11a_console_dispatch.c) defines the entry points expected by the pinned `generation-restore4/console-hooks.S`, without copying the older bundled console implementation. For parsing, it reads the 32-bit head pointer from `frame + 0x14`, resolves the head, and reads the command bytes at head offsets 2–3. A null frame or unresolved head returns `-1` without calling a handler. F11A calls the existing `vadt_f11a_parse`; every other valid command forwards the original frame/body/length to current 393990 `console630_parse` at `0x0112b70c` and returns its result unchanged.

For responses, a null frame returns `-1`; F11A calls the existing `vadt_f11a_response` with `h1e_vad_snapshot_read` and a null context. Every other command forwards the original frame to current `console630_response` at `0x0112b800` and returns that result unchanged. The linked disassembly confirms direct calls to both exact current addresses. This retains current F117 vector/help/version/uptime handling, F118 upload, F119 restore, and the other current router commands, including F114.

The focused test compiles this same dispatcher C file for the host, then uses stubs for the current console and VAD handlers. It ran 31 checks with zero failures. It exercised F117 and F114 forwarding for parse and response, F11A routing, exact argument and callback forwarding, result propagation, output mutations, null frames, and unresolved parser heads. It verifies the dispatch boundary only: the test does not run the VAD core or current firmware console code.

## CK802 link and hook manifest

All eight C units use the same SDK profile: `-std=c99 -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks -Wall -Wextra -Werror`, with the existing delayed-publication compile assertion. The seven reused VAD units are the core, binding, C-SKY guard, frame core/target, native poll bridge, and native loader. The eighth unit is the new dispatcher. The previous `console630_f11a.c` is not linked. The new dispatcher has no decimal/version formatter dependency, so no libgcc member is linked; the final ELF has no undefined symbols.

The three assembly inputs use `-mcpu=ck802` only, matching the earlier SDK-profile recipe; full assembler flag parity is not claimed. The ELF records C-SKY CPU `ck802` and ISA flags `0x2806`. Its `.vad_text` is 1,860 bytes at the example address `0x0112f000`. Total `size` output is 2,012 text bytes, including the 140-byte constructor edit section and three four-byte hooks; `.data` and `.bss` are both zero. The linker’s 16 KiB ceiling is only a build bound.

The strict manifest compares against the exact 393990 decoded SYS. Eight old 393988 preimages still match. The parser and response sites are already changed in 393990, so the manifest uses their current preimages (`07e06188` at `0x0103a996`, `07e01395` at `0x0103907a`) and new branch encodings that decode to the new wrappers (`0x0112f660`, `0x0112f6a8`). The other eight constructor/poll preimages match. It lists ten instruction hunks totaling 28 bytes; 124 bytes of constructor-section padding are excluded. There is no composed system image in this folder.

## Layout and remaining proof

The module’s `0x0112f000` link address is hypothetical. The pinned linker script places parser, upload, and restore reservations through `0x0112f000`; it does not reserve the following range for this module. The current console reservation has 907 bytes after its 3,189-byte live module, while this reduced module has 1,860 bytes of `.vad_text`. It therefore does not fit that known tail, and no no-growth result was achieved.

The current `fw0_sys` XML size (`0x12e200`) is the existing file length, not a maximum. The current package directory has zero load/run addresses, and the SYS header’s body/tail lengths and checksums are zero. No retained target-specific H1E/ATS2853P2 SYS maximum extent is established, so placement and capacity remain open. A matching authoritative partition map or bootloader limit is still required. The separate 393990 lifecycle closure (SHA-256 `ce9cb855903625550781038a14dfdc2a677f57b7cc40dc1316a8908b0f22ff94`) supports carrying forward the 96-byte allocation/zeroing and success-only publication. The bounded lifetime contract remains one successful publication, no free/replacement during operation, and a future teardown that stops/drains consumers; it is not an exhaustive ROM or physical proof.

The build and extraction commands are `bash build_candidate.sh` and `bash extract_module_text.sh` under WSL. The former links once and runs the focused host test. The latter exports only the linked `.vad_text` section; it does not alter the ELF or compose an image. No image was assembled, and no hardware operation was performed.
