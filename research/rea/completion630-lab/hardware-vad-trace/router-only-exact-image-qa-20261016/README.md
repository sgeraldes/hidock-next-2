# Exact-image CK802 instruction gate

This directory contains a bounded Ghidra-emulator check for the final combined slots + VAD candidate. It reuses the existing `BoundedNativeContract630` C-SKY instruction stepping corrections and `PrepareCsky` import script. It does not build firmware or alter the candidate image, and it never connects to USB or hardware.

Compile the QA script only:

```powershell
wsl.exe -d Ubuntu -- bash /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/router-only-exact-image-qa-20261016/run.sh compile
```

Run once the composer has pinned the final combined image, linked ELF, symbols, and layout readback. All paths must be WSL paths; provide SHA-256 values copied from the pinned receipt:

```powershell
wsl.exe -d Ubuntu -- bash /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/router-only-exact-image-qa-20261016/run.sh run `
  /mnt/g/Code/hidock-next-2/<candidate>/system-decoded-EXPERIMENTAL-NOTINSTALL.bin `<SYS_SHA256> `<ELF_SHA256> `
  /mnt/g/Code/hidock-next-2/<candidate>/symbols.txt `<SYMBOLS_SHA256> `
  /mnt/g/Code/hidock-next-2/<candidate>/layout-readback.json `<LAYOUT_SHA256> `
  /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/router-only-exact-image-qa-20261016/out-NOTINSTALL/run-<unique-id>
```

An optional final argument `skip-constructor` runs the six snapshot, poll, and console-forwarding cases when the two constructor publication branches have already been accepted against a prior exact-image candidate.

The run refuses to start if another Ghidra headless process is active. It validates all four input hashes, checks that the layout SYS hash matches the requested image, imports the exact SYS read-only, and compares every imported byte before emulation. It writes `receipt.json`, the executed Java source, and logs under the supplied output directory. The receipt validator checks both SYS and ELF pins.

Eight focused cases execute the constructor's final success/failure publication decision, F11A absent/present snapshot replies, poll bridge success/failure, and F117 parser/response forwarding against the current exact aliases. Fixture ROM/RAM is synthetic. The native getter at `0x0101fb68` is explicitly modeled for poll cases; the bridge, telemetry update/read, reply encoding, IRQ guard instructions, dispatcher, and current console aliases execute from the exact imported image. A passing receipt does not establish DSP behavior, USB behavior, timing, boot order, allocator lifetime, installation, or physical hardware semantics.
