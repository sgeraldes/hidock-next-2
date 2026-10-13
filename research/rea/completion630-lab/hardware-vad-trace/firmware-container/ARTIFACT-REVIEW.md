# Independent review: decoded VAD candidate and packed container

## Disposition

**Pass for bounded offline structural integration and container readback.** The exact decoded candidate matches the pinned CK802 SDK ELF section and all ten approved source hunks; the packed ACTTEST container parses with valid checksums and decodes back to those exact candidate bytes. This is an `EXPERIMENTAL` / `NOTINSTALL` artifact. It does not establish runtime lifetime safety, target memory capacity, physical boot or audio behavior, installer acceptance, or release readiness.

## Decoded image

Reviewed `system-vad-EXPERIMENTAL-NOTINSTALL.bin` (SHA-256 `ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0`, 1,243,776 bytes / `0x12fa80`). Its input is the frozen decoded system image (SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`, 1,237,504 bytes / `0x12e200`). Both hashes match the private readback and the approved `sparse-source-hunks.json` and ELF.

All first 48 header bytes match the frozen image. The preserved header identifies `ACTHHTCA`, load `0x01000000`, name `sys`, version 1, header size `0x30`, and entry `0x0106e26c`; its checksum and body-size fields remain zero, as in the baseline. No inner-header checksum or body length was invented.

I compared every approved hunk's old bytes with the frozen image and its new bytes with the candidate, then compared the complete baseline-length span. The 10 hunk windows total 28 bytes; they account for all 22 changed baseline bytes, with no changed bytes outside the windows:

| Address | Role | Before → after |
|---|---|---|
| `0x01020b62` | Existing native getter bridge | `ffe303f8` → `08e01575` |
| `0x01021054` | Allocate 96 bytes | `4030` → `6030` |
| `0x0102105c` | Retain private pointer | `00b5` → `c36d` |
| `0x0102106a` | Private failure pointer | `0095` → `1f6c` |
| `0x01021070` | Final publication decision | `403ce30f` → `08e0c274` |
| `0x0102109e` | Zero 96 bytes | `4032` → `6032` |
| `0x010210a8` | Retain private pointer after zeroing | `e095` → `df6d` |
| `0x010210de` | Private GPIO object | `6095` → `df6c` |
| `0x0103907a` | Native response dispatch | `07e08194` → `07e04fb4` |
| `0x0103a996` | Native parser dispatch | `07e0cf87` → `07e09da7` |

The two constructor-size edits change `0x40` to `0x60` for allocation and zeroing. The four pointer/lifecycle edits match the approved patch bytes. The final appended module is exactly `.vad_text` from ELF SHA-256 `576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366`: address `0x0112f000`, size `0xa7c`, SHA-256 `396f63c2f02e9e61174efe408b5ad7d34f74bbad96bd4911647f5978072e1c87`. The ELF's separate constructor section is 140 bytes, of which only 16 are instruction bytes and 124 are padding; none of that section's padding was appended. The output is laid out as a zero-filled `0xe00` gap, `.vad_text` (`0xa7c`), and four zero alignment bytes, for `0x1880` appended bytes total.

The four call instructions in the candidate bytes decode to these ELF symbol entries; each destination is inside `.vad_text`, and each link-register address is the instruction address plus four:

| Call site | Destination | Target symbol | Link register |
|---|---|---|---|
| `0x01020b62` | `0x0112f58c` | `h1e_vad_native_poll_bridge` | `0x01020b66` |
| `0x01021070` | `0x0112f9f4` | `late_publication_stub` | `0x01021074` |
| `0x0103907a` | `0x0112f918` | `console630_response_hook` | `0x0103907e` |
| `0x0103a996` | `0x0112f8d0` | `console630_parser_hook` | `0x0103a99a` |

The raw candidate hunk bytes match the approved before/after manifest, and the CK802 disassembly of the corresponding linked hook sections decodes each as `bsr` to the listed address. These checks establish the encoded structural edges; they do not exercise the calls at runtime.

## Packed container

The packed artifact is `H1E-6.3.4_restore001-vad-candidate-EXPERIMENTAL-NOTINSTALL.bin` (SHA-256 `5eea2c5af70e523b4518caa94fe0097a2660d02c34b4cdb747748612fd2211bd`, 3,435,520 bytes). Its frozen input container SHA-256 is `4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8`. I parsed both containers, verified the header and data CRCs, per-partition CRCs, nonoverlapping ranges, and XML/table consistency, then decoded the candidate `zephyr.bin` in memory. The decoded partition is byte-identical to the reviewed decoded candidate and has the same SHA-256.

The container keeps the same `6.3.4_restore001` / code `393988` / `ats2835p_evb` identity. `ota.xml` differs only in the `zephyr.bin` file size and checksum (`0x12e200` / `0x51e820fb` to `0x12fa80` / `0x618cffe0`). `mbrec.bin`, `RomeApp.bin`, `UAC.bin`, `IG1202dl.bin`, and `sdfs.bin` are byte-identical to the frozen container. The decoded boot partition's FVER record and CRC still identify `6.3.4_restore001` / `393988`.

`zephyr.bin` stays at container offset `0x800`. It grows by `0x1880`; the gap before `RomeApp.bin` shrinks by `0x80`, so `RomeApp.bin` and following partition offsets move by `0x1800`. The parser found no overlap and validated the resulting container checksums. This is file-layout evidence only: flash-partition fit and relocation tolerance remain unqualified.

## Gates that remain open

- The object-tail allocation and publication changes have not been qualified against runtime ownership, task/stack lifetime, provider write width, interrupt behavior, or unload/teardown paths.
- `0x0112f000` is an isolated candidate placement. Physical reserved-memory capacity and the eventual combined VAD/router layout are not established; the repeatable builder's output must match this immutable decoded candidate before that path is accepted.
- No physical boot, microphone/audio stream, power, thermal, installer, or ROM recovery validation occurred. The artifact is not installable or approved for installation, and its version identity was not advanced.
- The packed artifact's absolute-output-root run does not prove the separate repeatable builder's relative `--out-root` path; that CLI path issue remains with its implementation owner.
