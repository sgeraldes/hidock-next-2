# H1E 6.3.0 VAD constructor late-publication audit

## Result and evidence boundary

The constructor can keep the allocation private in `r7` and publish it only on the final success edge. The proposed success hook is the four-byte site `0x01021070..0x01021073`, after the GPIO method return and its status-dependent logging, and immediately before the original success return or failure free. This is a source-only proposal. It is not applied to an image and has no runtime, hardware, or IRQ-safety validation.

The instruction evidence is from the decoded official 6.3.0 image `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`, load base `0x01000000`. The constructor map is `research/rea/protocol-depth630-lab/audio-host/native/01021024.tsv`; the initializer order is `research/rea/evidence/h1e-6.3.0-functions/01032e70.c`; the explicit callback guard and scheduler call are `research/rea/protocol-depth630-lab/audio-host/native/01021168.tsv` and `.c`.

## Constructor control flow

`0x01021134` supplies the RAM slot address `0x852c0` to `r5`. On the empty-slot path, the constructor allocates at `0x01021056`; `r0` is compared with zero at `0x0102105a`. The current store at `0x0102105c` publishes the allocation before clearing or GPIO setup. After clearing, `0x010210a8` reloads the pointer from that slot into `r7`; before the indirect GPIO method, `0x010210de` loads the object pointer from the same slot again. Both reads must use the private `r7` value while publication is delayed.

The last status-producing operation is the indirect call at `0x010210ec`. Its exact setup is: object field `+8` supplies a GPIO device pointer in `r0`; `r1=0`, `r2=0x2a`, and `r3=1`; `r4` is loaded from the first function pointer in the device API table and called with `jsr r4`. The return status is copied from `r0` to `r4` at `0x010210ee`. If it is zero, the branch at `0x010210f4` reaches the success-log block at `0x01021112`; if nonzero, the error-log path returns to the common failure gate. The constructor does not pass a callback address or its private object in this indirect call's arguments. The exact API method implementation and any hidden side effects are unresolved, so this call is not identified here as callback registration.

Both successful log-level paths reach `0x0102106a`. Every observed post-allocation error path reaches the same gate with `r4=-1`; the API-error path reaches it only after `0x01021066` sets that value. At `0x0102106c`, a null pointer branches to the existing error return. For a nonnull pointer, the original decision at `0x01021070..0x01021073` sends `r4==0` to success at `0x01021038`; otherwise execution falls through to `0x01021074`, the free call. The retained constructor map has no other branch target at `0x01021070` or `0x01021072`.

The independent software callback registration follows the constructor in `0x01032e70`: `01021024()` then `01021168(0)`. `01021168` checks the slot for null before calling scheduler `01021866`; its callback literal at `0x010211e4` resolves to `01020f18` in the retained lifecycle export. Thus this explicit scheduled callback is registered only after the constructor returns. This ordering does not establish that no other early or interrupt-driven slot reader exists.

## Proposed source-only instruction changes

`r5` remains the slot address and `r7` holds the allocation privately. The proposed edits are:

| Address | Proposed bytes | Proposed instruction | Purpose |
| --- | --- | --- | --- |
| `01021054` | `3060` | `movi r0,0x60` | Request 96 bytes. |
| `0102105c` | `6dc3` | `mov r7,r0` | Retain the pointer privately; this does not change the allocation comparison flags used at `0102105e`. |
| `0102106a` | `6c1f` | `mov r0,r7` | Give the existing failure path the private allocation for its null check and free argument. |
| `01021070` | `e0080848` | `bsr late_publication_stub` | Replace the final status compare and branch with a success/failure decision hook. The linked displacement uses the illustrative `0x01122100` stub address. |
| `0102109e` | `3260` | `movi r2,0x60` | Clear 96 bytes. |
| `010210a8` | `6ddf` | `mov r7,r7` | Preserve the private pointer after the clear instead of reloading the unpublished global slot. |
| `010210de` | `6cdf` | `mov r3,r7` | Supply the private object to the existing `+8` GPIO-binding load before the API call. |

The isolated stub compares `r4` with zero. For a nonzero failure status it jumps to the existing free at `0x01021074`; `r0` still contains the private pointer, and the slot has not been published by this constructor. The unchanged cleanup then clears the slot and returns `-1`. For zero status, the stub stores `r7` through `r5` and jumps to the existing success return at `0x01021038`. That route bypasses the free. Allocation-null still has `r7=0` and exits through the existing null check without freeing. An already-nonnull slot still bypasses allocation and the new hook.

The private-pointer live range relies on the C-SKY ABI rule that `r4-r7` are callee-saved. It now crosses the zeroing wrapper at `0x0008009e`, the GPIO lookup at `0x0108e250`, logger calls on failure/success paths, and the indirect API method at `0x010210ec`. Existing constructor code already uses `r7` after the GPIO lookup, and carries `r4` status across the success logger, but it loads `r7` only after the zeroing wrapper and does not retain the private pointer across every new interval. The zeroing wrapper dispatches through a ROM table and its final target is not recovered; the indirect API method body is also unresolved. Callee-saved preservation by these callees is therefore an implementation assumption to verify, not byte-level proof.

## Isolated assembler evidence

`late-publication.s` was assembled and linked separately with the C-SKY ABI-v2 Binutils 2.27 tools. `late-publication.objdump.txt` confirms the requested instruction encodings and that the hook `bsr` relocates to the standalone stub. The linker-only stub address `0x01122100` is a synthetic placement for this encoding check, not an allocated code location. The pinned official image has exclusive end address `0x01122040`; no firmware image was patched or generated. Only the isolated ELF below was linked.

Files in this folder are the complete isolated evidence set: `late-publication.s`, `late-publication.ld`, `late-publication.o`, `late-publication.elf`, and `late-publication.objdump.txt`. The linked ELF contains padding between instruction sites, so its `bkpt` padding in disassembly is not proposed code; only the tabled replacement addresses and stub are part of the proposal. The replacement at `0x010210de` is required because the original instruction reloads the slot, which remains null until the final success store.

## Conditions that remain open

- The constructor has no visible serialization or lock. The private-free argument assumes no concurrent or reentrant constructor publishes a different pointer into `0x852c0` while this call is in progress; otherwise the existing failure clear could erase another initializer's slot.
- Delayed publication leaves the slot null until setup succeeds. The bounded 13-user object-tail audit lists direct users without pointer-null guards, including `01020b58`, `01020d9c`, `01020f74`, and `0102100c`. The main init order proves the explicit `01021168` registration is later, but invocation timing for all other callers, interrupts, and indirect/ROM consumers is unknown.
- No callback pointer is passed to the GPIO API method, but its implementation is unresolved; unobserved global or asynchronous effects are not ruled out.
- A reader that already copied the pointer is not synchronized with a future free. Successful teardown ownership and other free paths remain unproven. This proposal removes the constructor's free-after-publication path; it does not prove complete object-lifetime safety.
- The size extension from `0x40` to `0x60`, allocator success/alignment, installed-image identity, and physical behavior remain separate unverified conditions.

## Evidence files

- Constructor instruction map: `research/rea/protocol-depth630-lab/audio-host/native/01021024.tsv`.
- Main init sequence: `research/rea/evidence/h1e-6.3.0-functions/01032e70.c`.
- Explicit scheduler registration: `research/rea/protocol-depth630-lab/audio-host/native/01021168.tsv` and `.c`.
- Bounded direct-user/field audit: `research/rea/completion630-lab/hardware-vad-trace/object-tail-audit/REPORT.md` (read-only; not edited here).
- Isolated assembly/link evidence: files in this new `late-publication/` folder.


## SHA-256 pins

| File | SHA-256 |
| --- | --- |
| Official decoded source image | `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` |
| Constructor instruction export `01021024.tsv` | `7b1cf588732f52498e883e69d908ea1cc20f311a76299dd72da09f278ca184a7` |
| Callback-registration export `01021168.tsv` | `370a4f10c06a0b55e35fcd4bc9af662f19fd36500e5d39d6e299c3559a65df21` |
| Startup-order export `01032e70.c` | `46077fb7c3e5b4b56b5c9c2e32596cd29f41a1da60aace5a76c66efe279e88e4` |
| `late-publication.s` | `a5ff54487d85f08ec00ee88afab3ff205aa8e7aeb633bd74488cca2a3aa6d163` |
| `late-publication.ld` | `dc3e9a04c59ce75d785020e7e6ef740d97ae7cefea07cce0634acc60f81b2ad9` |
| `late-publication.o` | `8cce95d1b8cd410a6f4e8f39c4c521e137c94a5ff1cdd0ce3b68ce30826f3c95` |
| `late-publication.elf` | `8a380cdd6cd2d20e6ece34cc33f6992a491cb2ccaa069eced2bcfc53aa5fb604` |
| `late-publication.objdump.txt` | `e7f25c14ed3435ccf66fee259c56e9872bacde2da85218dfe2feffe837747cfc` |




