# RAM initializer resolves the VAD callback slot

## Result

This addendum corrects the provider-unknown conclusion in the adjacent `../REPORT.md` and the parent `../../REPORT.md`. `0x00080e70` is not uninitialized in the H1E 6.3.0 startup image: the C-init RAM-copy range contains a literal pointer that is copied into this slot. The copied value is `0x0101f0ec`, an executable code entry in the same Zephyr image. The earlier Ghidra export omitted this RAM range, which made the slot appear unmapped; that omission did not establish an external or ROM provider.

This is source and startup-path evidence. The physical `393988` metadata does not attest firmware bytes, so it does not prove the currently running device has this exact candidate image.

## Startup copy proof

The current decoded Zephyr image is pinned by `research/rea/h1e-6.3.0-verified/zephyr-decoded.decode.json`: SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`, load base `0x01000000`. Its containing vendor firmware manifest identifies version `6.3.0_2606152123` and `zephyr.bin` SHA-256 `cb2a5dc8745eaf179e1d977ba4214e084efe89618c11676864fd6607bcbb4809`.

In that exact image, startup entry `0106e29a` calls `0106e324`; `0106e324` calls zero-init `0108e36c`, then copy initializer `0108e3a0`, then `0108e404`. The C-init disassembly at `research/rea/evidence/h1e-6.3.0-integration/system-data-init-disassembly.txt` shows the first ROM-copy operation using destination `0x80000`, source `0x1115290`, and byte length `0x2267`. Thus the copied destination interval is `[0x80000, 0x82267)` and its source interval is `[0x1115290, 0x11174f7)`, 8,807 bytes. `exact-startup-memory-ranges.json` records the same range. The following zero-init range starts at `0x82268`, so it does not cover the slot.

The pointer calculation is direct:

| Item | Address/value |
| --- | --- |
| Destination callback slot | `0x80e70` |
| Offset within copied RAM range | `0x80e70 - 0x80000 = 0xe70` |
| Corresponding source address | `0x1115290 + 0xe70 = 0x1116100` |
| Source file offset at load base `0x01000000` | `0x116100` |
| Pinned source bytes | `EC F0 01 01` |
| Little-endian word copied to `0x80e70` | `0x0101f0ec` |

The adjacent copied words at source offsets `0x116104` and `0x116108` are `0x0101f128` and `0x0101f13c`; these also disassemble as code entries. The first source range SHA-256 is `d25df9d90b0ca3522884b3e10daf7ed9fd41e843c126e60f8e5cb7b9679c488f`.

## Callback code entry and limits

The exact current-image disassembly at `0x0101f0ec` is a four-instruction wrapper: `push lr`; `movi r2,1`; `bsr 0x0101f0bc`; `pop lr`. It is not a named function in the retained function inventory, so it is described by its exact code entry and instructions rather than an inferred symbol. `FUN_0101f0bc` and its callees are present in `research/rea/evidence/h1e-6.3.0-functions/zephyr-decoded.bin_functions.json`.

For the two getters, the outer wrappers pass `(r0=0x40000090, r1=output pointer)` or `(r0=0x4009ffd0, r1=output pointer)` to this entry. `0101f0ec` adds `r2=1`. `0101f0bc` calls address helper `0101ee84`; for both `0x40xxxxxx` inputs, the helper's `r0>>24 >= 32` branch preserves the input address, then `0101f0bc` forwards the address, output pointer, and third argument to `0101efa4`. If address conversion returns zero, `0101f0bc` logs and returns status `2`; otherwise it returns the lower helper's status.

The visible lower helper `0101efa4` checks a runtime function-pointer slot at `0x852a4` for null before calling it, then performs additional dispatch. This is an observed pointer guard, not proof of a DSP-ready condition. The target/provider for `0x852a4` and the downstream transfer implementation were not followed here. The third argument value `1` has no recovered name or unit; it must not be called a one-byte transfer. The getters' caller-owned output is a zeroed 32-bit local, which still does not prove the number of bytes written. No locking primitive appears in the inspected wrapper/helper windows; locking inside the unresolved lower service is unknown. The code-derived callback status path is visible, but bus/register side effects, freshness, route, metric polarity, and physical behavior remain unqualified.

## Frozen 393988 artifact comparison

The frozen candidate `research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin` has SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`. Direct byte comparison against pinned current 6.3.0 reports zero differences in all inspected ranges:

| Compared range (file offsets) | Bytes | SHA-256 in both images |
| --- | ---: | --- |
| C-init code window `0x8e360` | 416 | `be78109e1b72d7532d5ec8bdd1fbf939a52d7ba6a56457e17d2259540d1d0bc8` |
| Full startup copy source `0x115290` | 8,807 | `d25df9d90b0ca3522884b3e10daf7ed9fd41e843c126e60f8e5cb7b9679c488f` |
| Slot and two adjacent words `0x116100` | 12 | `86803151537add35dca8883d93b8519b47bf2305128f4b83fc246c6fce4bba70` |
| Provider wrapper code `0x1f0ec` | 148 | `f026146bb18952c16d04bf84f51407fb2ee4064334eb255b27eb9293c44d17c2` |
| Immediate helper window `0x1ee84` | 508 | `d3e837be9472b9c9a54df9c69f672b5437b67a2cff4dafb2ed278b16517603db` |

The candidate appends modules at `0x0112b000`; its stock image prefix and startup copy inputs remain byte-identical in the compared ranges, so that append does not shift this initializer or pointer. This comparison applies only to the frozen `NOTINSTALL` file. `runtime/current-custom393988-flash.json` reports `imageBytesAttestedByDevice: false`; the reported physical-image hash `4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8` was not matched to these bytes.

No hardware, app, firmware generation, or firmware write was used. The disassembly artifacts `system-entry-disassembly.txt`, `system-data-init-disassembly.txt`, and `system-bss-init-disassembly.txt` were checked byte-for-byte against the pinned 6.3.0 decoded image windows before relying on them.
