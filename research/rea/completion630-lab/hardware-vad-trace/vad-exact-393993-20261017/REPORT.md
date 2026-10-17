# 393993 four-case exact-image instruction gate

**Result:** the one parent-approved run passed all four requested cases. The Ghidra process and receipt validator both exited 0. The run used the pinned decoded 393993 SYS directly; it did not build, compose, or modify firmware and did not access the device, USB, app, or flash.

The exact SYS was `research/rea/completion630-lab/firmware/producer-rom-fixed-probe-candidate/out-NOTINSTALL/composed-run8-wrapper-fallbacks/system-decoded-NOTINSTALL.bin`, SHA-256 `05d7d9e2d725b4624b4746b09cea58eed9aded63b1fc377255ac2c5fc41dec8b`, 1,237,504 bytes. The read-only Ghidra import was checked against the complete SYS byte-for-byte. The separate composition copy hash matched the same SHA.

There is no candidate ELF, symbol file, or layout readback beside this 393993 composed SYS, and no `comparison.json` beside the compatibility report. The pinned 393992 ELF (`50d0a27d…d4a80`), symbols (`7222b982…a59a8`), and layout (`5fd4795a…424b1`) are recorded only as references for unchanged entry addresses. The receipt explicitly leaves `candidate_elf_sha256` null; no ELF identity or link provenance is inferred for 393993. The old layout's baseline SYS is `ebee46c5…168771`. The composition manifest predecessor is `9a5fd3df…71b8f`, which is also not presented as the pinned 393992 SYS.

| Case | Result | Instructions | Observed result |
|---|---|---:|---|
| F11A absent snapshot response | PASS | 1,060 | Return 32; exact reply `0201000000000000000000000000000000000000000000000000000000000000`; getter calls 0 |
| F11A present snapshot response | PASS | 1,018 | Return 32; exact reply `0001010100000005000000040000000087654321000000000000000000000008`; all fields including native status at offset 12, padding, and flags checked; getter calls 0 |
| Poll bridge success | PASS | 88 | Hook `0x01020b62` reached bridge `0x01128e34` once; one getter fixture call with `r0=0x0038e100`; tail `[2,1,1,0,0x87654321,0,0,1]` |
| Poll bridge failure | PASS | 78 | Hook reached bridge once; one getter fixture call with the same bounded pointer; return `-5`; tail `[2,1,0,0xfffffffb,0,0,0,0]`, so the fixture's `0xdeadbeef` word was not published as a valid sample |

Both F11A cases start directly at the `console630_response` wrapper entry `0x01128bf4`. They do not cover the original F11A ingress/parser path. The poll fixture starts at `0x01020b62`, stops at `0x01020b66`, and requires `r0=0x0038e100`, inside `[0x0038e000,0x00390000)`. Only the native getter boundary at `0x0101fb68` was modeled, once in each poll case; no other ROM instruction fetch was modeled. All RAM was synthetic.

The candidate bytes at the two retargeted fallback BSRs (`0x01128cfc` and `0x01128db4`) were pinned during input validation. This run does not claim those branches were executed; the mux routes have separate exact-image evidence. This result also does not establish DSP behavior, live memory, timing, boot order, installation, or physical hardware semantics.

The full per-case receipt is [receipt.json](out-NOTINSTALL/run-final-05d7-four-cases/receipt.json), SHA-256 `b6223628a49ef22a90e96e9777eb8474d523579b93b9cec8e761723619caced3`. `run-meta.json` records Ghidra process exit 0 and the matching temporary SYS copy hash. The only approved run command and complete pins are in [README.md](README.md) and [gate-plan.yaml](gate-plan.yaml).
