# Run the host tests

No compiler is on the Windows PATH of this machine. WSL Ubuntu has `cc` (Ubuntu 13.3.0). The C-SKY cross compiler is at `/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf-gcc` (T-HEAD 6.3.0). Nothing here touches a device, USB, Git or a firmware image.

Host build and test, from PowerShell:

```powershell
wsl.exe -d Ubuntu --exec sh -c 'cd /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/fresh-sample-candidate && W="-std=c99 -Wall -Wextra -Wpedantic -Werror -O2" && cc $W -c vadt_core.c -o /tmp/vadt_p_core.o && cc $W -c vadt_binding.c -o /tmp/vadt_p_bind.o && cc $W -DVADT_TEST_HOOK=vadt_test_hook vadt_core.c vadt_binding.c vadt_test.c -o /tmp/vadt_t && /tmp/vadt_t'
```

The first two `cc` lines build the core and binding as they would ship, without the test hook. The third builds them with `VADT_TEST_HOOK`, which lets the test change the sequence inside `vadt_snapshot` to simulate a racing writer, and links the test. The test exits 0 when every check passes and prints `N checks, 0 failures`. Read the PASS and FAIL lines, not only the exit code.

Isolated C-SKY objects (compile only, no link, not an image):

```powershell
wsl.exe -d Ubuntu --exec sh -c 'cd /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/fresh-sample-candidate && T=/home/sebastian/.local/share/rea/tools/csky-20210423/bin && for f in vadt_core vadt_binding vadt_csky_guard; do $T/csky-abiv2-elf-gcc -std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror -c $f.c -o /tmp/vadt_c_$f.o; done && $T/csky-abiv2-elf-objdump -d /tmp/vadt_c_vadt_csky_guard.o'
```

Clean up the build outputs by name:

```powershell
wsl.exe -d Ubuntu --exec sh -c 'rm /tmp/vadt_p_core.o /tmp/vadt_p_bind.o /tmp/vadt_t /tmp/vadt_c_vadt_core.o /tmp/vadt_c_vadt_binding.o /tmp/vadt_c_vadt_csky_guard.o'
```
