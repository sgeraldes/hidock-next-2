# H1E callback-slot provider trace

## Finding

The current 6.3.0 Zephyr image does not identify the runtime callback provider behind `0x00080e70`. This address is a RAM function-pointer slot, not a code address. Ghidra reports no mapped block or initial bytes for `0x80e68` through `0x80e78`; the current image therefore cannot supply the slot's runtime value. Its incoming code references are reads/dereferences, with no write-type references in the bounded current-image xref set. The callback address, writer/initializer, and provider location remain unresolved. This does not establish whether initialization comes from Zephyr runtime code, a separately loaded component, boot code, or elsewhere.

## Exact consumer contract

The current getter wrappers show the call shape, but not the callback body:

| Getter | Entry/call instructions | Callback arguments | Wrapper behavior |
| --- | --- | --- | --- |
| `RefChannelVAD` | `0101fb6a lrw r3,0x101fb88`; `0101fb6e ld.w r3,(r3,0)`; `0101fb72 jsr r3` | `r0=0x40000090`; `r1` is the caller's output pointer | Returns callback status unchanged; logs on nonzero status. |
| `VoiceEnergy` | `0101fa9e lrw r3,0x101fabc`; `0101faa2 ld.w r3,(r3,0)`; `0101faa6 jsr r3` | `r0=0x4009ffd0`; `r1` is the caller's output pointer | Returns callback status unchanged; logs on nonzero status. |

The caller passes a pointer to a zero-initialized 32-bit local, but that does not establish how many bytes the callback writes. Neither the transfer mechanism, metric semantics, nor callback side effects can be inferred from these wrappers.

## Bounded evidence

- `export/slot-memory.tsv`: all five inspected addresses (`0x80e68`, `0x80e6c`, `0x80e70`, `0x80e74`, `0x80e78`) are unmapped in the imported image; no initial slot value is available.
- `export/slot-direct-refs.tsv`: `0x80e70` has 19 read references and zero write references; `0x80e74` has 10 reads and `0x80e78` has 6 reads, also with zero writes. `0x80e68` and `0x80e6c` have no direct code references. Non-read entries for `0x80e70` are Ghidra `DATA`/`PARAM` annotations, not writes (`is_write=false`).
- `export/slot-literal-hits.tsv` and `export/slot-literal-refs.tsv`: initialized-image literals contain `0x80e70` at 12 cells, `0x80e74` at 8, and `0x80e78` at 6. Their code references load these literals for indirect calls; they do not assign to the RAM slots. One unreferenced data hit contains `0x80e6c`.
- The existing `../current630/current630-vad-instructions.tsv` and `../current630/current630-vad-functions.c` provide the two wrapper bodies. The existing verified audio-host export pins the analyzed image to SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` (`research/rea/protocol-depth630-lab/audio-host/verification.json`).

The bounded export opened the existing current-6.3.0 Ghidra program with `-noanalysis -readOnly`. It inspected only the five adjacent slot addresses, their direct references, and initialized-image literal cells holding those values. The first attempt stopped on an unmapped-RAM read; that diagnostic is preserved as `export/export-attempt1.log`, and the guarded retry completed as `export/export.log`. No device, firmware, application, or project analysis/write action was performed.

## Handoff limit

The named `dsp_dev_read_RefChannelVAD`/`dsp_dev_read_VoiceEnergy` wrappers call through a shared runtime function-pointer slot, but source evidence here cannot name its implementation or prove its lifecycle guard, chip/route, output width, freshness, or physical metric. Treat a bridge using this getter as unqualified until the runtime provider contract is established independently; expose raw value and status separately and do not write configuration or impose a threshold based on this trace.
