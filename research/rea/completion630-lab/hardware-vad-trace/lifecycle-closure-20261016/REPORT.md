# VAD lifecycle closure against selected 393990 SYS

## Finding

The native object lifecycle used by the VAD bridge remains the stock path in the inspected selected diagnostic 393990 decoded SYS. Targeted byte comparisons show the constructor, native getter callers, state machine, callback registration, scheduler insert/dispatch, and clock helper unchanged from the official 6.3.0 decoded image over their exported instruction spans. The 393990 main-loop function differs from 6.3.0 overall, but the constructor/registration and scheduler/state-machine callsite windows are byte-identical; the 393990 function is byte-identical to the 393988 base.

This closes target-baseline drift for those paths. It does not establish complete lifetime safety, because a full-ROM/indirect shutdown path search is not available, and it does not make the separate 393988 VAD candidate part of 393990.

Pinned images:
- Official 6.3.0 decoded SYS: SHA-256 5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce, 1,187,904 bytes.
- 393988 base SYS: SHA-256 b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f, 1,237,504 bytes.
- Selected 393990 decoded SYS inspected: SHA-256 abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360, 1,237,504 bytes.

The 393990 composition receipt records its 1,083 changed bytes only in the console module region and two console hook windows. A direct read-only comparison against the 393988 base found zero differences in the audited native-function ranges. This evidence concerns the decoded SYS artifact, not an independent device readback or runtime test. The active 393990 changes do not include the separate VAD bridge candidate at firmware-integration/output/system-decoded-vad-ck802-NOTINSTALL.bin (SHA-256 ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0).

## Object ownership

RAM address 0x852c0 is the global pointer slot. A full-image scan for the exact little-endian slot literal (c0 52 08 00) found the same 14 offsets in official 6.3.0, 393988, and 393990: thirteen code-reference cells from the retained slot-reference audit plus one data cell with no retained code xref. The 393990 console module adds no new exact slot literal.

Across the thirteen xref-backed code bodies, 01021024 is the only observed slot writer and the only body with an object free. There is no observed successful teardown, replacement, or transition that clears the slot after successful initialization. The existing failure path in stock code frees before clearing the slot; therefore the original eager-publication constructor has a concrete free-after-publication window.

The separate 393988 VAD candidate already addresses that constructor defect. Its pinned acceptance-readback.json records these changes: allocate and clear 0x60, hold the allocation privately in r7, use the private pointer for failure cleanup and GPIO setup, and branch from 01021070 to the success-decision stub. On success (r4 == 0), the stub publishes r7 and returns through the original success path. On failure, it leaves r0 as the private allocation and branches to the existing free path; allocation-null exits without publishing or freeing. Publication therefore follows the last constructor status check, the binding pointer store at object+8, and the GPIO method call. The native object is not exposed by this constructor on an initialization-failure path.

The same constructor byte span (01021024, 0x10e bytes in the retained instruction export) is identical in 6.3.0, 393988, and 393990, so the late-publication fix is applicable to this 393990 baseline. The sparse VAD candidate is separately pinned to 393988 and must be re-based and relinked for 393990; this report does not authorize applying it.

No normal successful free is present in the audited direct users. The loader/snapshot reader holds the telemetry pointer only inside its short guard section and does not retain it after return. The observed main startup calls the constructor once, then performs the explicit guarded registration at 01021168; the state-machine callbacks and scheduler work follow afterward. No reentrant constructor caller is present in the retained call graph. These facts support the one-shot startup path, but do not prove absence of an opaque ROM, interrupt, computed-pointer, or shutdown-time free/replacement path. The original constructor has no serialization for a hypothetical concurrent second initializer; the delayed-publication failure path must not be treated as a global compare-and-swap.

For the current bridge design, the safe lifetime contract remains: publish once after successful initialization, do not free or replace the published object during operation, and do not keep the tail pointer beyond the guard-held record/snapshot operation. Any future teardown must first stop or drain all native callbacks that use the object; merely masking interrupts around the bridge copy does not cover every existing native reader or prove that an already-copied native pointer has expired.

## Constructor register ABI

The pinned C-SKY V2 ABI reference specifies r4-r7 as callee-saved. The constructor itself already depends on this convention: its frame saves r4-r7; it uses r7 after the call to 0108e250, and preserves the GPIO return status in r4 through the success logging call before the final status decision. The late-publication hunk extends the existing r7 live range across the zeroing wrapper at 0008009e, service lookup, logger calls, and indirect GPIO method. This is ABI-compatible and is not a new volatile-register assumption.

The zero wrapper's own copied-RAM body does not write r7, but dispatches through an unread ROM table target. The 0108e250 implementation and indirect GPIO method body are also unavailable. I do not claim those bodies from the ABI reference; the source-level contract is that callable callees conform to the C-SKY ABI. If vendor ROM code violates that ABI, the existing constructor already has broken live ranges, and the exact behavior cannot be established from these exports.

## Getter, writer, reader, and CPU ordering

In the native state-5 path, 010211f0 queues 01020b58 through scheduler helper 01021866; 01020b58 calls the existing one-argument getter at 0101fb68 exactly once. The main loop at 01032e70 dispatches 010217dc before invoking the state machine. The scheduled callback is one-shot and may be queued again on a later loop iteration while state remains 5. Delay 50 is provider-clock units; it is not a measured 50 ms callback cadence.

The VAD poll wrapper calls the getter before entering its PSR guard, reads the output only on getter success, then guards the slot lookup and telemetry record. The reader guards its slot lookup and full 32-byte snapshot and makes no getter call. The writer stores telemetry in CPU-side object memory after the native call returns; it does not pass the telemetry pointer to the getter. Thus the new bridge does not add a DSP query or ask the DSP to write this metadata. On a single CPU, the short nonblocking record and snapshot sections serialize against maskable same-CPU interrupt interleaving. The getter remains outside the mask, preserving the original call behavior.

The exact image contains a saved-PSR / clear-IE / restore-PSR pattern, and the separate IRQ audit records the C-SKY V2 irq_lock contract and memory clobber. This guard is a local CPU interrupt mask. It is not a DSP lock or a cross-core barrier, and no DSP-side writer, sampling freshness, or physical VAD meaning is established. The opaque body behind native getter 0101fb68 remains outside this lifecycle audit.

## Evidence and exact comparisons

The following raw instruction spans were hashed in each of the three pinned images; each row has one identical SHA-256 across official 6.3.0, 393988, and 393990:

| Function export | Start | Length | Shared SHA-256 |
| --- | ---: | ---: | --- |
| 01020b58.tsv | 01020b58 | 0x7c | d6ebe9f33f322e019b589c42afd9accb6f91e4415e65a855265a02bfa04d2eee |
| 01020d9c.tsv | 01020d9c | 0x60 | 07573dd3d7f813725cc3114d37f1c6c0a17eebff764f4165e3f21662bbe53cf2 |
| 01020f74.tsv | 01020f74 | 0x70 | a513ec2f9be9d3676de2ca5f7a453ad53bb6c00dc460c0af5cfe056c0f26ae5a |
| 0102100c.tsv | 0102100c | 0x12 | 9f7404addc96b2f5ae846b616bd09c3bf97a215ac671dca9771d9600bbe489f2 |
| 01021024.tsv | 01021024 | 0x10e | e8c00e61d55086db2185e2657dbde586fb08b47da98261ddf81ca800c07ed970 |
| 01021168.tsv | 01021168 | 0x5e | 6fc39ee391d521772407c90c9b2a5bedd0e662023735302f04a0b6b27a20e70c |
| 010211f0.tsv | 010211f0 | 0x288 | 09c3a723f1f5399885e4d12ecce2b75beff0a36e1748bef05a096cf4d20d1ffa |
| 010214a4.tsv | 010214a4 | 0x13a | 5f97b739414dde4296effb9e52708951e27dff53eb433ee330963c6200ac2c3a |
| 01021728.tsv | 01021728 | 0x8e | 815fe7f4f272efcb65bf8742baff7ba4b26900dd3f52015975f29652f22fadbd |
| 010217dc.tsv | 010217dc | 0x5e | 01b9e2619dd486f9ce6d7055819853e152d1921f4ecdb2536be9842a8b5bed257a |
| 01090054.tsv | 01090054 | 0x8 | a7f9360ca64e627decc9c6d0659b061452dcaddccae9f255f05d274b70692e8d |

The 6.3.0 main-loop callsite bytes also match the 393988 and 393990 SYS around:
- 01032f04 bsr 01021024; 01032f08 movi r0,0; 01032f0a bsr 01021168.
- 0103312e bsr 010217dc; 0103316a bsr 010211f0.

The complete 01032e70 function hash differs between 6.3.0 and 393988, so only these verified callsite windows are asserted as cross-version matches. The full 393988 and 393990 function span is identical.

Primary retained evidence:
- lifecycle-followup/REPORT.md, early-reader-order/REPORT.md, late-publication/REPORT.md, irq-snapshot/REPORT.md.
- object-tail-audit/REPORT.md and lifecycle-followup/state-slot-references.tsv, state-and-function-xrefs.tsv.
- firmware-integration/output/acceptance-readback.json and firmware-integration/INDEPENDENT-REVIEW.md.
- firmware/capture-vector-selected-diagnostic/REPORT.md and receipts/root-system-compose1.json.

## Remaining gates

- No exhaustive proof of all indirect/ROM/computed-pointer frees or shutdown teardown; do not claim global lifetime safety from the thirteen slot-literal users.
- The VAD bridge candidate and its lifecycle hunks remain a separate 393988 offline candidate; no 393990 VAD integration is established by these comparisons.
- Exact-image integration must retain the 0x60 allocation/zeroing needed by the VAD tail. Runtime allocation success is not required if the existing null-allocation path remains non-publishing and safe; 4-byte alignment is an existing native object ABI requirement, not a new VAD-only gate. Neither was independently exercised at runtime here.
- The getter's underlying provider, sample freshness, callback cadence in milliseconds, and raw word's speech/VAD meaning remain unknown.
- No hardware, USB, application, configuration, firmware generation, or Git action was performed in this closure.

No new source correction was necessary here. The concrete initialization-failure hazard is already addressed by the separately linked late-publication candidate. For this 393990 baseline, carry forward that exact success-only publication behavior and preserve its no-free-after-publication precondition; do not downgrade to the earlier publish-after-zero instruction, which exposes the object before the binding/GPIO status checks finish.


## Follow-up: what the guarded reload adds to the native contract

The post-getter slot reload does not create a new object-lifetime rule relative to the existing native Ref callback. In the retained 01020b58 body, the native getter at 0101fb68 returns first; only then does 01020b58 load slot 0x852c0, read object+4, and on the update branch store object+4. The VAD poll has the same relevant ordering: it calls that getter once, then reloads the slot and records into the object tail while guarded. Both paths therefore rely on the slot naming a live object after the getter and through their ensuing accesses. Replacing the object during the getter would also make the original callback operate on the replacement object; it is not a new VAD-only ordering assumption.

The VAD-specific spatial requirement is that the live allocation include bytes +0x40..+0x5f. The candidate constructor's 0x60 allocation and zeroing satisfy that requirement; an image with only the stock 0x40 allocation and the VAD tail access would have a concrete out-of-bounds write/read. This is a composition/layout gate, not a requirement that every allocation succeed. The existing allocation-null branch must remain a non-publishing failure, and the VAD loader rejects a null slot without dereferencing it. A malloc failure can therefore leave VAD unavailable; it need not be treated as lifecycle corruption. Likewise, 4-byte alignment is already required by stock `ld.w`/`st.w` accesses to the object's word fields (including object+8); VAD's base-alignment check rejects an invalid base but does not establish a stronger ABI requirement.

The accepted bounded lifetime contract can be the native global-slot contract: after successful initialization, slot 0x852c0 denotes one live object throughout operation; do not free or replace it during operation; a future shutdown must stop/drain consumers before releasing it. This is narrower than claiming every opaque ROM path was audited. The retained direct-user audit identifies the constructor as the only slot writer and finds no successful teardown/free in the inspected native bodies, but it cannot prove that no indirect or opaque shutdown path exists. If such a path is later introduced or found, it must satisfy the same lifetime contract already needed by the native callback; a slot clear by itself is insufficient if a consumer already holds a copied pointer. The bridge's short guard protects its own pointer lookup and 32-byte access against maskable same-CPU interrupt interleaving; it is not a general reclamation protocol for unguarded native readers, non-maskable/asynchronous activity, or another processor.

Concrete failure cases are therefore bounded: (1) a VAD-enabled image retains only a 0x40 allocation, so the tail access is outside the object; (2) a teardown frees/replaces the object while a native callback or guarded VAD access can still use a copied pointer; or (3) an independent producer writes the tail concurrently with the CPU record. Case 2 is an existing global-object lifetime violation, not a new assumption caused by the guarded reload. Case 3 would require an actual writer/address path: the VAD wrapper passes the native getter only a stack output word and does not pass the tail pointer, so no such DSP write is evidenced here. Treating a hypothetical hidden writer or hypothetical ROM free as an unconditional blocker would exceed the evidence. No retained evidence identifies either path; this is a bounded source-acceptance conclusion, not a claim of exhaustive ROM proof or physical validation.

Accordingly, source review need not add a separate all-ROM lifetime gate to the VAD change if it preserves single publication, does not add a successful free/replacement path, and retains null-safe allocation failure handling. Preserve the explicit future-teardown condition above, and verify the 0x60 allocation/tail composition in the exact image being accepted. The current selected 393990 decoded SYS still does not contain the separate VAD bridge candidate, so this conclusion is conditional on a future exact-image integration.
