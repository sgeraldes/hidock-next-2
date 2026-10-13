# H1E 6.3.0 VAD state and scheduler lifecycle follow-up

This bounded source audit uses decoded image `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`. The retained current-image disassembly/decompiler exports are read-only evidence; no firmware, device, application, or USB operation was performed for this report. RAM literals and code/table bytes are kept distinct below.

## State object and lifetime

`0x000852c0` is a **RAM pointer slot**, not the state object itself. `01021024` checks the slot, allocates `0x40` bytes when empty, stores the returned pointer in the slot, zeroes the object, sets byte `object+2` to `1`, and stores the GPIO binding at `object+8`. If the GPIO initialization path fails, it frees the allocation and clears the slot. The main-loop startup calls this initializer once before entering its loop (`01032e70`).

Within the audited code, the readable byte contract is: `object+0` is the state byte consumed by `010211f0`; `object+1` is the last successfully fetched Energy low byte written by `01020d9c`; `object+4` is the filtered RefChannelVAD low byte written by `01020b58`. The two cache bytes change only when their respective helpers run and return success. They are therefore cached values, not inherently fresh reads. For a bridge, first load the object pointer from `*(uint32_t *)0x852c0`, validate it as nonzero, then read the desired offsets from that object. Do not interpret firmware image literal cells such as `01020bec` or `01020d94` as the runtime object.

One observed state-5 writer is `01020f74`: it calls `0101faf4(object+0xc, 0x32)`; return zero writes state `5`, nonzero writes state `2`. This establishes the operation-result branch, not that state 5 means DSP firmware load complete or that physical VAD is ready. `010214a4` can move an initialized object from state 0 to state 2 on its valid-command path. The cases in `010211f0` have different effects: the reset path pulses GPIO and writes state 3, while selector 5 exits after queue management without changing the state byte. Thus state 5 remains eligible for later poller re-registration. No normal successful-init free/slot-clear or transition back to state 0 was found in the bounded xrefs. The sole observed free/clear is the initializer's failure path; process-shutdown ownership remains unproven.

## Poll scheduling, clock, and dispatch

The selector-5 branch of `010211f0` conditionally inserts callback `01020b58` with delay `50`, flags `0`, after checking ten 16-byte scheduler records for an existing copy. The records begin at RAM `0x852cc`; insertion and membership use the same table. `01021728` stores callback, argument, deadline (`01090054` result plus delay), and flags in each free record. `010217dc` scans the records on each invocation, runs callbacks whose deadline is reached, then clears the callback pointer. This is one-shot dispatch; `010211f0` may queue the poller again on a later main-loop pass while the state remains 5.

The app loop `01032e70` invokes `010217dc` once per iteration after event handling and then invokes `010211f0`; its event wait is passed a maximum value of `5`, but loop work and event timing mean this does not prove a callback cadence. The current-image `01090054` body at `01090054–0109005a` loads two words via the image cell at `0109005c` and returns them. The scheduler treats the low word as its clock value. The native body alone does not encode a unit label.

Independent evidence supports millisecond scale but does not calibrate VAD dispatch cadence: the retained manifest-design lifecycle map labels the same provider in a marker elapsed-time path as `now_ms`; a read-only physical H1E 393988 uptime comparison (`research/rea/completion630-lab/runtime/current393988-vad-clock-1791884616990-root.json`, SHA-256 `ca131928b53da574f9c7f14f13121e50b23d4e4128ea74947eb40c21734db7bb`) measured device delta 2054 against host midpoint delta 2046.32545 ms (7.67455 ms absolute difference, ratio 1.0037504). That observation is on 393988 and is not image-attested for 6.3.0. Consequently, describe `50` as provider-clock units, with millisecond interpretation supported by adjacent firmware/runtime evidence; do not state a 50 ms measured callback period.

## Energy registration and remaining limits

`01020d9c` writes `object+1` after its Energy getter succeeds. No executed-code registration/call to this helper was found in the bounded xrefs: the cell at `01021618` contains its address but overlaps the selector table and is data, not an executed call. The periodic callback queued by `01021168` is the pointer stored at `010211e4`, whose image value is `01020f18`; it is not `01020d9c`. Energy scheduling/refresh cadence therefore remains unknown.

Cancellation helper `01021870` clears matching callback entries. The retained direct-call list shows a single caller (`0102267c`); it does not establish cancellation or teardown for `01020b58`. No provider/cache writer at callback slot `0x80e70`, physical VAD route, loader-completion/failure mapping, current-6.3.0 physical VAD result, or successful teardown path is established here. The separate provider-slot investigation remains owned by the other audit.

## Evidence pointers

- Current source image and dispatch/state exports: `research/rea/protocol-depth630-lab/audio-host/native/{01021024,01020f74,010211f0,01021728,010217dc,010214a4,01021624,01021870}.c/.tsv`; getters: `native/01020d9c.c` and `native-extra/01020b58.c`.
- Main-loop export: `research/rea/evidence/h1e-6.3.0-functions/01032e70.c/.tsv`.
- Selector/table disambiguation and queue membership proof: `research/rea/completion630-lab/hardware-vad-trace/scheduler-switch-followup/ADDENDUM.md`.
- Bounded Ghidra export for slot references and xrefs: this directory's `state-slot-references.tsv`, `state-slot-literal-hits.tsv`, and `state-and-function-xrefs.tsv`.
- Clock contract/supporting physical sample: `research/rea/completion630-lab/firmware/console-bridge-contract.json`, `firmware/manifest-design/lifecycle-hook-map.md`, and the 393988 runtime artifact above.
