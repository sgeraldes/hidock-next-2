# 393990 NO-GROWTH VAD layout candidate

Status: **offline candidate only; not composed, installed, or hardware-qualified.** This records a bounded placement and link result, not a reservation or ownership grant.

## Candidate layout

The immutable prebuilt CK802 objects were linked once with `no-growth.ld`; no sources were recompiled. Whole `.text`/`.rodata` sections were placed into two proposed tails inside linker-declared 4 KiB module reservations:

| ELF section | Proposed address range | Linked bytes | Capacity | Tail left |
| --- | --- | ---: | ---: | ---: |
| `.router_tail` | `0x01128a40..0x01128fcc` | 1420 | 1472 | 52 |
| `.console_tail` | `0x0112be00..0x0112bfb8` | 440 | 512 | 72 |

The combined section payload is 1860 bytes, equal to the pinned VAD `.vad_text` export. Router placement follows the live 2613-byte module ending at `0x01128a35`; its proposed window ends at the router reservation boundary `0x01129000`. Console placement follows the current pinned console module ending at `0x0112bc75`. The console boundary `0x0112be00..0x0112c000` is a proposed 512-byte window, aligned to 32 bytes; the active-producer size/end (`3568` bytes / `0x0112bdf0`) is parent-reported but not pinned in this artifact. The declared console reservation continues to end at `0x0112c000`, before the existing upload and restore windows at `0x0112c000` and `0x0112d000`.

The current 393990 SYS has exact uniform preimages over both complete candidate windows: `.router_tail` is all `0xff` across 1472 bytes (SHA-256 `d681b2309c3b48684ac24e27fafa6f215a294dc75bcbbf5fbfb4bbaacaed0e07`), and `.console_tail` is all `0x00` across 512 bytes (SHA-256 `076a27c79e5ace2a3d47f9dd2e83e4ff6ea8872b3c2218f66c92b89b55f36560`). Segment-length preimages are separately pinned in the manifest: router's 1420 bytes SHA-256 `caab377590a323fc70bffd43e1adaae6385ecb2c0fb240b366a51a01b5d21431`; console's 440 bytes SHA-256 `360d579dbd14759b41afdf7fb5e80c0101e15150ae401d59f92a1e32d129f7cb`. The initial zero-only guard correctly flagged the router range; the readback was adjusted to verify exact `0xff` and `0x00` fills. Fill does not establish that memory is free or owned. The manifest therefore leaves `reservation_accepted` and `ownership_accepted` false.

## Pinned inputs and preserved bytes

The baseline is `firmware/capture-vector-selected-diagnostic/out-NOTINSTALL/container-compose3/system-decoded.bin`, 1,237,504 bytes at load base `0x01000000`, SHA-256 `abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360`.

Input capture is recorded in `output/input-pins-before.json` and independently compared with `output/input-pins-after.json`. It pins the baseline, 11 immutable object files, 36 accepted source inputs, source hunk manifest, original F11A ELF, current console ELF/bin, fixed-router ELF/bin, and the linker scripts/dependencies used for reservation bounds. The pin manifest SHA-256 is `ecb3f08d25a66b8b1c0741edee62a290d78e116195e91009036708b8f6897a58`.

Readback proves the pinned current fixed-router bytes (2613 bytes at `0x01128000`) still match exactly: module SHA-256 `d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487`, ELF SHA-256 `f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a`. It also proves the pinned current console bytes (3189 bytes at `0x0112b000`) still match exactly: module SHA-256 `9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2`, ELF SHA-256 `105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee`. Existing `console630_parse` at `0x0112b70c` and `console630_response` at `0x0112b800` have identical ELF and baseline bytes.

The 10 instruction replacements cover the native poll bridge, seven constructor edits, and parser/response hooks (28 bytes total). Every hook replacement is extracted from the linked ELF, checked against the exact 393990 baseline hunk, and hashed. For each four-byte branch, the raw linked bytes are decoded and the resulting target equals the associated linked symbol (`h1e_vad_native_poll_bridge`, `late_publication_stub`, `console630_response_hook`, or `console630_parser_hook`). The other constructor replacements also match their pinned baseline hunk preimages.

## Artifacts and verification limits

- `output/vad-no-growth-393990-NOTINSTALL.elf` — CK802 link, SHA-256 `cfa7e5f8b2ebf838b54484169921f388f24bf868b316b7fb366b1574d798cfbf`.
- `output/layout-readback.json` — strict segment, exact preimage, patch, symbol, bounds, and preservation manifest; SHA-256 `a3c3209d0dfba4bef2084c1b07b18027cefb38bdcbbb4860a41cd2a6af4d7ea9`.
- `output/router-tail.bin` — 1420 bytes, SHA-256 `584f5deb36c27f1377ea044a6a1e8df4958860b1c12eda925fc0999cab06f7ed`.
- `output/console-tail.bin` — 440 bytes, SHA-256 `bb0d02160b6a40a81f0afc5a003202c25fb73e0dc7e0be93ad6a12ae8c586335`.
- `output/symbols.txt`, `output/no-growth.map`, `output/sections.txt`, and `output/objdump.txt` preserve link inspection evidence.

The sections and patch bytes lie within the original 1,237,504-byte baseline span, so this layout requires no image growth. No composed SYS was generated and no baseline was modified. This does not prove runtime behavior or VAD semantics on hardware. Reservation approval, composition, and installation remain outstanding.
