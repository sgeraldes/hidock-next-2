# H1E 6.3.0 RAM-slot object-tail audit

## Result and evidence boundary

**Bounded source result:** the retained direct users of RAM pointer slot `0x852c0` do not access the proposed appended range `[object+0x40, object+0x5f]`. Existing object-field accesses stop at `+0x3d` in the version-buffer call; the constructor allocates and clears exactly `0x40` bytes. One same-allocator source caller requests and clears `0x60` bytes, so a 96-byte request is present in the retained codebase. This supports the size-extension proposal at the source/API-callsite level, but does not establish allocator alignment or successful allocation at runtime.

The audit is pinned to official `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin` (SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`). The frozen offline comparison image is `research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin` (SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`). The previously recorded byte parity for the constructor span is an offline comparison only; it is not installed-device evidence. No device, firmware patch/generation, Git operation, or Ghidra project was used for this audit.

`0x852c0` is the RAM **slot** holding the object pointer. The literal-reference exports contain 13 unique code-literal cells used by 13 function bodies; cell `0x0110d5f8` also contains `0x852c0` but has no code reference in the retained xrefs. Rows below distinguish accesses to the slot from accesses through its loaded object pointer `p = *(uint32_t *)0x852c0`.

## Retained direct users

| User (slot literal cell; load PC) | Access through `p` | Pointer / operation boundary and maximum shown by the caller |
| --- | --- | --- |
| `01020b58` (`01020bec`; `01020b88`) | Read `p+4` as one byte; conditionally write one byte after repeated successful Ref reads differ. | No object pointer passed onward. |
| `01020bfc` (`01020cbc`; `01020c00`) | Read `p+3` and `p+6`, one byte each. | No object pointer passed onward; meanings of these two bytes are not resolved here. |
| `01020cf4` (`01020d94`; `01020d50`) | Write state byte `p+0 = 2` on this path. | No object pointer passed onward. |
| `01020d9c` (`01020e14`; `01020dce`) | On getter success, write Energy low byte at `p+1`. | The xref export shows data references to this function but no direct call edge; execution/refresh cadence is unproven. |
| `01020e20` (`01020ee4`; `01020e34`, `01020e64`, `01020eb0`) | Read/write state byte `p+2`; `01020f0c` also calls it with selector `8`. | No object pointer passed onward. |
| `01020f18` (`01020f68`; `01020f1c`) | Read state byte `p+0`. | Selects a local one-byte command payload; a scheduled callback is given, not the object pointer. |
| `01020f74` (`01020fe4`; `01020f78`) | Read/write state byte `p+0`; pass `p+0x0c` with size `0x32` to `0101faf4`. | Caller-specified byte bound is 50 bytes, nominally `[p+0x0c,p+0x3d]`. The retained chain reaches `0102041c`/`01020398`; the lower operation's body, access direction/width, and retention lifetime are not recovered. |
| `0102100c` (`01021020`; `0102100e`) | Load the four-byte binding pointer at `p+8`. | Passes that binding pointer to `01020b1a` with operation `0x15`; this is not the state-object pointer. The callee dispatches indirectly. |
| `01021024` (`01021134`; `01021028`) | Allocate object with request `0x40`, clear `[p,p+0x3f]`, set `p+2` to one byte, and store the binding pointer at `p+8` (four bytes). | Passes whole `p` only to the zeroing wrapper with length `0x40`; later passes the `p+8` binding to an indirect driver method. Failure cleanup frees this allocation; the current source clears the slot after the free. No successful teardown/free is shown by these direct users. |
| `01021168` (`010211c8`; `0102116c`) | Read the slot word to test whether `p` is null; no object field is accessed in this function. | Schedules the callback stored at `010211e4` without passing `p`. |
| `010211f0` (`01021370`; `010211f4`) | Read/write state byte `p+0`; load the four-byte binding pointer at `p+8`. | Passes the binding pointer to indirect operation `0x2a`; does not pass whole `p`. |
| `010214a4` (`010215e0`; `010214a8`) | Read the slot word for null; on the valid option path read/write state byte `p+0`. | Option command is passed to `0x00000b38`; whole `p` is not passed. |
| `01021624` (`01021700`; `01021628`) | Read the slot word for null; the retained body has no dereference through `p`. | The remaining getter path uses the option helper/static table; no whole-object pointer is passed. |

Across these bodies, the defined field locations requested for this audit are all within the old allocation: state `+0`, Energy cache `+1`, init/cache byte `+2`, additional byte reads `+3`/`+6`, Ref cache `+4`, and GPIO binding pointer `+8..+0xb`. The sole bounded buffer operation begins at `+0xc` and is passed a `0x32` size. The constructor's current clear reaches `+0x3f`; no retained direct access or caller-supplied size reaches `[+0x40,+0x5f]`.

The accompanying function-xref export records the direct call `0103316a -> 010211f0`. It records data references to `01020b58` at `010214a0`/`0110ee1c` and to `01020d9c` at `01021618`/`0110ee28`; data references alone do not establish invocation. The other entries above are retained code bodies that contain the slot literal, including possible table/callback users, not a claim that every body is currently reachable.

## Allocation, aliases, and lifetime

`0105a24c` is a wrapper: its retained body forwards the requested size twice plus `DAT_0105a25c` to `0103cc5c`. The underlying allocator body and the global's alignment semantics are absent from the retained source exports, so alignment guarantees and a successful 96-byte allocation under actual heap state remain unknown.

Existing same-wrapper callers provide a useful source-level bound: `0103baf8` requests `0x60` and clears `0x60`; `01059bec` requests `0x78`; `0102c02c` requests `0xc0`; and `0102b67c` requests `0xdc98`. Their source continues with the returned pointer only on non-null branches. These callsites show that the wrapper is used with request values at least 96 bytes; they are not runtime proof that this constructor's request will succeed or that the returned address meets a particular alignment.

No retained direct-user body copies the whole state pointer into another slot or frees it except the constructor failure cleanup. The `+8` binding and `+0xc` buffer pointers cross indirect/native boundaries, so their lower-level retention behavior is unknown. The constructor proposal in `lifecycle-followup/lifetime-fix/REPORT.md` delays publication until after the clear and detaches the slot before failure-path free, but it is not applied; neither change revokes a pointer already copied by a concurrent reader. Successful teardown, shutdown ownership, and all indirect/ROM consumers remain outside this proof. Do not generalize this result to unretained ROM code, every possible indirect consumer, or a physical 6.3.0 device.

## Remaining questions for implementation

- Keep the appended 32-byte tail independent of the existing `+0x0c` version buffer. The caller provides a `0x32` bound, but the lower `01020398` provider's actual read/write width and whether it retains the pointer are unknown.
- Preserve the existing first-64-byte layout and use the proposed guard around each tail access. The proposed native getter stays outside the IRQ guard; its provider/write width still needs evidence at the real provider boundary.
- Before treating constructor publication/free reordering as safe, establish reader/free synchronization for pointers already loaded from the slot. The source audit proves no direct tail conflict; it does not prove concurrent lifetime safety or the complete ROM call graph.
- Confirm allocator alignment and 96-byte success in the authorized runtime boundary before describing the extended object as working. Existing source callsites alone do not provide that observation.

## Evidence files

- Slot inventory and code/data references: `lifecycle-followup/state-slot-references.tsv`, `lifecycle-followup/state-slot-literal-hits.tsv`, `lifecycle-followup/state-and-function-xrefs.tsv`.
- Current user decompiles/disassembly: `research/rea/protocol-depth630-lab/audio-host/native/{01020cf4,01020d9c,01020e20,01020f18,01020f74,0102100c,01021024,01021168,010211f0,010214a4,01021624}.{c,tsv}` and `native-extra/{01020b58,01020bfc}.{c,tsv}`.
- Constructor and prior lifecycle details: `lifecycle-followup/REPORT.md`, `lifecycle-followup/lifetime-fix/REPORT.md`.
- Allocator and size examples: `research/rea/completion630-lab/tts-demo-trace/ghidra-export/0105a24c.tsv`, `.../tts-demo-functions.c`; `research/rea/evidence/h1e-6.3.0-marker-rules/thread-ownership/source/0103baf8.c`; `research/rea/recovery630-lab/source/01059bec.c`; `research/rea/evidence/h1e-6.3.0-functions/{0102c02c,0102b67c}.c`.
