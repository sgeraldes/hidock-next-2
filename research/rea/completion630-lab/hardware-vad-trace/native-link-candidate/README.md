# Conditional offline source link

`build-offline.sh` links the native getter wrapper, recorded-observation reader, Jensen frame adapter, dispatch fork and constructor proposal into one C-SKY ELF. It consumes finalized source reports and the pinned decoded 393988 image as read-only input. Run it in WSL with the installed REA C-SKY toolchain.

This is an integration check, not a firmware builder. It creates no decoded firmware, update container, version change or deployable release. The ELF must not be flashed, flattened into a firmware image, or substituted for the installed system.

The candidate module is linked at `0x0112f000`, immediately after the frozen parser/upload/restore reservations. That verifies branch relocation against a concrete offline address, not flash capacity or an approved target placement. Existing upload/restore function addresses are imported from the pinned symbol map rather than rebuilt or moved. The unchanged native console hook assembly is linked against the new dispatch functions.

The constructor section includes assembler padding between seven individual edit sites. Only the individual instructions are part of the proposal; the section is not a contiguous firmware replacement. The poll/parser/response sections each contain one four-byte branch to the actual linked symbol.

`export-sparse-hunks.py` extracts ten individual instruction edits from the linked ELF and records each exact preimage from the pinned 393988 binary. It produces only `output/sparse-source-hunks.json`: 28 instruction bytes, excluding all 124 constructor-padding bytes. It applies no patch. Its `before_hex` and `after_hex` are file byte order. The constructor proposal report's displayed instruction words (for example `3060`) must not be treated as literal file bytes; little-endian `movi r0,96` is `60 30`. Use the actual ELF-derived sparse manifest for byte-level review, not hand-copied objdump words or the earlier synthetic branch example.

The loader is compiled with its explicit prerequisite assertion for this conditional offline check. The resulting link cannot prove that those prerequisites hold on hardware. Runtime object lifetime, allocator behavior, CPU ordering and the raw word's signal meaning remain unqualified. No hardware action is authorized by this script.

Inputs are hashed before and after compilation. The coordinator must first create `accepted-inputs.json` pinning the exact source and dispatch/loader/glue-review reports for conditional source acceptance. A missing manifest or any changed accepted hash stops the build. The build also requires a pinned 393988 SHA and upload/restore symbols, no undefined symbols, no writable XIP globals, four-byte hooks and a 16 KiB candidate-code budget. The output directory contains objects, the ELF, map, disassembly, symbols and a receipt marked `installed: false` and `release_approved: false`.

Before a later firmware image can be constructed, the finalized glue review must be accepted, each replacement must be matched against the pinned preimage, target placement/capacity must be established, and release prerequisites must be resolved. The user's current hardware ban still applies.
