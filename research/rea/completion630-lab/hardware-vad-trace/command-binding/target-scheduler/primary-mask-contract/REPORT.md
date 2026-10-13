# Primary mask contract and address gap

**Current-image evidence:** verified image SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`. The VBR setup and copied switch entry are detailed in [`../REPORT.md`](../REPORT.md): VBR is `0x01000400`; word at `0x01000458` (VBR+`0x58`) is runtime `0x000809d4`, mapping to source `0x01115c64`, the context-switch routine. In helper `0x01115c34`, after testing selected/current state and calling ROM `0x02124e40`, the image stores `1` to the literal address `0xe000ec08` (`0x01115c58`; literal at `0x01115c60`). No read or symbolic reference for that MMIO address appears in the retained current-image evidence.

**Vendor architecture evidence:** T-HEAD's *S802 User Manual*, v1.2.15 (2017-07-28), §4.2.10, printed p.38, identifies soft interrupt/TSpending as vector 22 at offset `0x58` when VIC is configured. Section 4.3.1.1, printed p.39, says clearing PSR.IE masks interrupt inputs and the processor does not respond to the exception. The same manual does not explicitly cross-reference the IE rule to TSpending or give the `0xe000ec08` address. It points TSpending configuration to a separate *C-SKY E-Series Processor Tightly Coupled IP Manual*.

C-SKY Microsystems' public *CSKY ISA User Guide* v1.15.17 identifies VBR as the interrupt-vector-table base (p.13) and defines `PSRCLR` immediate bit 2 as IE (p.316). This is ISA-level corroboration, not an H1E core/peripheral register map.

**Assessment:** The current image's `VBR+0x58 → context switch` and scheduler-conditional write to `0xe000ec08` align closely with the S802-described TSpending path. Thus `0xe000ec08` is a strong candidate software-interrupt trigger, and an IE-cleared snapshot is supported conditionally if this image's core/VIC follows the S802 contract. I cannot confirm that mapping: the retained image/SDK does not identify the exact core/VIC configuration, and neither vendor manual nor retained ATS2853P2 SDK maps `0xe000ec08` to TSpending. The official S802 manual also does not explicitly state that this special software interrupt is gated by IE. No PSR IE set/clear appears around the `0x01115c34` MMIO store in the bounded helper.

**Minimum evidence to close the gap:** a matching C-SKY E-series TCIP/VIC register definition (SCIR/TSpending address and semantics) or target-matched vendor header/source mapping `0xe000ec08` to that register, plus an explicit rule that PSR.IE gates TSpending. Until then, treat IE masking as strong architecture-compatible support, not a target-qualified guarantee.

Primary sources and pinned downloads:

- [T-HEAD S802 User Manual, v1.2.15](https://occ-oss-prod.oss-cn-hangzhou.aliyuncs.com/cop-image-prod/upload-file/resource/420262990181302272/1566875243407/S802%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C.pdf), SHA-256 `70048aa2c860a5f1bd044c861563e7e146528c8e54cb3ee250f3c98ef27e5f06`.
- [C-SKY public ISA User Guide, v1.15.17](https://raw.githubusercontent.com/c-sky/csky-doc/master/CSKY%20Architecture%20user_guide.pdf), SHA-256 `579bd296dbf88b0b6842a473432e65199b87c0c19fcf04bb214f67241c68d509`.
