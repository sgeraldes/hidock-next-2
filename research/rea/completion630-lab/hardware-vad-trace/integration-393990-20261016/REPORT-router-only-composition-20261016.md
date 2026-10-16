# H1E 393990 router-only VAD composition

Date: 2026-10-16

This report records the single offline decoded-SYS and ACTTEST container composition using the strict `router-only` profile in `compose_393990_nogrowth.py`. The default `two-tail` profile and its prior outputs were left intact.

The accepted router-only source link places one 1088-byte `.router_tail` section at `0x01128a40` inside the 1472-byte declared candidate window. The composer verified all ten approved instruction patches (28 bytes), the four native branch roots, the CK802/LTO/function-section/GC profile, zero data/BSS and undefined symbols, exact pinned source inputs, unchanged router live text, and the full current console reservation `[0x0112b000,0x0112c000)`. The candidate retains the original SYS length of 1,237,504 bytes and inverse reconstruction restores the pinned baseline byte-for-byte.

The resulting decoded SYS SHA-256 is `49603bdaa1ad853436ad27b2603ddf2307133afeb6cf6cacb78152fc1d750b51`. The ACTTEST container SHA-256 is `6290009486d4b03db457ce70602381a7647ef3883282df2d6b3d808d039fd53c`. Container readback confirmed the same partition offsets and total length, unchanged boot and non-Zephyr partition payloads, only the Zephyr XML checksum changed, and decoded Zephyr exactly matches the candidate SYS. The 4096-byte console reservation remains byte-identical to baseline with SHA-256 `93f732145acccd98d83a9c72639d749949f1a4a976d147982a2917d8f2d3720c`.

Inputs were pinned to manifest `46b380301df7490743f521f49f5ebd069f5d49c924737b3cbceeb422617fdfd5`, ELF `e8fd8989230b3f451dda347daa456357715f43a23b84173b43f2d632f3d4b322`, and symbols `538acc6e8c5a8d93dd4e4ee3ffc529a3e1604f7368199fb2981e60a3054c80f2`. The output receipt and instruction-level readback are stored beside the binaries in `out-NOTINSTALL/vad-393990-router-only-20261016T070253Z-e8fd8989/`.

This artifact remains `EXPERIMENTAL/NOTINSTALL`, retains version 393990, and is not installable or release-qualified. The router tail ownership and reservation remain unaccepted; no hardware execution or installation was performed.
