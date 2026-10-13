# Early-reader order audit

## Finding

On the retained native path, the four unguarded slot readers are not reached before `01021024` returns. The startup function `01032e70` calls the constructor at `01032f04`, then calls guarded registration function `01021168` at `01032f0a`, completes more initialization, and only then enters its event loop. Each loop dispatches the scheduler at `010217dc` (`0103312e`) before running the state machine at `010211f0` (`0103316a`). The known state-machine routes to `01020b58`, `01020f74`, and `0102100c` therefore occur after constructor return; no native direct-call or registered-callback route to `01020d9c` is established.

There is one concrete constructor self-dereference that a delayed-publication edit must handle: original `010210de–010210e2` reloads `*slot` and dereferences its `+8` field to prepare the GPIO API call. If the constructor leaves the global slot null, that original sequence faults. The late-publication proposal's `010210de: mov r3,r7` substitution is required to use the private allocation there. With that substitution, the four-reader question has no concrete early caller in the retained native chain. An asynchronous GPIO/API side effect, an interrupt, or another opaque/indirect initializer could still call a reader while the slot is null; the present evidence neither identifies such a route nor proves it cannot exist.

## Exact reader paths

| Reader | Retained path and ordering | Early-path conclusion |
| --- | --- | --- |
| `01020b58` | State 5 in `010211f0` checks queue membership, then queues this callback through `01021866` with delay `50`, flags `0` (`01021452–01021462`). `010217dc` dispatches queued callbacks indirectly. | Enqueued by the main-loop state machine after constructor return. Queueing does not invoke the callback inline. Other pointer cells `010214a0` and `0110ee1c` contain the address, but the retained xrefs classify them as data; no other executed consumer is established. |
| `01020f74` | State 4 in `010211f0` queues this callback through `01021866` after a membership check (`010213ec–01021404`). | Enqueued after constructor return. The callback's body reads the shared object without a slot-null guard. The separate post-constructor registration `01021168 -> 01021866` uses callback cell `010211e4`, whose value is `01020f18`, not a direct call to `01020f74`. |
| `0102100c` | State 1 reaches switch target `01021468`, which directly calls `0102100c`; it then stores state byte `3` (`01021468–01021470`, followed by the common store at `010212b6`). | Direct call from `010211f0`, which the retained `sugr_app_main` loop invokes only after the constructor and post-constructor setup. |
| `01020d9c` | No executed-code caller or scheduler registration is established in the retained xrefs. Cell `01021618` contains its address but overlaps the switch table: `010211f0` reads selector-table bytes at `0102125a–01021262`, then the selected case starts at `01021264`; the apparent pointer load is not executed as a callback call. Cell `0110ee28` is only a data reference in the retained export. | No known native main-init/scheduler chain reaches it. The unexplained data cell and unenumerated indirect consumers leave invocation unresolved. |

The three queued/direct routes follow from the unsigned selector mapping already documented in `scheduler-switch-followup/ADDENDUM.md`: raw states 1, 4, and 5 dispatch respectively to `01021468`, `010213e8`, and `01021424`. The dispatcher `010217dc` invokes a record's callback with `jsr r3`, then clears that record. A callback newly queued by `010211f0` cannot be run by the immediately preceding dispatch pass; it is eligible on a later pass. The value `50` is a scheduler clock-unit delay, not established milliseconds.

## Constructor, callbacks, and reentrancy

The only retained direct constructor callsite found in the current source exports is `01032e70:01032f04`; the surrounding initialization sequence is in `research/rea/evidence/h1e-6.3.0-functions/01032e70.c/.tsv`. `01021168` is called next at `01032f0a`. It checks the global slot at `01021170–01021174`; if null it returns `-1` without queueing. If nonnull it registers callback `01020f18` via `01021866` at `010211a6`. Its scheduler call is thus after the constructor. The event loop and its indirect message callback are later still.

The constructor's GPIO setup at `010210ec` is an indirect `jsr r4`. Its setup passes the GPIO device pointer, `r1=0`, `r2=0x2a`, `r3=1`; it does not pass any of the four reader addresses or a reader callback. The device API implementation is unresolved. This supports no concrete pre-publication path to the four readers through the visible arguments, but it does not exclude hidden global or asynchronous effects inside that implementation. Earlier opaque setup calls in `01032e70` also were not recursively audited for indirect registrations or interrupt enablement.

No reentrant constructor callsite is identified in the retained direct-call exports. The constructor's initial nonnull check is not a lock: leaving the slot null until success means a concurrent/reentrant call would also take the allocation path. Thus single-call startup ordering is verified for the observed `sugr_app_main` path, while global serialization and absence of external/indirect constructor callers remain unknown.

## `r7` across the zeroing wrapper

The proposed private-pointer path retains the allocation in `r7` across the zero call at `010210a4` to copied-RAM entry `0008009e`. Startup copies `[01115290,011174f7)` to RAM `[80000,82267)`, so `0008009e` maps to source image address `0111532e` / file offset `0x11532e`. The retained source bytes begin `D0 14 A4 33 62 43 61 93 CD 7B 90 14`. The wrapper itself uses `r3`/`r1`, pushes and restores `lr`, and does not write `r7`; it loads a function pointer through RAM/ROM dispatch and calls that target indirectly. The target body is not recovered. Therefore `r7` preservation by the wrapper's final callee remains an ABI assumption, not a bounded byte-level proof. The existing `lifetime-fix/REPORT.md` records the same limit.

## Minimum source gate supported by this audit

For the late-publication proposal, retain the allocation privately (`0102105c`), keep that value through the zeroing call (`010210a8` must not reload the null slot), replace the failure-path slot reload at `0102106a` with the private pointer so only this allocation is freed, replace the GPIO-preparation reload at `010210de` with `mov r3,r7`, and publish only on the final success edge at the `01021070` status decision before returning. This prevents the constructor's own post-publication failure cleanup and the specific null dereference at `010210de`. The observed main-init registration and the three state-machine paths then begin only after return. This gate is supported for the observed native path; it does not establish interrupt exclusion, opaque GPIO behavior, complete caller coverage, or `r7` preservation by the indirect zeroing target. Those remain prerequisites to claiming global lifetime safety.

## Evidence pins

All address claims refer to `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`, base `0x01000000`.

| Evidence | SHA-256 |
| --- | --- |
| `evidence/h1e-6.3.0-functions/01032e70.c` | `46077fb7c3e5b4b56b5c9c2e32596cd29f41a1da60aace5a76c66efe279e88e4` |
| `evidence/h1e-6.3.0-functions/01032e70.tsv` | `3f5923c8d744b2805bf1c2d38b696b5ddd814ce52fe8896ce45f8bc33b65c86a` |
| `audio-host/native/01021024.tsv` | `7b1cf588732f52498e883e69d908ea1cc20f311a76299dd72da09f278ca184a7` |
| `audio-host/native/01021168.tsv` | `370a4f10c06a0b55e35fcd4bc9af662f19fd36500e5d39d6e299c3559a65df21` |
| `audio-host/native/010211f0.tsv` | `7d986964c1e06c96d6a0c48fa449595683d0b80010e25eac01ee090f564b21a6` |
| `audio-host/native/01020f18.tsv` | `977b43a2088395f83f15bcf0abc8e259c3adb36ab0b484dafa04a71c7d40389d` |
| `audio-host/native/01020f74.tsv` | `39aa2373291bde6cb95a93c51e45bf2621d4e8bf9adbdb281dd622938e644340` |
| `audio-host/native/0102100c.tsv` | `b35be8f5e6e429e52d8dd38293658caad8ea860a7989947237dbc4468ac431af` |
| `audio-host/native/01020d9c.tsv` | `2f01eae1878f04d44f9bd99980a7e0a6e91bcbc47a96fa9880beb83a1a3ff33d` |
| `audio-host/native-extra/01020b58.tsv` | `7cd5f8cf6d9be33828b02f7751d7cecba826aab949adc9e753352a9136db14f9` |
| `audio-host/rome-loader-disassembly.txt` | `404a468fc57f7b2fe719efae191787563616c8651b124b2f2b2092b0e174b85a` |
| `hardware-vad-trace/current630/read-target-xrefs.tsv` | `6980d6bf565fe30e6c2cb9ec376c629cf306ba8a65c8dceb0051088000936a96` |
| `hardware-vad-trace/current630/read-cell-xrefs.tsv` | `01da059c3df4f8a227858bc9f3108e3c1d2e11af3834cb77990288aaaf964b2e` |
| `hardware-vad-trace/current630/read-cell-outgoing.tsv` | `0f29c06b97d5e3b2a0b9716262298e43f51474d4d90152f3d72b3b481a53b222` |
| `audio-host/native/calls.tsv` | `ef081e63c9290fa0b3d284cae66dc07356469c4081d7b6ac03bc451821816803` |
| `audio-host/native/incoming.tsv` | `c49dd7da7b05494021bb9fa59f4f2f67cb1bc5ca112b6676f1d1d4793c807623` |

The image and exports were read-only; this audit did not use Ghidra, alter firmware, or access hardware.
