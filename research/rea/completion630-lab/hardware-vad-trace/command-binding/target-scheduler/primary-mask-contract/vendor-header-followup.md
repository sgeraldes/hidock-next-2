# Vendor header follow-up: `0xe000ec08`

## Result

This bounded public-source pass did **not** find an authoritative definition connecting `0xe000ec08` to SCIR/TSpending or to the VIC software-interrupt request. The existing interpretation remains a strong S802-compatible-core inference from the current-image vector/scheduler code, not a confirmed target register contract.

## Repositories and pinned evidence

The unauthenticated `GET https://api.github.com/orgs/c-sky/repos?per_page=100` succeeded (HTTP 200). From the returned public repositories, I examined only the official `c-sky/FreeRTOS` port and the `c-sky/csky-linux` IRQ-chip implementation.

- `c-sky/FreeRTOS`, commit `ec28660b31443dea0345d2e58d4200682c4079fa`.
  - [`include/hobbit/vic.h`](https://github.com/c-sky/FreeRTOS/blob/ec28660b31443dea0345d2e58d4200682c4079fa/include/hobbit/vic.h), Git blob `671e39a3247e0c0606a27c5c26db27cc30708388`: defines `VECTOR_SOFT` as 9 (line 19) and `VIC_BASE` as `0xE000E000` (line 36), then enumerates registers only through `VIC_BASE + 0x400` (lines 37–47). The target address is offset `0xC08` from that base and has no symbol or mapping in this header. There are no `SCIR` or `TSPEND` definitions.
  - [`include/hobbit/hobbit_irq.h`](https://github.com/c-sky/FreeRTOS/blob/ec28660b31443dea0345d2e58d4200682c4079fa/include/hobbit/hobbit_irq.h), Git blob `2fda88a6b3261d3abef31458065315532434795b`: describes a different VIC base, `0xE000E100` (line 66), and ordinary interrupt-controller offsets through `0x0B04`; it does not define the target address or TSpending.
  - [`bsp/hobbit/vic.c`](https://github.com/c-sky/FreeRTOS/blob/ec28660b31443dea0345d2e58d4200682c4079fa/bsp/hobbit/vic.c), Git blob `bfe6f75461377921b350c663ecb3af3c65d06afe`: the small BSP VIC implementation contained no SCIR/TSpending mapping.
- `c-sky/csky-linux`, commit `0602ae72d14c69f77263912e0089b5a4f797d462`.
  - [`drivers/irqchip/irq-csky-apb-intc.c`](https://github.com/c-sky/csky-linux/blob/0602ae72d14c69f77263912e0089b5a4f797d462/drivers/irqchip/irq-csky-apb-intc.c), Git blob `14ef206c84a3dc387decc52c2b53c0370a37d24c`: defines CK/GX/DH APB interrupt-controller register offsets (lines 17–46), uses a device-tree-mapped `reg_base`, and contains no `SCIR`, `TSPEND`, or `0xe000ec08` mapping. These are peripheral APB controller layouts, not an address-compatible explanation for the target core register.

The FreeRTOS header's software-vector value (9) also differs from the S802 manual's configured TSpending vector 22. That mismatch is evidence these public examples cannot be treated as the target's direct register contract. The repositories/tree slices and headers checked here are bounded coverage, not proof that no such definition exists in all C-SKY/T-Head materials.

## Consequence for the maskability claim

The S802 manual and current-image evidence still align: the image installs a task-switch handler at VBR+`0x58`, and its scheduler writes `1` to `0xe000ec08`; the manual says configured TSpending uses vector offset `0x58`/vector 22 and that PSR.IE masks interrupt inputs. This new source pass does not establish that the write causes TSpending on this target. Keep IE-clear exclusion conditional on the S802-compatible-core/VIC interpretation, not target-qualified.

To close the register-specific gap, the minimum additional source is a target-matched SoC/core header or tightly coupled-IP manual that names `0xe000ec08` (or its exact SCIR alias) and states that the write raises the TSpending exception. No hardware observation or broader reverse-engineering was performed here.
