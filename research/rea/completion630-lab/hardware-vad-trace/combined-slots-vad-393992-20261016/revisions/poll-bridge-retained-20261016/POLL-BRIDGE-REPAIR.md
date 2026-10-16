# Poll bridge LTO drop: repair evidence

## Defect

The earlier combined ELF `96c6e8c9b9db6de295f7d4a766a71beb6f066ac9b7a1f331cb52d320d92d1c13` linked `h1e_vad_native_poll_bridge` at `0x01128dba` with size zero. Its poll hook at `0x01020b62` therefore reached two bytes of fill (`00 00`, decoded as BKPT) in SYS `28be9ebe96f81f3a6a629ab8448be30bd8531c697ebf32c8238fc2d71ba4e768`. This is a real linked-image defect; that SYS is rejected for use.

The pinned C source contains a normal external bridge that calls `vadt_binding_poll`, and the poll-hook object contains a relocation to that bridge. The LTO link still emitted an empty function section. A separate link-level `-Wl,-u,h1e_vad_native_poll_bridge` probe remained empty, so that option was not a fix.

## Repair

Only the bridge translation unit was rebuilt from the same pinned source with the same CK802 ABI and delayed-publication assertion, retaining function/data sections but using `-fno-lto`. All other accepted objects and the linker script remained pinned and unchanged. The ordinary object reference to `vadt_binding_poll` retained the LTO binding and callback graph.

The new ELF SHA-256 is `50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80`. The bridge is `0x01128e34`, size 24 bytes; the linked poll hook now branches to that actual symbol. `vadt_binding_poll` is at `0x01128dba` and has a 120-byte body. The linked ops table points to guard-enter `0x01128aa2`, guard-exit `0x01128a9c`, and loader `0x01128a68`. Its reachable bridge path loads the getter and ops table, calls the binding function, and returns. The BKPT at `0x01128e42` follows the return instruction and is alignment padding.

The router module is 1,248 bytes in the granted 1,472-byte candidate window, leaving 224 bytes. The full ELF reports text 1,400 bytes, data 0, BSS 0, and no undefined symbols. Independent exact-instruction review confirmed the linked bridge path and callback targets. This is static link evidence only.

## SYS-only composition

The new decoded SYS is `out-NOTINSTALL/compose-3/system-decoded-NOTINSTALL.bin`, SHA-256 `043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918`, length 1,237,504 bytes. Composition applies the actual ELF module and ten instruction windows, derives branch encodings from linked symbols, and inverse-reconstructs the exact slots baseline `ebee46c51239a4ad971c54cf4b4c12e2a29d516aebd15065ec258de099168771`. The router's existing live bytes and all 4,096 bytes in the console range `0x0112b000..0x0112c000` are preserved; SYS length and header are unchanged.

`receipts/compose-3/layout-readback.json` pins the new link and source set. `receipts/compose-3/composition-readback.json` records exact changed ranges and inverse recovery. The compose-3 SYS has been sent for a separate exact-instruction gate. No ACTTEST container has been repacked in this revision, and there has been no hardware action, installation, or release qualification.

## Pinned outputs

- Non-LTO bridge object: `fcb93274a8b347dc02725598e26aeccede7006377423f7a66d0e00862592cab0`
- Router-tail module: `72c1fd09dfae86bbb4691b9b713c92e32685b1a5ccbb8f2e6b2406ec53115647`
- Bridge readback: `link/output-nonlto-bridge/bridge-readback.json`, SHA-256 `38d14d173d6500ad0303377fb6c77ab115ad7dd2551213f127b1db5d0c5672af`
- Layout readback: SHA-256 `5fd4795ac690fff59b09e5000bdaa601a974e34b27016baa9081b6f9c99424b1`
- Composition readback: SHA-256 `135730068b704826048da5dc552b5505e7f9cd4568b7aeadb02a4537f57e317a`

## Final status update

The exact SYS passed 6/6 scoped instruction fixtures, and the already-packed compose-3 container passed Windows SDK parsing and full directory/XML checksum readback. The candidate is accepted offline for the explicitly authorized VAD hardware-validation step; that hardware step remains pending. See [`FINAL-STATUS.md`](FINAL-STATUS.md) for final pins, preserved earlier failures, QA scope, and boundaries.
