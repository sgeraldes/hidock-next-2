# 393993 four-case exact-image gate

`gate-plan.yaml` records the reviewed inputs and case contract. This gate imports the exact decoded 393993 SYS as a read-only Ghidra memory image, checks the full image SHA/size and every imported byte, then executes only the two F11A response-wrapper fixtures and two poll-hook fixtures.

The 393992 ELF, symbols, and layout are pinned as address references only. They do not establish the linked-ELF identity of the 393993 SYS. The F11A fixtures start at `console630_response` (`0x01128bf4`), so they do not test the original F11A ingress/parser path. The poll fixtures start at the exact hook `0x01020b62`, stop at `0x01020b66`, and intercept the single native getter boundary only after checking `r0 == 0x0038e100` is within the synthetic output interval.

The two retargeted wrapper fallback BSRs are checked as exact candidate bytes during pin validation. This run does not claim to execute those branches; the mux routes have separate exact-image evidence. There is no firmware build, composition, hardware connection, USB operation, application operation, or flash operation here.

The one approved execution command is:

```powershell
wsl.exe -d Ubuntu -- bash /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/vad-exact-393993-20261017/run.sh run `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/firmware/producer-rom-fixed-probe-candidate/out-NOTINSTALL/composed-run8-wrapper-fallbacks/system-decoded-NOTINSTALL.bin 05d7d9e2d725b4624b4746b09cea58eed9aded63b1fc377255ac2c5fc41dec8b `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf 50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80 `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/symbols.txt 7222b982ab20c07f5aa270fa530128eed77e587cbab42be6820f30869a5a59a8 `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/receipts/compose-3/layout-readback.json 5fd4795ac690fff59b09e5000bdaa601a974e34b27016baa9081b6f9c99424b1 `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/compatibility-393993-20261017/REPORT.md dabb5ed8201889e9afe8a14e164d67e0390c6466f7b898269173609f0a07fd00 `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/firmware/producer-rom-fixed-probe-candidate/out-NOTINSTALL/composed-run8-wrapper-fallbacks/manifest.json 5db5046b754fd53f629e0d52478cb193c9547f3b3655dba09dbf999fc1af2159 `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/vad-exact-393993-20261017/out-NOTINSTALL/run-final-05d7-four-cases
```

The receipt validator requires exactly four passing case IDs and checks the complete F11A response bytes, poll bridge hit count, getter call count, and fixture `r0`. A failed or incomplete receipt is retained in the output directory; do not rerun automatically.
