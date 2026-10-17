# H1E 6.3.0 CMD29 level-source trace

> **Correction, 17 October continuation:** the interpretation below of `0x00000b4c` as the recording-manager implementation is superseded. Retained `rom-contract-evidence.json` identifies that address as `___gnu_csky_case_uhi`, a compiler halfword-switch dispatcher; `0x00000b38` is `___gnu_csky_case_uqi`, its byte-switch counterpart. The helper objects corroborate that ABI from a related SDK/toolchain, without attesting physical H1E ROM bytes. Their callers' branch tables and case bodies reside in SYS and are now being followed. This removes the claimed requirement to recover a recording-manager service body at `0xb4c`. The observed CMD29 active-state gate and wire layout remain separate findings.

## Scope and identity

Static-only trace of the exact decoded system at `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` (1,187,904 bytes). The retained instruction exports and command inventory identify the same hash. No device I/O, runtime measurements, or 6.2.5 exports were used.

## Dispatcher to level bytes

The ordinary empty Jensen request reaches CMD `0x001d`'s response branch at `0x0103a00e` in `research/rea/evidence/h1e-6.3.0-functions/01038e10.c` and `.tsv`; the exact command map is also recorded in `research/rea/commands630-lab/native-inventory/COMMANDS.md` and `inventory-verification.json`.

The response constructor initializes its type/count/seconds scratch fields to zero, then at `0x0103a03c` calls `FUN_0102d828(10, &active)`. It proceeds only if the low byte in the out parameter is nonzero; otherwise it takes the empty-response path. On the active path it serializes type `0`, a filename length and filename from option `18`, and elapsed seconds from option `11` as a two-byte big-endian value. It then asks option `13` for the requested level count. If nonzero, it allocates `count + 5` bytes, seeds byte zero with that requested count, and calls option `12` with this buffer at `0x0103a0f2`. The returned first byte is treated as the actual count; the response copies that byte plus exactly that many following level bytes (`M`, then `M` bytes). A zero count yields no level data. The append/copy and cleanup are visible at `0x0103a0fe`–`0x0103a15a`.

`FUN_0102d828` is the visible adapter. Its instruction export at `0102d828.tsv` shows it checks manager pointer `0x000853ec`, accepts option values `9..22`, subtracts `9` from the option in `r0`, then calls `0x00000b4c` at `0x0102d864` with the caller's output pointer still in `r1`. Thus the CMD29 calls map to ROM options `1` (active flag), `9` (name), `2` (elapsed time), `4` (requested count), and `3` (fill count/levels). The helper then checks manager field `0x07fa2c18` (offset `+0x18` from `0x07fa2c00`; the `record_rbuf_stream` name is in the adjacent log string) and returns an error when it is null. This is evidence for the recording-manager/stream gate, not evidence that this field itself stores the level array.

The first implementation that can actually produce the option-3 output is therefore the call target `0x00000b4c`, outside this decoded image's `0x01000000` code range. `record_mgr_getoption` at `0x010ed908` is only a logging string referenced by the wrapper; the retained 6.3.0 executable does not include the ROM implementation. The on-image code allocates a temporary output buffer and serializes the returned bytes; it contains no visible DSP calculation or level-generation loop.

## What this establishes

- **Condition:** CMD29 exposes levels only after option `10` reports active. Options `13` and `12` are reached only on that branch. This establishes that the command's level response is recording-state gated; it does not establish whether the hidden ROM maintains or refreshes any internal level state while idle.
- **Cadence:** this constructor runs in response to each CMD29 query. No timer or periodic level-update loop is visible in the CMD29 path. The cadence of updates inside option `3` is unresolved because that implementation is in ROM.
- **Channels:** the visible wire payload has one untagged `M`-byte level array and no microphone/system channel selector or per-channel labels. The firmware flash alone cannot tell whether those bytes represent one source, a mix, or some other recording-engine statistic. It does not support treating them as a microphone-specific VAD signal.
- **Meaning:** the handler/log label calls this “recording amplitude”; it does not define a voice-presence threshold or VAD decision.

## Next dependency

Do not relabel or extend these bytes as microphone VAD based on CMD29. To establish source routing, refresh cadence, or idle behavior, obtain the matching ROM implementation/ABI for `0x00000b4c` (options `1/2/3/4/9`) and the recorder's level-buffer producer contract. Until then the implementable contract is only “on-demand recording amplitude bytes while option `10` is active”; mic/system separation and out-of-recording updates remain unknown.
