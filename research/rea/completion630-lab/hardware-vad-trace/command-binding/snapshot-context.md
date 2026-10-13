# Snapshot critical-section context evidence

## Finding

The retained evidence supports a short saved-PSR/IE-cleared, no-call/no-yield snapshot as a plausible same-CPU design, but it does **not yet prove** that this exact image suppresses `usbiap2` ↔ `sugr_app` task switches while IE is clear. The missing evidence is narrow: the current-image scheduler's interrupt/context-switch entry and return path, showing that a task switch is committed only by a maskable exception (or otherwise cannot occur while IE=0), plus any per-CPU/task affinity state if this image can schedule on more than one CPU. Do not describe the lock as target-qualified until that path is tied to this image.

## What the current image establishes

- The image `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin` is pinned at SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`.
- Jensen receive/command processing is in the `usbiap2` path: retained instruction evidence has the transport loop call dispatcher `0103a82c` at `0103bed4`. The custom parser and response hooks are within that synchronous command/response route (`research/rea/evidence/h1e-6.3.0-marker-rules/thread-ownership/THREAD-OWNERSHIP.md`; source TSVs under `.../thread-ownership/source/`).
- Native polling is in the distinct `sugr_app_main` loop at `01032e70`, which dispatches the scheduler and VAD state machine. Selector 5 queues `01020b58`; that callback is serviced from the same loop (`hardware-vad-trace/lifecycle-followup/REPORT.md`). These are separate task contexts in the same recovered C-SKY firmware image, rather than one call chain. The retained artifacts do not supply task-to-CPU affinity metadata.
- Current-image code at `01074600` saves PSR, executes `psrclr ie`, performs work, then restores the saved PSR (`lifecycle-followup/lifecycle-functions.tsv`, `01074606`, `0107460a`, `0107464c`). This proves the image uses an IE-masked region. It does not identify the scheduler entry or prove the exact scheduling effect of IE=0.
- The image strings include `_kernel.current->base.sched_locked != 1` at `01100620`. This is only an assertion string; no retained xref connects it to the task-switch path. No exact current-image scheduler/context-switch export or vector-to-current-thread trace was found in the retained VAD evidence.

The related ATS2853P2 SDK documents a low-level `irq_lock` pattern that saves PSR, clears IE, and restores the saved value, but the local manifest says exact HiDock ROM/board compatibility is unknown. The retained SDK `soc_export_rom.h` declares broader `sys_irq_lock`/`sys_irq_unlock` function pointers; it does not provide their implementation or establish that the H1E image uses them. This is useful architecture guidance, not a substitute for the target switch path.

## Safe source contract and remaining proof

Keep the DSP getter outside the critical section. The future snapshot binder should be a compiled leaf: inline save-PSR/clear-IE, copy only the CPU-owned tail/state bytes, restore the exact saved PSR, and return; no external calls, logging, allocation, waiting, yielding, scheduler API, clock read, or DSP access while masked. Its compiled disassembly can prove the leaf/no-call/no-yield condition. That condition prevents a voluntary switch from the binder itself, but does not prove that a target exception or scheduler path cannot switch threads while IE is clear.

To close the remaining gap, export only the current image's maskable interrupt entry through scheduler decision/context save-restore (and its IE handling), with the exact image hash and task/core binding. If that path cannot be established, use a target-proven scheduler-lock primitive for the reader or retain a sequence-validated, nonblocking snapshot design and avoid claiming IE masking serializes these two tasks. This is about the CPU-private telemetry tail; it makes no acquisition, DSP-synchronization, or physical-channel claim.

The candidate counters mean recorded completed native getter calls. They do not count all DSP acquisition and may omit a call when the binder skips recording after a lifecycle/pointer change (`hardware-vad-trace/fresh-sample-candidate/CONTRACT.md:9, 44-53`).
