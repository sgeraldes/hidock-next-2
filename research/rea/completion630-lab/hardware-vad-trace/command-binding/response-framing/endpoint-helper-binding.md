# Endpoint helper binding for native response framing

## Result

The native serializer’s `FUN_0104f520()` is a runtime 16-bit field read, not a compiled descriptor lookup. It loads the pointer `0x000867d6` from literal cell `0x0104f528` and returns the halfword at that RAM address. The saved current-image xref graph shows that this same halfword is used as the maximum chunk size by the `usb_iap2_drv_ep_read` path and has two visible stores: `0x200` and `0x40`. This binds the serializer’s divisor to the driver’s runtime endpoint read-size state. It does **not** prove which value is active on a live connection or that the scalar is copied from the currently selected USB descriptor.

## Exact helper contracts

- `FUN_0104f520` (`0x0104f520`, 6 bytes): `lrw r3,0x0104f528; ld.h r0,(r3,0); rts`. The literal at `0x0104f528` is `D6 67 08 00`, little-endian pointer `0x000867d6`; the return is a halfword read from that RAM address.
- `FUN_0104f674` (`0x0104f674`, 8 bytes) calls `FUN_0106a844`. The latter is six bytes and returns constant `0x2000`. On the non-mode-1 serializer branch, the existing `-0x0c` reserve yields body capacity `0x1ff4` (8180 bytes).
- `FUN_0104f66c` (`0x0104f66c`, 8 bytes) calls `FUN_0106a818` for the output pointer. That getter reads a driver-context pointer through literal `0x0106a840`; if non-null, it returns/stores context field `+0` when flag `+0x460` is zero, otherwise field `+4` when flag `+0x464` is zero, and returns zero if neither buffer is available. These are output-buffer selection fields, not the packet-size field.
- `FUN_0104f52c` is the saved `usb_iap2_drv_ep_read` path. After checking the endpoint status, it sets the requested read chunk to `min(remaining, *(uint16_t *)0x000867d6)` and calls `FUN_0106a7e4` with that chunk. Thus the same halfword that `FUN_0104f520` returns is consumed as the endpoint read chunk bound as well as the serializer’s alignment divisor.

The four pointer literals at `0x0104f504`, `0x0104f528`, `0x0104f624`, and `0x0104f724` all contain `D6 67 08 00`, so the two readers and two stores below address the same RAM halfword.

## Visible initialization and stores

The retained startup ranges show the halfword begins zeroed: the BSS-zero interval is `[0x82268, 0x898e8)`, which contains `0x867d6`. The current-image disassembly at `0x0108e36c` sets the zero-fill destination to `0x82268`, length to `0x898e8 - 0x82268`, and invokes the ROM zero-fill routine. The exact interval is recorded in `research/rea/evidence/h1e-6.3.0-integration/exact-startup-memory-ranges.json`.

The saved Ghidra references show these two writes to the halfword:

| Address | Store | Context visible in retained source |
| --- | --- | --- |
| `0x0104f490` | `0x200` (512) | Saved listing has `lrw r3,0x0104f504; movi r2,0x80; lsli r2,r2,2; st.h r2,(r3,0)`. The containing function is not present in the saved function map, so its caller/selection condition remains unresolved. |
| `0x0104f6fc` | `0x40` (64) | Inside `FUN_0104f6a0`; after `FUN_0106a48c(0)` and `FUN_0106a474(...)` both return success, it stores `0x40` through literal `0x0104f724`, then calls `FUN_0106a460(...)`. Its error-path labels include `usb_iap2_drv_init`. |

The saved xref export has no other direct read or write references to `0x000867d6`: reads at `0x0104f522` and `0x0104f5be`, and writes at `0x0104f490` and `0x0104f6fc`. This is the saved static reference graph, not proof against runtime writes through an unresolved alias. The driver code does not expose a descriptor field name or prove which setter runs last on the Jensen route.

## Framing consequence and limit

The native serializer extends when `FUN_0104f730()!=1`, total wire length `L!=0x2000`, and ROM helper `0x558(L,FUN_0104f520())` returns zero (retained router model: `L % field == 0`). For a 32-byte VAD body, `L=12+32=44`. Both statically visible field values, 64 and 512, leave the body unextended because neither `44 % 64` nor `44 % 512` is zero. The ordinary compiled Jensen endpoint template is also bulk IN `0x82` / OUT `0x01`, `wMaxPacketSize=512`, as summarized in `research/rea/completion630-lab/firmware/console-transport-analysis/REPORT-CONSOLE-USB-ROUTES.md`. That template is not live enumeration evidence. Before the driver writes either size, startup zeroes the field; source inspection does not establish whether a response can reach the serializer during that interval. Therefore strict 32-byte replies are source-consistent after the visible 64- or 512-byte setup paths, while current live endpoint state and route remain unmeasured.

The hook must still write only the 32-byte callback body and respect the body capacity passed by the native handler. In mode 1, `FUN_01038e10` uses output pointer `*(iVar22+4)` and body capacity `param_3-0x24`. Otherwise, it uses `FUN_0104f66c()` for the output pointer and `FUN_0104f674()-0x0c = 0x2000-0x0c = 8180` bytes for body capacity.

## Evidence and parity

The read-only exports are in this folder’s `export/`, `ref-export/`, and `writer-export/` subdirectories. Ghidra used the existing `hidock-h1e630-acceptance` project with `-noanalysis -readOnly`; the scripts neither created functions nor changed the project. Official image: `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`. Frozen 393988 decoded image: `research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin`, SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`.

| Official/frozen range | Bytes | SHA-256 in both | Result |
| --- | ---: | --- | --- |
| `[0x0104f480,0x0104f4a0)` uncontained 512-byte store context | 32 | `3c19827b3b3caf81e84132a5fdcbb51517f8d8459ac8fdb62fc02ecca92c1e8b` | Equal |
| `[0x0104f504,0x0104f508)` writer pointer | 4 | `8662348324778324fd72cc1cf406f8cbc3f9c36c51b5bc22ae0395f1edb3f292` | Equal |
| `[0x0104f520,0x0104f526)` geometry getter | 6 | `a1b3ae932c3f701db17374ba909b992888c35b6ef13ae758415b20452329059d` | Equal |
| `[0x0104f528,0x0104f52c)` geometry pointer | 4 | `8662348324778324fd72cc1cf406f8cbc3f9c36c51b5bc22ae0395f1edb3f292` | Equal |
| `[0x0104f52c,0x0104f624)` endpoint read path | 248 | `73b69f43d6a5e7d1049f79afc0e7e26ea20f12d1dbf491deb4101028ece2317c` | Equal |
| `[0x0104f624,0x0104f628)` read-size pointer | 4 | same as geometry pointer | Equal |
| `[0x0104f66c,0x0104f67c)` output-buffer/capacity wrappers | 16 | `ebd63391d54fd140c8c29caa7a072b8d77792f2ecd666153d360c868166e28f7` | Equal |
| `[0x0106a818,0x0106a83e)` output-buffer getter | 38 | `920798bc36d47b5c4b9764785fa7dc03e23e2da8be7c7efb377ca10b34ed540c` | Equal |
| `[0x0106a844,0x0106a84a)` capacity constant getter | 6 | `70a8873c45ab983df9a2a1f58f8aef4623f13fe1023b25c4f210fa30bab813aa` | Equal |
| `[0x0104f6a0,0x0104f704)` field-64 initialization path | 100 | `921c851cc8e8670dcddfaf8234c22c63876290879ea4bb079c9c409848e948d4` | Equal |
| `[0x0104f724,0x0104f728)` init pointer | 4 | same as geometry pointer | Equal |
| `[0x0108e36c,0x0108e390)` BSS-zero setup | 36 | `1de2c587e4391ddc4d91bfaea1e4db06000137f89a2c2240d296e16d11ed1769` | Equal |

No hardware or live USB enumeration was used in this source audit.
