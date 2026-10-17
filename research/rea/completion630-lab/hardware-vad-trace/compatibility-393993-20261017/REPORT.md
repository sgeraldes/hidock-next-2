# 393993 compatibility of the retained VAD image

**Finding:** The 393993 decoded SYS keeps the 393992 VAD router module and all ten installed VAD patch windows intact. It changes two calls inside the VAD console wrappers so normal console handling reaches the newly expanded ROM-command muxes. The retained artifacts support that retarget statically; an exact-image `F11A`/poll instruction gate is still needed before adding 393993 to `getNativeVadObservation`.

This is an offline artifact comparison. It does not establish installation, device execution, or physical VAD behavior.

## Pins and comparison

The left image is the qualified 393992 SYS at `research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/out-NOTINSTALL/compose-3/system-decoded-NOTINSTALL.bin`: 1,237,504 bytes, SHA-256 `043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918`.

The right image is the 393993 producer diagnostic SYS at `research/rea/completion630-lab/firmware/producer-rom-fixed-probe-candidate/out-NOTINSTALL/composed-run8-wrapper-fallbacks/system-decoded-NOTINSTALL.bin`: 1,237,504 bytes, SHA-256 `05d7d9e2d725b4624b4746b09cea58eed9aded63b1fc377255ac2c5fc41dec8b`. The 393993 container is SHA-256 `36c28463316f2a1589cc83bdab86342c9a19221a77e92526ae71456bdf9e00e4`; its `container-readback.json` records that its decoded SYS equals this pinned input. Both images use load base `0x01000000`.

A byte-for-byte comparison found 24 half-open changed runs totaling 461 bytes. Four bytes are in the used VAD module; the other 457 bytes are in the expanded console reservation.

| SYS file offsets `[start,end)` | Load addresses `[start,end)` | Bytes |
|---|---|---:|
| `0x128cfe..0x128d00` | `0x01128cfe..0x01128d00` | 2 |
| `0x128db6..0x128db8` | `0x01128db6..0x01128db8` | 2 |
| `0x12ba74..0x12ba78` | `0x0112ba74..0x0112ba78` | 4 |
| `0x12baae..0x12bab2` | `0x0112baae..0x0112bab2` | 4 |
| `0x12be24..0x12be34` | `0x0112be24..0x0112be34` | 16 |
| `0x12be38..0x12bebb` | `0x0112be38..0x0112bebb` | 131 |
| `0x12bebc..0x12bec3` | `0x0112bebc..0x0112bec3` | 7 |
| `0x12bec4..0x12becb` | `0x0112bec4..0x0112becb` | 7 |
| `0x12becc..0x12bed3` | `0x0112becc..0x0112bed3` | 7 |
| `0x12bed4..0x12bee0` | `0x0112bed4..0x0112bee0` | 12 |
| `0x12bee1..0x12bee2` | `0x0112bee1..0x0112bee2` | 1 |
| `0x12bee3..0x12bef0` | `0x0112bee3..0x0112bef0` | 13 |
| `0x12bef1..0x12bef7` | `0x0112bef1..0x0112bef7` | 6 |
| `0x12bef8..0x12bf34` | `0x0112bef8..0x0112bf34` | 60 |
| `0x12bf35..0x12bf37` | `0x0112bf35..0x0112bf37` | 2 |
| `0x12bf38..0x12bf7e` | `0x0112bf38..0x0112bf7e` | 70 |
| `0x12bf7f..0x12bf80` | `0x0112bf7f..0x0112bf80` | 1 |
| `0x12bf81..0x12bf85` | `0x0112bf81..0x0112bf85` | 4 |
| `0x12bf86..0x12bf89` | `0x0112bf86..0x0112bf89` | 3 |
| `0x12bf8a..0x12bf9e` | `0x0112bf8a..0x0112bf9e` | 20 |
| `0x12bf9f..0x12bfe7` | `0x0112bf9f..0x0112bfe7` | 72 |
| `0x12bfe9..0x12bfee` | `0x0112bfe9..0x0112bfee` | 5 |
| `0x12bfef..0x12bff7` | `0x0112bfef..0x0112bff7` | 8 |
| `0x12bff8..0x12bffc` | `0x0112bff8..0x0112bffc` | 4 |

## VAD patch and module readback

The retained 393992 layout identifies `.router_tail` at `0x01128a40`, 1,248 bytes (`0x4e0`), inside the 1,472-byte reservation ending at `0x01129000`. Its original SHA-256 is `72c1fd09dfae86bbb4691b9b713c92e32685b1a5ccbb8f2e6b2406ec53115647`; the same 1,248 bytes in 393993 hash to `c2c1a4a12cfbcba3527600d9f955c8affb43e4d70f2b8b4ea95a8f4748eb7032`. The module differs only in the two 32-bit wrapper BSRs below. All other used module bytes compare equal; the remaining 224 bytes of reservation are outside the linked module segment.

| Wrapper instruction | 393992 | 393993 |
|---|---|---|
| Response BSR at `0x01128cfc` | `00e09015` → `0x0112b81c` | `00e0fe18` → `0x0112bef8` |
| Parser BSR at `0x01128db4` | `00e0ac14` → `0x0112b70c` | `00e04218` → `0x0112be38` |

The retained `compose-run8-wrapper-fallbacks/manifest.json` provides before/after C-SKY disassembly and confirms that only each BSR displacement changes; the wrappers' following epilogues remain unchanged. The final 393993 SYS thus redirects normal parser/response fallback into the new muxes instead of bypassing the new code.

All ten VAD patch windows from `receipts/compose-3/layout-readback.json` compare byte-identically between the two SYS files:

| Address | Role | Bytes in both images | Resolved target where applicable |
|---|---|---|---|
| `0x01020b62` | Native poll bridge | `08e06941` | `0x01128e34` |
| `0x01021054` | Allocate 96-byte snapshot | `6030` | — |
| `0x0102105c` | Retain private pointer | `c36d` | — |
| `0x0102106a` | Private failure pointer | `1f6c` | — |
| `0x01021070` | Final publication decision | `08e04a3f` | `0x01128f04` |
| `0x0102109e` | Zero snapshot | `6032` | — |
| `0x010210a8` | Retain pointer after zero | `df6d` | — |
| `0x010210de` | Private GPIO object | `df6c` | — |
| `0x0103907a` | F11A response dispatch | `07e00d7f` | `0x01128e94` |
| `0x0103a996` | F11A parser dispatch | `07e05b72` | `0x01128e4c` |

The first eight constructor/lifetime/poll-publication hooks retain their pinned bytes and the F11A outer parser/response dispatch still reaches the same VAD wrappers. The polling bridge still points to `0x01128e34`.

## Console aliases and ABI

The 393992 VAD layout records `console630_parse_current → 0x0112b70c` and `console630_response_current → 0x0112b81c`. In the 393993 producer map, the corresponding `console630_parse` entry remains at `0x0112b70c` (272 bytes) and `console630_response` remains at `0x0112b81c` (384 bytes). Their bytes in the final 393993 SYS are identical to the retained current-console readback hashes: parser `e72ad09d57bc4ddda5940bc30a7dab33a9eca0b7628ae90bd87a2de4ae7c3cea`, response `3b42d830b0b6092327e1b747399da4fd46f5983f7c5839221ae5cc0fd5780c94`.

The new run8 map places `console630_parse_mux` at `0x0112be38` (192 bytes) and `console630_response_mux` at `0x0112bef8` (260 bytes). Both fit within the `[0x0112b000,0x0112c000)` console reservation; the response mux ends at `0x0112bffc`, just before the next reserved region. The final image contains non-fill bytes across both mapped function ranges.

The retained source ABI confirms the forwarding contract:

- `console630_parse_mux` first delegates to the existing parser entrypoint. It intercepts only eligible F117 frames with a five-byte `code0` through `code7` body, mapping those eight labels to selectors 6 through 13. Other parser traffic returns the existing parser result.
- `console630_response_mux` handles F117 selectors 6 through 13 and otherwise delegates to the existing response entrypoint.
- The new 393993 wrapper BSRs target these muxes, while the original parser/response entrypoint bytes and addresses remain intact for the muxes' fallback calls.

The 393993 final-image QA receipt at `out-NOTINSTALL/qa-compile-20261016T2233Z/producer-rom-probe-qa.json` pins SYS SHA `05d7d9…dec8b`. Its `code0`–`code7` exact-image cases report `passed_exact_image_case` and trace both `parse_mux` and `response_mux`; the separate payload interoperability check is parser-only. The overall QA record remains `failed_or_inconclusive` because three other cases needed receipt-only oracle reevaluation. The report records 16 original passes plus three posthoc source-based reevaluations, with no rerun. These cases use synthetic ROM/RAM and do not establish physical ROM readability.

## Admission gate still needed

The SDK source still restricts `JensenDevice.getNativeVadObservation()` to H1E 393992 / 6.3.8 (`packages/jensen-protocol/src/jensen-device.ts`, lines 2862–2882). The 393992 VAD exact-image receipt contains six cases on SYS `043afb…a918`: F11A absent/present response, poll bridge success/failure, and non-VAD parser/response forwarding. The 393993 19-case producer-ROM run exercises the expanded mux and its F117 paths, but it contains no F11A or poll-bridge case.

Before adding 393993 / 6.3.9 to the native VAD observation admission gate, rerun just the four F11A absent/present and poll success/failure instruction cases against the final 393993 decoded SYS SHA `05d7d9…dec8b`, retaining synthetic-memory boundaries and the new parser/response mux addresses. Existing code0–code7 coverage is already present on that exact SYS; the ten patch-window byte comparison establishes unchanged constructor/lifetime hook sites. This narrow gate would confirm that the exact final image still routes the F11A query and poll snapshot correctly after the wrapper retarget. It would remain offline instruction evidence, separate from any physical VAD qualification.

No source, SDK, firmware, device, USB, app, runtime, or Git files were changed for this note.
