# VAD reply framing and response capacity

## Source result

Native `FUN_01038e10` serializes a 12-byte header followed by `uStack_54` response-body bytes. Its exact one-byte extension predicate at `0x01039778–0x010397e4` is:

```text
L = body_length + 12
extend = (FUN_0104f730() != 1)
      && (L != 0x2000)
      && rem_00000558(L, FUN_0104f520()) == 0
```

When true, it increments the header length at `param_1+8` and transfers `L+1` bytes (`body_length+13`). The bounded router harness models ROM helper `0x558` as `r0 % r1`; the callsite passes `L` as `r0` and the `FUN_0104f520()` result as `r1`. If helper semantics are kept opaque, the raw condition is exactly “helper returns zero.” The branch does not visibly write a byte at the old body end, so the value of the extra transmitted byte is not established here.

For the proposed VAD reply, the callback supplies a **32-byte body**, not a complete frame. Therefore `L=12+32=44`, and the `0x2000` exclusion does not apply. The extension is skipped if mode is 1, or if 44 is not divisible by the value returned from `FUN_0104f520()`.

The static normal Jensen/iAP2 interface template has bulk IN `0x82` and OUT `0x01`, both with `wMaxPacketSize=512` (`research/rea/completion630-lab/firmware/console-transport-analysis/transport-evidence.json`; summarized at `REPORT-CONSOLE-USB-ROUTES.md:57–65`). With geometry 512, `44 % 512 = 44`, so the body remains 32 bytes and a strict SDK 32-byte check matches. A 64-byte geometry would also leave 44 unchanged. The descriptor evidence is explicitly a compiled template, not a live enumeration, and the retained export does not show that `FUN_0104f520()` returns this descriptor’s current packet size. Thus the source proves the predicate and makes the normal-template result clear, but does not prove the runtime geometry/mode values for every route.

## Reply-buffer capacity and hook routing

The existing `console630` hook routes only `0xf117`, `0xf118`, and `0xf119`; an unrecognized `0xf11a` currently falls through to the native parser `0x01128698` and native response function `0x01128798` (`firmware/restore-build393988/generation-restore4/console630.c:15–17,31–32`). A VAD command must be explicitly routed through both parser and response hooks.

At the response-hook stack frame, `frame+0x20` is the body-capacity field. In `FUN_01038e10`, that local is selected dynamically:

- If `FUN_0104f730()==1`, the output pointer is `*(iVar22+4)` and capacity is incoming `param_3 - 0x24`.
- Otherwise, it obtains the output buffer from `FUN_0104f66c()` and capacity from `FUN_0104f674() - 0x0c`.

The two helper implementations and the runtime values are not present in these retained exports. The `capacity=512` default in `RouterControl630.java`, and the overrides in `ProbeConsoleBridge630.java`, are synthetic emulator fixtures, not a target capacity guarantee. The VAD response routine should write only the 32-byte body and check the passed body capacity. If the runtime extension predicate cannot be ruled out, it also needs one byte of headroom (`capacity >= 33`) because the native sender can declare/send one extra byte after the callback returns 32.

## Frozen-image parity

The relevant capacity-selection and serializer windows were compared byte-for-byte between official 6.3.0 decoded image `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` and frozen 393988 decoded image `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`. All compared ranges had zero differing bytes:

- `[0x01039046,0x0103905c)` (mode-1 capacity selection; 22 bytes)
- `[0x0103915a,0x01039164)` (buffer-capacity helper and header subtraction; 10 bytes)
- `[0x01039750,0x010397fa)` (length write, alignment predicate, and +1 update; 170 bytes)
- `[0x0103982c,0x01039874)` (common send path; 72 bytes)

These ranges are in `research/rea/evidence/h1e-6.3.0-functions/controls/01038e10.c/.tsv`; the decompiler branch is also in `research/rea/completion630-lab/tts-demo-trace/ghidra-export/01038e10.tsv` and `tts-demo-functions.c` around line 4237. This is scoped code parity, not runtime proof.

## Integration decision

Keep the VAD callback contract at exactly 32 body bytes; do not add the 12-byte native header or a manual pad. For the normal Jensen descriptor’s compiled 512-byte packet size (and 64 bytes), the native length predicate does not alter a 32-byte reply, so strict SDK32 framing is source-consistent. Before making that guarantee target-wide, bind `FUN_0104f520()` to the live Jensen endpoint geometry and establish the relevant `FUN_0104f730()` mode. If the returned geometry divides 44 while the mode is not 1, the native common path reports a 33-byte body and a strict SDK32 parser will reject it.
