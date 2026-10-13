# VAD firmware integration: offline decoded candidate (NOTINSTALL)

Coding session. One new decoded system image, built offline by a fail-closed script from the frozen 393988 baseline and the accepted CK802 SDK-profile VAD module, then read back from disk. No container, OTA, version change, flash, USB, hardware, app, provider call, Git or publication. Nothing outside this folder was edited, and the baseline, the SDK profile and the original firmware worker's builders were only read.

The candidate is blocked for installation. The gates are listed at the end. Nothing here shows that the image boots, that `0xf11a` answers, or that the recorded word means anything about speech.

## Result

| Item | Value |
| --- | --- |
| Output | `output/system-decoded-vad-ck802-NOTINSTALL.bin`, 1,243,776 bytes (`0x12fa80`), SHA-256 `ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0` |
| Baseline | `generation-restore4/system-decoded-NOTINSTALL.bin`, 1,237,504 bytes (`0x12e200`), SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`, unchanged |
| Changed bytes in the baseline region | 22, all inside the ten approved hunks (28 hunk bytes, six of which keep their old value). 0 outside |
| Appended | 6,272 bytes: 3,584 zero bytes (`0x0112e200` to `0x0112f000`), the 2,684-byte module, 4 zero bytes of 32-byte alignment padding |
| Module | `.vad_text` copied from the ELF to `0x0112f000..0x0112fa7c` |
| Header and integrity | inner header bytes 0 to 47 identical, no length or checksum field to update (see below) |
| Builder run | one execution, exit 0, plus the 7 rejection checks |

## Files and hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `build_candidate.py` | `d230681b388d0f25436b64fa391667140f2c6fe8cfa00b7dda74eceac974234b` |
| `reject_checks.py` | `3f85f599783f8c99646253a59cb2b97a0df77b432a645faa4057d4eaec150648` |
| `rejection-checks.json` | `645f2256f162acfb27e70b3e1039cfdf27b066034bd187928c0a7f73d87aec25` |
| `output/acceptance-readback.json` | `551da1308d6791bd92d1d143f16494015e53efe18a2fbde1708c03722d41c84b` |
| `output/readback-listings.txt` | `73e58af2a614cd01a1c259542b0f5e9c2c5907e0fe86321036623ac9e4710fae` |
| `output/system-decoded-vad-ck802-NOTINSTALL.bin` | `ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0` |

Pinned inputs, each hashed before any use (a mismatch stops the build with `PIN_MISMATCH:<name>`):

| Input | SHA-256 |
| --- | --- |
| Frozen baseline image | `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f` |
| Frozen `symbols.txt` | `a850bd25db4bab4c7e16b58c6ac5d5241c156a3fabde18aa187f167e09641e72` |
| Frozen `module.ld` | `90d5bc9c11850b87d123fb5eb51589645feea4a15d5cccc5896a8f9fd245840f` |
| SDK ELF | `576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366` |
| Sparse manifest (10 hunks, 28 bytes) | `73ce3d0889955701b2a7874e91cd653f30439054a5b3f1e273b4327aeed3ed35` |
| SDK `symbols.txt` | `9765956593197cbe01db81b88bdf00a7bf1e327027d4d9d53dd7d47ad501c90d` |
| SDK `link-receipt.json` | `7458d9c8c9e755753e252274f23cf5649a949515f71d98ab40fc0dd8d9e77a86` |
| `decode_randomizer.py` (header decoder) | `3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5` |
| Toolchain `csky-abiv2-elf-objdump` (readback listing) | `e6aad5acbaf952d53ed470878b95acfcffeca7c4e001fe7bbf1c0dce4fd07cdd` |

The libgcc archive (`f0f80000...40f3`) and its two linked members are recorded in the SDK receipt and in the acceptance manifest. This builder does not link anything, so it reads them only as metadata. After the run I re-hashed the baseline, the SDK ELF and the sparse manifest. All three are unchanged.

## What the builder does

Order, with every step before the first byte of the output is created:

1. Pins. All inputs above must match.
2. The manifest must be the unapplied CK802 manifest, bound to this baseline hash and this ELF hash, and its ten hunks must equal the ten hunks written into the builder (address, width, role, before, after, target symbol). The totals must be 28 bytes and 124 excluded padding bytes.
3. The ELF must be little-endian ELF32, machine C-SKY, tagged `ck802`. Its allocatable sections must be exactly `.vad_text`, `.constructor_edits`, `.poll_hook`, `.parser_hook` and `.response_hook`, so there is no `.data` or `.bss`.
4. `.vad_text` must be 4-byte aligned and linked at `0x0112f000`. Capacity is the 16,384-byte limit from `module.ld`. The module must not overlap the baseline image, which ends at `0x0112e200`, or any of the frozen parser, upload and restore reservations read from the frozen `module.ld`, and no hunk may lie inside the module or those reservations. The result must stay under `0x200000`. That limit is the bound the existing container verifier uses. It is not the flash partition size.
5. The inner header must carry zero header sum, body sum, body size and tail size (details below). Otherwise the builder refuses, because it has no rule to update them.
6. Each symbol the hooks branch to must be defined once in the ELF symbol table and must agree with `nm` output. The four imported upload and restore aliases must equal the frozen addresses.
7. Every hunk is checked against the baseline preimage and against the ELF bytes. The 124 constructor padding bytes must all be zero, and they are never copied.
8. Each four-byte `bsr` is decoded from its raw bytes and must land on its linked symbol.

Only then does it assemble the result in memory, write it to a `.partial` file created with exclusive-create (so it cannot overwrite), read that file back (next section), and rename it to its final name. A failed readback renames the partial file to `.REJECTED` and exits nonzero. The manifest and the listing file are exclusive-create too. Any existing output stops the run with `OUTPUT_EXISTS`.

## Readback from the file on disk

The readback reads the produced file again and does not trust the in-memory buffer.

| Check | Result |
| --- | --- |
| Length | 1,243,776, a multiple of 32 |
| Baseline region diff | 22 differing bytes; each falls inside an approved hunk (per hunk: poll 4, allocate 1, retain 2, failure pointer 2, decision 4, clear 1, reload 2, GPIO object 2, response 2, parser 2) |
| Revert test | putting the baseline bytes back into the ten hunks restores the exact baseline hash |
| Appended region | zero gap, then the module bytes equal the ELF `.vad_text`, then zero padding |
| Audio, upload, restore, listing and every other baseline byte | identical to the baseline; they all lie outside the ten hunks |

Header and integrity handling. The inner header at offset 0 decodes through the pinned `image_header` as: name `sys`, version 1, header size 48, entry `0x0106e26c`, and header sum, body sum, body size and tail size all 0, which that decoder reports as an unchecksummed header. Bytes 0 to 47 are identical before and after. There is no stored length or checksum in this layer, so no update was made and none is claimed. I also scanned the baseline for four little-endian 32-bit values (its own length, the end address, the restore module end offset and end address) and found none. That scan is limited and is not proof that no length is stored elsewhere.

The container layer is separate and not touched. `build_containers.py` writes the system size and CRC32 into `ota.xml`, recomputes the container CRCs and FVER, and pins the old system hash, so it would refuse this image. I did not call it or edit it.

Branches. Decoded three ways (Python from the raw file bytes, `objdump` on the produced file, and the ELF symbol address), all agree:

| Site | Raw file bytes | Link register | Target | Baseline target |
| --- | --- | --- | --- | --- |
| `01020b62` poll | `08e01575` | `01020b66` | `h1e_vad_native_poll_bridge` `0112f58c` | `0101fb68` (the native getter) |
| `01021070` decision | `08e0c274` | `01021074` | `late_publication_stub` `0112f9f4` | none: the baseline held `cmpnei r4,0; bf 0x01021038`, checked by the builder |
| `0103907a` response | `07e04fb4` | `0103907e` | `console630_response_hook` `0112f918` | `0112b97c` (the frozen hook) |
| `0103a996` parser | `07e09da7` | `0103a99a` | `console630_parser_hook` `0112f8d0` | `0112b934` (the frozen hook) |

The raw bytes are file order. The objdump listing in `readback-listings.txt` prints some 32-bit words with the halfwords swapped, and prints literal-pool data as instructions, so the listing text is not the bytes. The readback does not use the listing text for the bytes.

The poll bridge loads one literal into `r1`. The word at that literal address in the produced image equals `0x0101fb68`, the baseline call target, so the bridge calls the same native getter once with the caller's pointer in `r0`.

Constructor, tail size and success and failure branches, from the produced image:

| Item | Result |
| --- | --- |
| Allocation | `movi r0,64` became `movi r0,96` at `01021054` |
| Clear | `movi r2,64` became `movi r2,96` at `0102109e` |
| Telemetry tail | `object+0x40..0x5f`, 32 bytes, ends exactly at the 96-byte allocation; the offset is 4-byte aligned. The base alignment depends on the allocator and is not verified |
| Private pointer | `mov r7,r0` at `0102105c`, `mov r0,r7` at `0102106a`, `mov r7,r7` at `010210a8`, `mov r3,r7` at `010210de` |
| Stub at `0112f9f4` | `cmpnei r4,0`; `bt` to the failure leg; success leg `st.w r7,(r5,0)` then `lrw r15,0x01021038`, `jmp r15`; failure leg `lrw r15,0x01021074`, `jmp r15` |
| Stub literals | the words in the image at the two literal addresses are `0x01021038` and `0x01021074` |
| Success target | `01021038` is `movi r4,0`, bytes unchanged from the baseline |
| Failure target | `01021074` is the free `bsr`, bytes unchanged. The stub does not write `r0`, which holds the private pointer from `mov r0,r7` |
| Allocation failure | `r7` is 0, so the unchanged null check at `0102106c` exits before the stub: no free and no publication |
| Sites `0102105a`, `0102105e` | unchanged |

The stub overwrites `r15` with `lrw r15,...; jmp r15`. The constructor saved `r15` on entry with `push r4-r7, r15` and restores it on exit, so the clobbered value is not used for return. I read this from the baseline listing and did not execute it.

## Rejection checks (`rejection-checks.json`)

Each case tampers with one input in memory and recomputes pins and bindings, so that the pin check passes and the named later check is the one that fires.

| Case | Rejected with |
| --- | --- |
| A baseline byte at a hunk preimage differs | `PREIMAGE_MISMATCH:retain_private_pointer` |
| ELF `.vad_text` linked at `0x0112e000` | `OVERLAP_IMAGE` |
| Capacity limit lowered to 256 bytes | `CAPACITY` |
| Manifest with an extra hunk inside the constructor padding | `HUNK_SET_NOT_APPROVED` |
| ELF instruction differs from the approved hunk | `ELF_HUNK_MISMATCH:allocate_96` |
| Constructor padding byte nonzero | `CONSTRUCTOR_PADDING_NONZERO` |
| Output file already exists | `FileExistsError` |

Gaps. The `0x0112e000` case lies below the baseline end `0x0112e200`, so the image-overlap check fires first, and the frozen-reservation overlap check was not exercised on its own. I did not exercise the wrong-hash pin path, a misaligned module base, a symbol or branch-target mismatch, or a checksummed header. Those paths are in the code and untested.

## Remaining gates

Each one stays closed. This image is not an installable firmware.

1. Container. System size, CRC32 and the partition table in `ota.xml`, the container and partition checksums, FVER and the version are not rebuilt here, and `build_containers.py` pins the old system hash.
2. Flash geometry and placement. The larger image (6,272 bytes more) against the system partition capacity is not checked. `0x0112f000` is the frozen baseline's placement. It is not a reservation in the other session's higher-rate pipeline, and nothing here reconciles the two layouts.
3. Object lifetime. No proof that a published object is never freed or replaced. Teardown, ROM paths, indirect consumers and interrupts are unaudited.
4. Callee-save. `r4` to `r7` preservation across the zeroing wrapper at `0x0008009e`, the GPIO lookup at `0x0108e250` and the indirect GPIO method is an assumption. Their bodies are not read.
5. Ordering and exclusion. The core uses compiler barriers. The PSR guard masks same-core interrupts only. No exclusion of another core or the DSP.
6. Execution. Nothing ran on a CK802 or any device. No `0xf11a` response was observed. The runtime framing inputs (halfword `0x867d6`) are unbound. The assembler and linker accepting an instruction does not show the silicon executes it.
7. Dispatcher equivalence. The new `console630_*` hooks replace the frozen ones at two sites. That the replacement behaves like the frozen dispatcher for `0xf117` to `0xf119` rests on earlier host checks. This builder does not check it. The frozen guard module stays in the image and its descriptor edits are untouched.
8. Meaning. The recorded word is what the native caller consumes after a successful read. It carries no established speech or VAD meaning.
9. Review. No `delivery-gate` pass and no adversarial review of this builder. Nothing is committed.

## Assumptions the builder does not test

- Normal C-SKY callee-save ABI.
- The delayed-publication prerequisites asserted by `H1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1` when the module was compiled.
- The single startup order in `early-reader-order/REPORT.md`, and no free of a published object.
- The 96-byte allocation succeeds and is 4-byte aligned.

## Repeat

From WSL, in this folder (the toolchain `objdump` lives there):

```
python3 build_candidate.py     # exits 3 with a named code on any rejection; never overwrites
python3 reject_checks.py       # writes rejection-checks.json once
```

The builder does not overwrite, so a second run needs `output/` emptied first.

## Disclosure about the run

I started the first execution while two edits to the builder were still being applied, so that run could not be tied to the final script. I deleted its three outputs (by their literal paths, inside this folder, using `rm -f`) and ran the final script once. Its result matches the earlier one: the same SHA-256, `ad86193a...2ac0`. The rejection checks then ran against the final script. There was one failed attempt before that, which stopped with `BSR: 403ce30f is not a 32-bit bsr` because the builder wrongly decoded the baseline decision site as a `bsr`. The fix reads the baseline instruction there and checks it is `cmpnei r4,0; bf 0x01021038`.

Outside the project, WSL `/tmp` still holds small files from earlier phases (`h1e_ck802_*`, `h1e_nlc_*`, `h1e_npc_*`). This phase wrote none there.
