# Current-image scheduler/vector finding

**Scope:** read-only static analysis of the verified H1E 6.3.0 image. No hardware, firmware, app, or source changes were made. Image SHA-256: `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`.

## Evidence

The RAM copy contract maps source `[0x01115290, 0x011174f7)` (8,807 bytes) to runtime `[0x00080000, 0x00082267)`. Thus source `0x01115c64` maps to runtime `0x000809d4` (offset `0x9d4`). See `../opcode-scan-summary.json` and `../ghidra-export/instructions.tsv`.

Startup at `0x0106e26c` loads the literal at `0x0106e2a4` and writes it to VBR (`mtcr ..., cr<vbr>` at `0x0106e274`). The literal bytes at `0x0106e2a4` are `00 04 00 01`, i.e. VBR=`0x01000400`. The raw little-endian word at VBR+`0x58` (`0x01000458`) is `0x000809d4`, exactly the runtime address of the copied function at source `0x01115c64`. This is a concrete vector-table-entry → copied context-switch path; the slot’s architectural cause/name is not identified here.

At source `0x01115c64`, the switch saves the outgoing context, including EPC/EPSR (`mfcr` at `0x01115c86/0x01115c8c`), loads global scheduler base `0x00089600` (literal at `0x01115d14`), reads current task pointer at `+8` and selected pointer at `+0x14`, stores selected into current at `0x01115cb8`, restores the selected task’s EPC/EPSR (`mtcr` at `0x01115cec/0x01115cf4`), then executes `rte` at `0x01115d0e` (runtime `0x00080a7e`). The bounded Ghidra export confirms the function boundary and direct helper calls: `../ghidra-export/function-and-xref.tsv`, `direct-call-edges.tsv`, and `instructions.tsv`.

The separate helper at `0x01115c34` compares current/selected task state, calls ROM `0x02124e40`, then writes `1` to literal MMIO address `0xe000ec08` (store at `0x01115c58`; address literal at `0x01115c60`). The current-image scan found this write but no read of that register. The retained SDK contracts do not provide a matching symbolic definition for `0xe000ec08`.

## Conclusion and limit

The current image has a real vector entry that reaches a task-context switch, which changes the global current task and returns through EPC/EPSR. This establishes that scheduler/context switching is part of the same MCU image and that the source copy’s runtime address matters.

It does **not** establish that the `0xe000ec08` request is a maskable interrupt governed by PSR.IE, nor identify which exception/vector cause owns slot `+0x58`. The register is written but not read in the recovered path, and matching chip documentation or a named target definition was unavailable in retained SDK material. Therefore this evidence alone does not prove that an IE-cleared snapshot excludes every task switch. A later no-call/no-yield leaf can rule out voluntary yields; to close asynchronous exclusion, obtain the matching SoC definition for `0xe000ec08` and the target’s slot/cause-to-mask semantics. This is static source evidence only, not a snapshot runtime test.
