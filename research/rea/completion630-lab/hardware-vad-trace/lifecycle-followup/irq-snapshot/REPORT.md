# H1E 6.3.0 IRQ and telemetry snapshot contract

This bounded audit uses `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`. It records source evidence and a minimum same-core snapshot contract; no firmware, device, application, USB, or hardware state was changed.

## Exact-image IRQ and clock evidence

At `01074600`, the current image saves PSR (`01074606: 00 c0 24 60`, `mfcr r4,psr`), clears IE (`0107460a: 80 c0 20 70`, `psrclr ie`), calls `01090054` at `01074634`, then restores the saved PSR (`0107464c: 04 c0 20 64`, `mtcr r4,psr`). Raw bytes were checked directly in the hashed image; the same sequence appears again at `01074654/58/5c`. This establishes that the image uses a save-disable-restore pattern and calls the clock provider with IE cleared in this path. It does not establish a named `irq_lock` API or justify copying this function's longer masked region.

`01090054` loads a pointer from literal cell `0109005c` and reads two 32-bit words at pointer offsets 0 and 4. The cell's first word is `0x0008972c`; Ghidra reports that target as unmapped. Neither word's semantic role nor the writer of this pair is identified in the current decoded image. A bounded scan of the startup-copy source bytes `[0x01115290, 0x011174f7)` (8,807 bytes, copied to RAM `0x80000..0x82266`) found no little-endian 32-bit literal in `0x8970c..0x8974c`. No RAM overlay was made.

## Narrow local IRQ contract

The related pinned ATS2853P2 SDK implements `irq_lock` by reading PSR, executing `psrclr ie`, and returning the saved value; `irq_unlock(key)` writes that saved value back to PSR. Its inline assembly has a compiler `memory` clobber, and its CK802 header defines PSR IE as bit 6 (`0x40`). This is useful source-qualified C-SKY guidance, not proof that the exact H1E 6.3.0 build uses that SDK revision: the retained SDK manifest explicitly says exact HiDock ROM/board compatibility is unknown. The broader `sys_irq_lock` API in that SDK also changes scheduler/VIC state and is not the small snapshot primitive described here.

For a producer that must preserve a DSP getter's behavior, call the existing DSP getter with interrupts enabled. Then enter a short saved-key IRQ section, recheck the state pointer, publish the status/raw bytes and timestamp as one record, and restore the exact saved PSR. Do not call the DSP getter, wait, yield, log, enqueue work, or perform another potentially blocking operation while masked. If the timestamp must be paired with the publication, `01090054` is only a short two-word load in the target and is already called from an IE-cleared path; nevertheless, coherence of those words is conditional on their writer being a maskable interrupt on this same core, which remains unproven.

A same-core reader can use the same short saved-key section to recheck the pointer and copy the state/raw/timestamp record coherently. Keep all operations nonblocking and restore the saved key, including when interrupts were already disabled on entry. In the related SDK, a thread's IRQ lock is thread-specific and does not remain effective while that thread sleeps or yields, so the snapshot must not yield. This local CPU mask does not synchronize a separate DSP or a writer on another core.

The object pointer slot is RAM `0x852c0`. The lifecycle audit found allocation at initialization and free/slot-clear only on initialization failure; it found no normal successful teardown, while shutdown ownership remains unknown. A pointer recheck under the IRQ mask is not, by itself, a lifetime guarantee against an unlocked freer, another core, or a teardown outside the guarded protocol. A bridge must establish that the object remains owned/alive for its snapshot, or require pointer replacement/free to follow a matching synchronization protocol.

## Clock/task context and limits

The current-image main loop `01032e70` runs the scheduler dispatcher and state selector in task context. The exact writer and update context for `0x8972c` are absent from mapped image evidence, so the proposed reader lock cannot yet be claimed to make that pair atomic. The related pinned SDK offers a plausible pattern: `kernel/sys_clock.c` protects a volatile 64-bit tick-count read and update with `irq_lock`, and `drivers/timer/acts_timer.c` calls the tick announcer from a timer ISR. This is an analogy only; the H1E 6.3.0 image has not been tied to that counter symbol or timer configuration.

Separately, a read-only 393988 runtime sample measured 2,054 ms of device uptime against 2,046.32545 ms host-midpoint time (absolute difference 7.67455 ms, ratio 1.0037504; artifact SHA-256 `ca131928b53da574f9c7f14f13121e50b23d4e4128ea74947eb40c21734db7bb`). This supports millisecond-scale progression for that 393988 observation, not the semantics of the high word, the 6.3.0 writer, or actual VAD callback dispatch cadence.

## Evidence pointers

- Exact-image disassembly: `research/rea/completion630-lab/hardware-vad-trace/lifecycle-followup/lifecycle-functions.tsv` (`01074600`, `01090054`); pointer-cell record: `clock-provider-cell.tsv`.
- State pointer lifecycle and main-loop scheduling: sibling `../REPORT.md`.
- Related SDK pinned revision `3816894bbdae3ad84909108916eb80e9bc8b628c`: [`irq_manage.c`](https://raw.githubusercontent.com/kongqj1234/git_kong/3816894bbdae3ad84909108916eb80e9bc8b628c/arch/csky/core/irq_manage.c), [`core_ck802.h`](https://raw.githubusercontent.com/kongqj1234/git_kong/3816894bbdae3ad84909108916eb80e9bc8b628c/ext/actions/att/att_patterns/include/csky/core_ck802.h), [`irq.h`](https://raw.githubusercontent.com/kongqj1234/git_kong/3816894bbdae3ad84909108916eb80e9bc8b628c/include/irq.h), [`sys_clock.c`](https://raw.githubusercontent.com/kongqj1234/git_kong/3816894bbdae3ad84909108916eb80e9bc8b628c/kernel/sys_clock.c), and [`acts_timer.c`](https://raw.githubusercontent.com/kongqj1234/git_kong/3816894bbdae3ad84909108916eb80e9bc8b628c/drivers/timer/acts_timer.c). The local manifest is `research/rea/references/sdk-contracts/manifest.json`.
- Separate physical clock sample: `research/rea/completion630-lab/runtime/current393988-vad-clock-1791884616990-root.json`.
