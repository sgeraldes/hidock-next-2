#!/usr/bin/env bash
# One LTO relink with the non-LTO assembly callee made an explicit plugin root.
# This script reads frozen objects and writes only inside this revision folder.
set -euo pipefail

repo=/mnt/g/Code/hidock-next-2
owned="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016"
revision="$owned/revisions/poll-bridge-retained-20261016"
out="$revision/link/output"
ld="$owned/link/router-only-combined.ld"
tool=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

test -d "$out"
test ! -e "$out/vad-router-only-slots-393992-revision3-NOTINSTALL.elf"
test "$(sha256sum "$owned/inputs/accepted-vad-inputs.json" | cut -d' ' -f1)" = 24c97109ea79776cb7b1045acbf78865b528f78b493208840692693555051c70
test "$(sha256sum "$owned/inputs/input-pins-before.json" | cut -d' ' -f1)" = 2278b2177e9efb59f650757c99bda285431519093c1a5f578ca2375802695f81
cmp "$owned/inputs/input-pins-before.json" "$owned/inputs/input-pins-after.json"
grep -q 'PROVIDE(console630_response_current = 0x0112b81c);' "$ld"
! grep -q 'PROVIDE(console630_response_current = 0x0112b800);' "$ld"

names=(vadt_core.o vadt_binding.o vadt_csky_guard.o vadt_frame.o vadt_frame_target.o \
  h1e_vad_native_poll.o h1e_vad_native_loader.o f11a_console_dispatch.o \
  console-hooks.o constructor.o poll-hook.o)
hashes=(
  e1700b6d6045ab30109a33cc6bfbe9a72823fe764be2e73187523c64352cbb45
  36b3edfde28409b7625a08e153f3e7018af3e917e8573d03fcb183f4eafd9878
  aed552adcb70c83ac05e30bdbf6a78b7c4c305a11f08ddb2648915a650efe2aa
  a6d66c3e62daec2b5ae42b47488a8cc816f98e3723dd934d082445752e47eba5
  1f08d9a2d510f3f689cc41bf329488050b325ba31c00755e977fdd4d2e76210f
  c1859a1d4ec0270d1a309f1e37fdd7381d3f7f4ea69222daf2476a1755dc8072
  c7a7b6f8bb4fb7f0b58931d0b4bc991e59be60971d91addc641705e104249a16
  bb0b9ca5378d16ca4585931f6a1d90e54634fc86b49e792d780d3b1861f85146
  46bf2f587bc957868d95e88a888fb67b20c865be3d410c9d6fd2439f8496098a
  2d0d49b72e19d397943409ca073b1ad973c48ae93bc088d24efabec7b240d67d
  5770421e88e3e654e24eb9555530f260fbbfc8c3a83d1349d17083afa706ff83
)
objects=()
for i in "${!names[@]}"; do
  name=${names[$i]}
  path="$owned/inputs/objects/$name"
  test -f "$path"
  actual=$(sha256sum "$path" | cut -d' ' -f1)
  test "$actual" = "${hashes[$i]}" || { echo "object pin mismatch $name: $actual" >&2; exit 4; }
  objects+=("$path")
done

elf="$out/vad-router-only-slots-393992-revision3-NOTINSTALL.elf"
"$tool-gcc" -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks \
  -ffunction-sections -fdata-sections -flto -fuse-linker-plugin -nostdlib \
  -Wl,-u,h1e_vad_native_poll_bridge -Wl,--gc-sections,--print-gc-sections \
  -Wl,-T,"$ld" -Wl,-Map,"$out/router-only-revision3.map" \
  "${objects[@]}" -o "$elf" > "$out/link-output.txt" 2>&1 || { cat "$out/link-output.txt" >&2; exit 10; }
"$tool-objdump" -dr "$elf" > "$out/objdump.txt"
"$tool-readelf" -h -S -A "$elf" > "$out/sections.txt"
"$tool-nm" -n "$elf" > "$out/symbols.txt"
"$tool-nm" -S "$elf" > "$out/sized-symbols.txt"
"$tool-size" "$elf" > "$out/size.txt"
"$tool-nm" -u "$elf" > "$out/undefined.txt"
"$tool-objcopy" -O binary --only-section=.router_tail "$elf" "$out/module-vad-router-tail.bin"
test ! -s "$out/undefined.txt"
awk 'NR==2 { exit !($2 == 0 && $3 == 0) }' "$out/size.txt"
"$tool-readelf" -A "$elf" | grep -q 'Tag_CSKY_CPU_NAME:.*"ck802"'
python3 - "$out" <<'PY'
import pathlib, re, sys
out = pathlib.Path(sys.argv[1])
rows = [line.split() for line in (out / "sized-symbols.txt").read_text().splitlines()]
matches = [row for row in rows if row and row[-1] == "h1e_vad_native_poll_bridge"]
assert len(matches) == 1, matches
row = matches[0]
address, size = int(row[0], 16), int(row[1], 16)
assert address == 0x01128DBA and size > 0, (hex(address), size)
module_bytes = (out / "module-vad-router-tail.bin").stat().st_size
assert 0 < module_bytes <= 1472, module_bytes
map_text = (out / "router-only-revision3.map").read_text(errors="replace")
needle = " .text.h1e_vad_native_poll_bridge\n"
position = map_text.find(needle)
assert position >= 0, "bridge section missing from linker map"
mapped = map_text[position + len(needle):].splitlines()[0].split()
assert len(mapped) >= 2 and int(mapped[1], 16) > 0, mapped
disassembly = (out / "objdump.txt").read_text(errors="replace")
body = re.search(r"(?mi)^01128dba <h1e_vad_native_poll_bridge>:\s*\n\s*([0-9a-f]+):\s+([0-9a-f]+)\s+([^\n]+)", disassembly)
assert body and int(body.group(1), 16) == address and "bkpt" not in body.group(3).lower(), body.group(0) if body else "missing bridge body"
print(f"bridge={address:#010x} size={size:#x}; router_tail={module_bytes}; undefined=0")
PY
echo "one retention-root relink complete; no source recompile, SYS composition, or hardware action"
