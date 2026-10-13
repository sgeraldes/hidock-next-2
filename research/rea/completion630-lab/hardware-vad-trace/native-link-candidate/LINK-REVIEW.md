# Conditional offline link review

Reviewed 2026-10-13. The ELF-only source link passed the requested bounded integration checks. This review does not qualify an installed image, live device, or hardware behavior.

## Result

The linked ELF connects the three fixed call sites to the expected poll, parser, and response wrappers. It places the source modules at the example base `0x0112f000`, after the frozen upload and restore reservations, and the linked constructor edits contain all seven expected instruction encodings, including the private-pointer reload at `0x010210de`. The imported upload and restore function aliases retain their frozen addresses. The map and section table show no writable `.data` or `.bss`; the linked symbol table has no undefined entries.

This is a conditional offline source link only. The accepted-input manifest says `conditional_source_only_not_target_qualified`; hardware qualification and release approval are false. The ELF is named `conditional-source-NOTINSTALL.elf`; no firmware image was generated or installed.

## Link evidence

The linked hook instructions and their resolved destinations are:

| Fixed site | Instruction and destination | Linked symbol |
| --- | --- | --- |
| `0x01020b62` | `e008752f`, `bsr 0x0112f5c0` | `h1e_vad_native_poll_bridge` |
| `0x0103a996` | `e007a7b3`, `bsr 0x0112f8fc` | `console630_parser_hook` |
| `0x0103907a` | `e007b465`, `bsr 0x0112f944` | `console630_response_hook` |

The final `.vad_text` section is `0x0112f000` through `0x0112fa2b`, size `0xa2c`, with executable/read-only `AX` flags. It begins exactly after the frozen restore reservation ending at `0x0112f000`; the earlier illustrative `0x0112c000` address is not used because that range overlaps upload text. The actual image memory map and any future placement remain unqualified.

All seven constructor instruction encodings are present at their expected patch addresses:

| Address | Encoding | Effect |
| --- | --- | --- |
| `0x01021054` | `3060` | `movi r0, 96` |
| `0x0102105c` | `6dc3` | `mov r7, r0` |
| `0x0102106a` | `6c1f` | `mov r0, r7` |
| `0x01021070` | `e008749a` | `bsr 0x0112f9a4` (`late_publication_stub`) |
| `0x0102109e` | `3260` | `movi r2, 96` |
| `0x010210a8` | `6ddf` | `mov r7, r7` |
| `0x010210de` | `6cdf` | `mov r3, r7` |

The linked success stub stores `r7` through `r5`, then jumps to `0x01021038`; the failure branch jumps to `0x01021074`. The failure path therefore continues at the original free sequence with `r0` loaded from the private pointer, while publication occurs only on the zero-status path.

The linker aliases remain at the frozen addresses: `upload630_parse=0x0112c2c4`, `upload630_response=0x0112ca1c`, `restore630_parse=0x0112d7d8`, and `restore630_response=0x0112e162`. The build recipe pins the frozen decoded image and symbol map and asserts these values before linking.

The section table and map show `.data` and `.bss` sizes of zero. No writable globals were introduced. The link recipe checks `nm -u` is empty, and the final `symbols.txt` contains no undefined-symbol entries. The run's `input-hashes.json` contains 36 pinned inputs; the recipe compares these before compilation and after linking. I also checked that all 17 files listed in `link-receipt.json` still match their recorded SHA-256 values.

## Patch-format and release limits

The `.constructor_edit` ELF section is one contiguous `0x8c`-byte `PROGBITS` region from `0x01021054` to `0x010210df`. The source uses `.org` to position seven changed instructions, so the intervening bytes in that section are zero-filled (`00`, decoded as `bkpt`), not sparse patch records. This is harmless in the current non-installable ELF, but a future patch builder must emit only the reviewed instruction hunks at their exact addresses. Copying the entire `.constructor_edit` section over firmware would overwrite the intervening constructor code and is unsafe.

The following still limit any target release: the object allocation must really be 0x60 bytes and remain live while guarded readers use it; the constructor and normal C-SKY r4-r7 callee-save assumptions must hold; no teardown, indirect consumer, interrupt, other core, or DSP path may invalidate or observe partial publication; and CPU ordering beyond the same-core PSR interrupt guard is unqualified. The source link does not establish a live endpoint selection, target image identity, or hardware response. The working-day restriction still prohibits hardware testing, reset, flash, or teardown without new explicit user approval.

## Pinned artifacts

| Artifact | SHA-256 |
| --- | --- |
| `output/conditional-source-NOTINSTALL.elf` | `0cc0c025c7d3ff03eef22c2858d0a15efb716522119d8dc6672a3386e341dd65` |
| `output/candidate.map` | `2d125737b812071c509aba8c05d7d1dddc2719eda8486e2b560948e05c04980b` |
| `output/candidate.objdump.txt` | `2035d9756f61f905975ae4c179d992a57d5c40bbc06e952b01affa36e49b537a` |
| `output/sections.txt` | `c80507e04416a0650099d4b440bc0a3a386d95c4b1b16f76f31eb03c1cc80795` |
| `output/symbols.txt` | `34d4739ed6a5ca511af2808be961cf57e69ce5e8149944002dbb916ca9435130` |
| `output/link-receipt.json` | `0c3008bd3950fb7d666c88fbb434861ffa7ff1c4631a460005c68a9d809814fd` |
| `output/input-hashes.json` | `a37bd3589c5b6548b057a479add3bbafe88c850da379eed3d48fd1e094bd03b6` |
| `accepted-inputs.json` | `508ad95a830b26413c16b7352ec955c030d2ecdffa748ac94459880785c251e3` |
| `build-offline.sh` | `0c80274ebbf8a23035c1086cf31fbb1ef419d9c8fcfe71574ea769d37f271e23` |
| `module.ld` | `b3e26eb9ff6e2f64c216dfb6915f601e70abb29a2ec4118ed7dd93a0afce8ab3` |

The `link-receipt.json` fields explicitly say `hardware_tested: false`, `firmware_image_generated: false`, `installed: false`, and `release_approved: false`.
