# F11A namespace trace: frozen 393988 candidate

## Finding

On the exact offline 393988 candidate below, `0xF11A` is not accepted by a custom handler and does not alias another command. It falls through the custom console, router, and control dispatchers, then reaches the original stock dispatcher as the unchanged 16-bit command. The stock request switch takes its unsupported-command path; the stock response switch also takes its unsupported-command default.

The stock response constructor initializes the unsupported response body-length field to zero. Its common transport serializer can conditionally increase that field by one under the endpoint-alignment predicate, so this source audit does not establish a final on-wire length. It establishes no 32-byte custom payload for the default path. A future 32-byte custom reply would still need separate transport-boundary verification to determine whether the common serializer adds a byte.

## Exact fallback chain

1. `generation-restore4/console630.c` compares full command values: `F119` goes to restore, `F118` to upload, `F117` is handled there, and every other value calls router parser `0x01128698`. Thus `F11A` goes to the router. Its response counterpart similarly sends non-`F117/F118/F119` commands to router response `0x01128798`.
2. The source-pinned router compares `command < 0xF113 || command > 0xF116`; outside that inclusive range it forwards to control at `0x01125044` (response: `0x01125108`). `F11A` is above `F116`, so it is forwarded. The compiled router bytes are an exact match for the final image region at `0x01128000`.
3. `control630.c` accepts only exact `F110` and `F111` values in both parse and response. Every other command returns `-1`; therefore `F11A` returns unhandled. Its compiled bytes exactly match the final image region at `0x01125000`.
4. The parser hook treats `-1` as the vendor path and reloads the pending command from `0x855DC` into the original dispatcher. The response hook treats `-1` as vendor handling and resumes the stock response constructor. The hook assembly and the address/bytes are recorded in the frozen build manifest.
5. In the original stock parser switch, the high-ID branch checks `command > 0xF010`; only exact `0xF011` has a handler there. `F11A` is greater than `F010` and unequal to `F011`, so it takes the unsupported-command path. The switch uses full-value comparisons; no mask or low-bit alias is applied on this route.
6. In stock response constructor `FUN_01038E10`, `F11A` takes the same `> F010 && != F011` default at `LAB_010390A6`, which sets `uStack_54 = 0`. The common serializer writes that value into response-header bytes `+8..+11`. Later code may increment the length by one when its transport-alignment predicate succeeds; that condition was not measured on hardware.

Source exact checks identify custom handler IDs `F110`, `F111`, and `F113`–`F119`; `F11A` is outside them. The existing custom command map corroborates this set and marks `F112` unassigned, but the conclusion here comes from the source branches and image bytes, not map absence.

## Image and evidence pins

- Final decoded candidate: `generation-restore4/system-decoded-NOTINSTALL.bin`, SHA-256 `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`. Its manifest SHA-256 is `8210db59c30bce31d87ea7aeaf39a2404c9d5868dd73e9210429017a1a797845`; the manifest labels it `offline_intermediate_NOT_INSTALL`, with source image SHA-256 `0c44bb2e1327270ee940643f31fc4464d9f6b3c48050072c590c8a29b7d9af46`.
- Console source SHA-256 `5dbfc45ea0f48e0899809a772b26a376f562213e52da6440398c02ecbf945e90`, pinned by that manifest. Custom-control verification JSON SHA-256 `127e1b67eb3a453555224220ffb7cea75fa86fb4381fc84a18d79b62cb4758aa` pins control source `705573187f877b01631ab5339b9304d08780aaac65f6e2acba6bbc6163c20a4a`, router source `27c3fd742e0ef1ceb6121ff087c862a9631f27f7bb7e7da66f062f8bf4757ebb`, and linked entries `01125044`, `01125108`, `01128698`, `01128798`.
- The 585-byte control binary (SHA-256 `44a809df8226255e44f3883c668a7629d14758b7eb4cc4ec2af48fbdb6d17fed`) and 2,613-byte router binary (SHA-256 `d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487`) were each byte-compared with their final-image regions; both comparisons were exact.
- Stock dispatcher instruction export SHA-256 `b76528902dbbb3eae121dbce78679c401979014bc8bfb7e8f76da9c0694a4e97`; stock response constructor export SHA-256 `45a2b84830aa2d799663ee01feee3a5995bc4a8ce9ff8a3915e7409d4cc9e38f`. Comparing their decoded instruction bytes with the final candidate found differences only at manifest patch locations. The parser switch after the parser hook and the response default/serializer blocks remain byte-identical to the exports. The response export's other difference is the separate listing patch at `0x010396BA`.

This is a bounded static namespace audit. No exhaustive 65,536-ID sweep, USB request, physical device test, or firmware write was performed; it does not establish behavior outside this frozen image and exact fallback chain.
