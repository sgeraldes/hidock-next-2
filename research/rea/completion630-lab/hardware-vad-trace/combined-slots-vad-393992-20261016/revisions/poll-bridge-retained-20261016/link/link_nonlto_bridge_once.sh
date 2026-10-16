#!/usr/bin/env bash
# Recompile only the poll wrapper without LTO, then relink pinned objects.
# This probe writes only into this isolated revision output directory.
set -euo pipefail

repo=/mnt/g/Code/hidock-next-2
owned="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016"
trace="$repo/research/rea/completion630-lab/hardware-vad-trace"
revision="$owned/revisions/poll-bridge-retained-20261016"
out="$revision/link/output-nonlto-bridge"
ld="$owned/link/router-only-combined.ld"
tool=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
source="$trace/native-poll-candidate/h1e_vad_native_poll.c"

test -d "$out"
test ! -e "$out/vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"
test "$(sha256sum "$owned/inputs/accepted-vad-inputs.json" | cut -d' ' -f1)" = 24c97109ea79776cb7b1045acbf78865b528f78b493208840692693555051c70
test "$(sha256sum "$owned/inputs/input-pins-before.json" | cut -d' ' -f1)" = 2278b2177e9efb59f650757c99bda285431519093c1a5f578ca2375802695f81
cmp "$owned/inputs/input-pins-before.json" "$owned/inputs/input-pins-after.json"
test "$(sha256sum "$source" | cut -d' ' -f1)" = 454d10055a2b1f24a78a639188e76ce74f1b2c5f842223fa545d831c807851f0
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

# Same SDK ABI and assertions; only this translation unit's LTO mode changes.
compile_flags=(-std=c99 -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common \
  -fno-delete-null-pointer-checks -ffunction-sections -fdata-sections -fno-lto \
  -Wall -Wextra -Werror \
  -I"$trace/fresh-sample-candidate" -I"$trace/native-frame-candidate" \
  -I"$trace/native-poll-candidate" -I"$trace/native-loader-candidate" \
  -I"$trace/native-dispatch-candidate" -I"$trace/native-f11a-393990-candidate" \
  -I"$trace/router-only-393990-candidate" \
  -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1)
printf '%q ' "$tool-gcc" "${compile_flags[@]}" -c "$source" -o "$out/h1e_vad_native_poll_nonlto.o" > "$out/compile-command.txt"
printf '\n' >> "$out/compile-command.txt"
"$tool-gcc" "${compile_flags[@]}" -c "$source" -o "$out/h1e_vad_native_poll_nonlto.o"

objects=()
for i in "${!names[@]}"; do
  name=${names[$i]}
  path="$owned/inputs/objects/$name"
  test -f "$path"
  if [[ "$name" == h1e_vad_native_poll.o ]]; then
    objects+=("$out/h1e_vad_native_poll_nonlto.o")
    continue
  fi
  actual=$(sha256sum "$path" | cut -d' ' -f1)
  test "$actual" = "${hashes[$i]}" || { echo "object pin mismatch $name: $actual" >&2; exit 4; }
  objects+=("$path")
done

elf="$out/vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"
"$tool-gcc" -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks \
  -ffunction-sections -fdata-sections -flto -fuse-linker-plugin -nostdlib \
  -Wl,--gc-sections,--print-gc-sections -Wl,-T,"$ld" -Wl,-Map,"$out/router-only-nonlto-poll-bridge.map" \
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
address, size = int(matches[0][0], 16), int(matches[0][1], 16)
assert 0x01128A40 <= address and address + size <= 0x01129000 and size > 0, (hex(address), size)
module = (out / "module-vad-router-tail.bin").read_bytes()
assert 0 < len(module) <= 1472, len(module)
map_text = (out / "router-only-nonlto-poll-bridge.map").read_text(errors="replace")
needle = " .text.h1e_vad_native_poll_bridge\n"
position = map_text.find(needle)
assert position >= 0, "bridge section missing from linker map"
mapped = map_text[position + len(needle):].splitlines()[0].split()
assert len(mapped) >= 2 and int(mapped[1], 16) == size, (mapped, size)
disassembly = (out / "objdump.txt").read_text(errors="replace")
body = re.search(rf"(?mi)^{address:08x} <h1e_vad_native_poll_bridge>:\s*\n\s*([0-9a-f]+):\s+([0-9a-f]+)\s+([^\n]+)", disassembly)
assert body and int(body.group(1), 16) == address and "bkpt" not in body.group(3).lower(), body.group(0) if body else "missing bridge body"
hook = re.search(r"(?mi)^\s*1020b62:\s+\S+\s+bsr\s+0x([0-9a-f]+)", disassembly)
assert hook and int(hook.group(1), 16) == address, hook.group(0) if hook else "poll hook target missing"
for symbol in ("vadt_binding_poll", "vadt_csky_guard_enter", "vadt_csky_guard_exit", "h1e_vad_load_object"):
    assert symbol in map_text and symbol in disassembly, f"missing linked poll-path symbol {symbol}"
print(f"bridge={address:#010x} size={size:#x}; poll_hook_target={address:#010x}; router_tail={len(module)}; undefined=0; binding/guard/loader symbols present")
PY

python3 - "$source" "$out" <<'PY'
import hashlib, json, pathlib, sys
source, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
receipt = {
    "status": "offline_nonlto_bridge_probe",
    "source_path": str(source),
    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "replacement_object": "h1e_vad_native_poll_nonlto.o",
    "replacement_object_sha256": hashlib.sha256((out / "h1e_vad_native_poll_nonlto.o").read_bytes()).hexdigest(),
    "elf": "vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf",
    "elf_sha256": hashlib.sha256((out / "vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf").read_bytes()).hexdigest(),
    "router_tail_sha256": hashlib.sha256((out / "module-vad-router-tail.bin").read_bytes()).hexdigest(),
    "status_boundary": "No SYS/container composition, hardware qualification, installation, or release action."
}
(out / "link-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
PY
echo "one non-LTO bridge probe complete; no SYS composition or hardware action"
