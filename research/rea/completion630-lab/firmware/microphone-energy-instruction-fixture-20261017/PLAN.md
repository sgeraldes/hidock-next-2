# SYS instruction fixture — preparation only

This owned folder contains a pinned builder and one verified output. The output is an emulator-import fixture marked `NOTINSTALL`; it is not an OTA, installable SYS, or mapped firmware image.

Inputs are pinned in [input-pins.json](input-pins.json): the exact 393998 base SYS, final r5-dispatch-fix5 ELF, and the matching integration manifest. The ELF is consumed by parsing its ELF32 little-endian section table and copying only the seven named `SHF_ALLOC` sections. No whole-file `objcopy` is used.

The builder will verify manifest preimages before applying exactly two constructor immediates and three BSR call-site sections. It will add the module's `.voice_energy_text` and `.voice_energy_rodata` only inside `[0x01137000, 0x01137800)`. Appended bytes not occupied by those sections will be explicitly filled with `0xff`. It rejects hash/size drift, unexpected or overlapping allocated sections, nonzero `SHT_NOBITS`, out-of-window module content, and any base-image difference outside the five manifest-pinned patch ranges.

The original 48-byte header/version prefix is pinned and checked byte-for-byte. The receipt will include input/output hashes and sizes, section and patch ranges, exact preimage/postimage bytes, `0xff` padding ranges, and an inverse recipe. The builder self-checks that truncating to the original base size and restoring the five preimages reconstructs the exact pinned SYS.

The final SYS/mapper/boot relationship, VMA reservation, container composition, OTA metadata, and CRC remain unresolved and are intentionally outside this fixture. No emulator, device, USB, flash, or Git operation is part of this work.

## Build and readback result

After parent review, `build_instruction_fixture.py` ran once. It produced `out-INSTRUCTION-FIXTURE-NOTINSTALL/instruction-fixture-393998-voice-energy-NOTINSTALL.bin` (1,275,904 bytes; SHA-256 `cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482`). Its receipt records the five byte patches, the two module sections, explicit FF padding, and inverse recipe. A separate readback verified the output hash/size, unchanged header, FF ranges, module section hashes, and byte-for-byte reconstruction of the pinned base SYS (1,237,504 bytes; SHA-256 `f2e391ca2c895c1d34e1a49639d00571a18418886a25d4200247875cf86a4c3e`). This verifies artifact construction only; it does not establish emulator execution or installability.
