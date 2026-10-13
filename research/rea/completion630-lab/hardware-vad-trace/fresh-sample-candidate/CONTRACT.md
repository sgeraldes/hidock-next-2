# Fresh-sample telemetry contract (proposal, revision 3)

Status: proposal for independent source review. No image was generated, patched or flashed. Generation stays blocked until the preconditions in section 8 are reviewed. The current device stays custom393988 and `runtime/frozen393988` is unchanged.

`vadt_core.h` / `vadt_core.c` are portable C with no target addresses. `vadt_binding.h` / `vadt_binding.c` are a source-only binding design that takes the getter, an IRQ guard and an object loader by injection, and is not connected to anything. Every target address and layout lives only in this file.

## 1. What the recorded values are

The native poller `01020b58` calls the unchanged getter `0101fb68(&word)` once. `word` is a zero-initialized 32-bit local at `sp+0x14`. The telemetry records the same initialized 32-bit word the native caller consumes after status 0. It is not proven DSP 32-bit data, a voice boolean, or a physical channel measurement.

A recorded time, when one exists, is the local native clock at the moment the telemetry code observed a completed read. It is not DSP or acoustic acquisition time. How old the audio behind the word was when the getter returned is unknown.

The getter chain is now resolved from source, with limits. RAM slot `0x00080e70` is filled by the C-init copy (destination `0x80000`, source `0x1115290`, length `0x2267`) with `0x0101f0ec`, per `reader-provider-followup/ram-initializer/REPORT.md`. The entry at `0101f0ec` is `push lr; movi r2,1; bsr 0101f0bc; pop lr`. The third argument `1` has no recovered name or unit. The lower transport unit, the number of bytes it writes into the caller's word, freshness and route remain unqualified.

## 2. Evidence base and what parity proves

Image `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`, load base `0x01000000`, file offset = address - `0x01000000`. The bytes in section 3 were read from that file and agree with `native/01021024.tsv` and `native-extra/01020b58.tsv`.

`cache-bridge-candidate/source-parity.json` and `binding-source-parity.json` compare the current image with the frozen custom393988 file (`b338e4d5...0c2f`) over exact windows (`01020b58` 164 bytes, `01020d9c` 132, `010211f0` 736, `01021024` 324, `01020f74` 152, `010217dc` 144, `01090054` 12) with zero differences. `publication-proposal.o` holds the assembled `movi r0,96` and `movi r2,96` encodings. These artifacts prove exact windows and exact encodings only. They say nothing about lifetime, concurrency, cache freshness, the running device image, or physical behavior.

## 3. Proposed native binding (not implemented)

`0x000852c0` is a RAM pointer slot. The initializer `01021024` mallocs the object, stores the pointer in the slot, zeroes the object and sets `object+2 = 1`.

Proposal: grow the allocation and the zeroing from `0x40` to `0x60` bytes. The original 64 bytes keep today's malloc and zero treatment and no native field moves. Only the added tail `object+0x40 .. object+0x5f` holds telemetry. No native spare byte inside the first 64 is reused (`object+0xc` is passed to `0101faf4` as a buffer of unknown size).

| Site | Address | Bytes now | Meaning now | Proposed |
| --- | --- | --- | --- | --- |
| slot literal cell | `01021134` | `c0 52 08 00` | `0x000852c0`, loaded by `01021028` | unchanged |
| alloc size | `01021054` | `40 30` | `movi r0,0x40` | `60 30` = `movi r0,0x60` (assembled in `publication-proposal.o`) |
| malloc call | `01021056` | `01 e0 fb c8` | `bsr 0105a24c` | unchanged |
| slot store | `0102105c` | `00 b5` | `st.w r0,(r5,0)`, publishes the pointer before the zeroing | `c3 6d` = `mov r7,r0`: hold the pointer privately; keeps the null-compare flags for `bt` at `0102105e` |
| zero size | `0102109e` | `40 32` | `movi r2,0x40` | `60 32` = `movi r2,0x60` (assembled in `publication-proposal.o`) |
| zero value | `010210a0` | `00 31` | `movi r1,0` | unchanged |
| zero call | `010210a4` | `82 e3 fd f7` | `bsr 0008009e` (memset) | unchanged |
| publish | `010210a8` | `e0 95` | `ld.w r7,(r5,0)`, reloads the pointer | `e0 b5` = `st.w r7,(r5,0)`: publish the saved pointer after the zeroing returns |
| failure cleanup | `[01021074,0102107e)` | `01 e0 f6 c8` `00 33` `00 34` `60 b5` (bsr free, movi r3,0, movi r4,0, st.w slot clear) | free first, then clear the slot | `00 33` `60 b5` `01 e0 f4 c8` `00 34`: clear the slot first, then free. The `subi r4,1` at `0102107e` and `br` at `01021080` stay. |
| word init | `01020b5c` | `00 33 05 18 65 b8` | `movi r3,0; addi r0,sp,0x14; st.w r3,(sp,0x14)` | unchanged |
| getter call | `01020b62` | `ff e3 03 f8` | `bsr 0101fb68` | retarget to a wrapper; displacement computed by the generator |
| status test | `01020b68` | `40 38` | `cmpnei r0,0` | unchanged |
| slot literal for the poller | `01020bec` | `c0 52 08 00` | `0x000852c0`, loaded at `01020b88` | unchanged |

Proposed versus applied. Every "proposed" cell above is a proposal. None is applied to any image: no firmware was generated, patched or built, and the only evidence is isolated assembler and linker snippets. The proposed constructor bytes `6030 c36d 6032 e0b5` and the ten-byte cleanup reorder `0033 60b5 01e0f4c8 0034` (linked at `01021074`, call target `0105a260`) are in `lifecycle-followup/lifetime-fix/REPORT.md` and its `constructor-edit-encodings.*`, `publish-store.*` and `cleanup-reorder.*` files. The `0x60` size encodings are also in `cache-bridge-candidate/publication-proposal.o`. These artifacts show the encodings assemble. They do not show lifetime safety, reader readiness or consumer compatibility (section 8).

The wrapper code, its address and the new `bsr` displacement at `01020b62` do not exist yet. No RAM address is proposed.

## 4. Native output and status preservation

The wrapper that replaces the target of the call at `01020b62` must keep every native effect:

- Exactly one call to the original getter `0101fb68`, made by the wrapper. The getter keeps its one-argument ABI: `r0` is the caller's pointer, `r0` returns the integer status. The source-only adapter calls it through its real type and never casts it to a ctx-first function type. No DSP call is added. Telemetry observes the existing read.
- The pointer in `r0` is the caller's `sp+0x14`, passed through unchanged.
- The status comes back to `01020b66` unchanged. `01020b68` branches on it.
- The word at `sp+0x14` is left exactly as the getter left it, success or failure. The wrapper reads it only when status is 0, copies it, and never writes it. `01020b78` and `01020b8e` read it later.
- The getter runs outside any IRQ mask. Only the short metadata update is masked.
- Registers and stack the native code relies on after the call must hold, following the C-SKY calling convention.

`vadt_record_completed` takes a completed status and a copied raw word and time. It has no callbacks, never touches a native pointer and never reads a clock. `vadt_poll` and `vadt_binding_poll` both go through it.

## 5. Telemetry tail (32 bytes, `object+0x40`) and the unclocked path

| Offset | Field | Type | Notes |
| --- | --- | --- | --- |
| `+0x40` | sequence | u32 | seqlock; odd while the writer is inside |
| `+0x44` | attemptedReads | u32 | wraps modulo 2^32 |
| `+0x48` | successfulReads | u32 | wraps modulo 2^32 |
| `+0x4c` | lastAttemptStatus | i32 | status of the latest attempt, success or failure |
| `+0x50` | lastGoodRawWord | u32 | last word read with status 0; 0 until the first success |
| `+0x54` | lastGoodTimeLow | u32 | reserved for the optional clocked path; zero when unclocked |
| `+0x58` | lastGoodTimeHigh | u32 | reserved for the optional clocked path; zero when unclocked |
| `+0x5c` | flags | u32 | bit 0 hasSuccessfulSample, bit 1 hasTime |

The intended native path is unclocked. The wrapper does no clock call, passes no time, and `vadt_record_completed(..., has_time = 0)` zeroes the time words and clears hasTime on every successful read, so a stale time never pairs with a new word. No dummy zero clock is passed and no age is derived from one. A sample without hasTime gets age status `NO_TIME`.

Not yet sampled is hasSample clear. Raw 0 with hasSample set is a valid sample. A later failure keeps lastGood*, hasSample and hasTime, and moves only attemptedReads, lastAttemptStatus and the sequence. hasSample is independent of the wrapped successful count.

The age-enabled behavior (`vadt_age`, `vadt_encode_reply_with_age`, the `vadt_poll` clock callback) stays in the portable API as optional behavior. It needs a separately qualified target clock binding: `01090054` loads the cell `0109005c` (value `0x0008972c`, unmapped) and reads two words whose roles and writer are unidentified, and a coherent pair needs the IRQ-snapshot contract in `lifecycle-followup/irq-snapshot/REPORT.md`. Nothing in the native path calls it.

## 6. Tentative command and reply (nothing is allocated)

Command `f11a` is tentative. It is not installed, not allocated, and not present in the image or the app.

Request body: exactly 1 byte, and body byte 0 must equal `0x01`. Any other length or value is rejected. There are no fields for offsets, lengths, addresses or write operations.

Reply: fixed 32 bytes.

| Bytes | Field |
| --- | --- |
| 0 | status: 0 OK, 1 BUSY, 2 UNAVAILABLE |
| 1 | version `0x01` |
| 2 | flags: bit 0 hasSample, bit 1 ageValid, bit 2 clockRegressed |
| 3 | nativeState: `object+0` state byte, 0 when unavailable |
| 4..7 | attemptedReads, BE32 |
| 8..11 | successfulReads, BE32 |
| 12..15 | lastAttemptStatus, BE32 two's complement |
| 16..19 | lastGoodRawWord, BE32 |
| 20..23 | ageLow, BE32 |
| 24..27 | ageHigh, BE32 |
| 28..31 | sequence, BE32 |

On the unclocked path `vadt_encode_reply` leaves ageValid and clockRegressed clear and both age words zero, while hasSample, the counters, the status and the raw word (including a valid zero and a later failure) are reported. For BUSY and UNAVAILABLE only bytes 0..3 are meaningful and bytes 4..31 are zero.

Byte 3 (nativeState) rule, enforced by the encoder for both the unclocked and the optional age wrapper through one shared function:

- UNAVAILABLE (status 2) always writes byte 3 = 0. This holds for an explicit UNAVAILABLE and for the OK-with-NULL-snapshot fallback, whatever native state the caller passed.
- BUSY (status 1) writes the caller's raw native state in byte 3, which may be nonzero.
- OK (status 0) writes the caller's native state in byte 3.

Tradeoffs, reported and not resolved here:

- With no clock, the host gets no age at all. Staleness shows only as counters and status changing between its own reads, so two replies with equal attemptedReads mean no new poll ran between them. The poll cadence is not a measured fact.
- The sequence is returned so the host can tell two replies came from different snapshots. It is a coherence aid and not a sample identity.
- The time words in the tail stay reserved and zero. Dropping them would shrink the tail to 24 bytes but would change the layout the optional clocked path needs.
- If age is wanted later, the 32-byte reply cannot carry the last-good timestamp, so the choices are age only (needs a clock call at reply time), a 36 or 40-byte reply, or a separate command. That is a decision for later and widens the surface.

## 7. Source-only binding design (`vadt_binding.*`, `vadt_csky_guard.c`)

`vadt_binding_poll`: call the original getter outside the guard, copy the word only on status 0, `guard_enter`, `load_object` inside that guard, `vadt_record_completed` only if the load succeeded, `guard_exit` with the exact saved key, return the getter status. A failed load publishes nothing and still returns the getter status.

`vadt_binding_read`: `guard_enter`, `load_object`, bounded `vadt_snapshot` into a stack copy, `guard_exit`, then format the reply from the copy. The tail pointer is not used after the guard is restored.

`vadt_csky_guard.c` is `mfcr psr` + `psrclr ie` for enter and `mtcr psr` for exit, with `"memory"` and `"cc"` clobbers on both asm statements. PSR holds the condition flag, so `psrclr` and `mtcr` change it, and the `"cc"` clobber stops inlining or LTO from reusing a comparison result across the guard. It mirrors the image's own pattern at `01074606` (`00 c0 24 60`, `mfcr r4,psr`), `0107460a` (`80 c0 20 70`, `psrclr ie`) and `0107464c` (`04 c0 20 64`, `mtcr r4,psr`), re-read from the hashed image this session. The register differs from the image's r4 because the compiler allocates it. This is a same-core mask only. The related SDK's `irq_lock` is the same shape, but the SDK revision matching this build is unproven, and the image's CPU variant is not established here. The isolated objects are compiled with `-mcpu=ck803`, which matches the existing builder, and that is a build setting and not evidence about the device CPU.

## 8. Preconditions before any generation or connection

1. Independent source review of this contract, `vadt_core.c` and `vadt_binding.c`.
2. Constructor failure order. In the current image `01021074` frees the object and `0102107c` clears slot `0x852c0` after it, so for the length of the free call the slot points at memory being freed. A slot check inside the guard cannot see that window. The ten-byte reorder in section 3 (clear the slot, then free) is proposed and its encodings assemble in isolation (`lifetime-fix/REPORT.md`). It is not applied to any image and is not reviewed. Detaching also does not revoke a pointer a reader already copied, so the binding still needs a reader and free synchronization or a lifetime guarantee. Until then no `load_object` for `0x852c0` may be written. The binding stays unconnected on exactly this requirement.
3. Publish after zeroing. The current image stores the pointer into the slot at `0102105c`, before the zeroing call at `010210a4`. The proposed `mov r7,r0` at `0102105c` and `st.w r7,(r5,0)` at `010210a8` publish after the zeroing (proposed, not applied). Even then the object is published before the constructor writes byte `+2`, calls `0108e250` and stores that result at `+8` (`lifetime-fix/REPORT.md`), so publication does not prove the object ready. `load_object` needs a verified readiness condition or a later publication point.
4. No normal successful teardown is known (`lifecycle-followup/REPORT.md`). Shutdown ownership is unproven, and a local guard does not protect against another core, the DSP, or a teardown outside the guarded protocol.
5. Heap: the `0x60` request is larger than any request from this site. The allocator at `0105a24c`, the heap size and the 4-byte alignment of the tail are unchecked.
6. Other users of the object: 13 literal cells load slot `0x852c0` (`lifecycle-followup/state-slot-literal-hits.tsv`). None was checked for a `0x40` size assumption.
7. Reader context: the Jensen reader's task or interrupt context and core are not established. The guard orders it against same-core interrupts only.
8. A C-SKY build of the wrapper with the generator computing the new `bsr` displacement, and a decision on the wrapper's code address.
9. The lower transport unit and write width behind `0101f0ec`, the freshness of the word and the physical channel stay unqualified. Host tests say nothing about them.
