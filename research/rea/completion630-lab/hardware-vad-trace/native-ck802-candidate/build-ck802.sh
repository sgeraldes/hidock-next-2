#!/usr/bin/env bash
# Conditional offline compile/link of the accepted VAD source for a chosen C-SKY core.
# Never writes a decoded firmware, OTA or container. Reads the native-link-candidate
# inputs (module.ld, poll-hook.S, accepted-inputs.json) and every source file read-only.
# Run in WSL:  CPU=ck802 ./build-ck802.sh      (default)
#              CPU=ck803 ./build-ck802.sh      (control built by this same recipe)
# Output goes to output-$CPU/ in this folder only.
set -euo pipefail
lab=$(cd "$(dirname "$0")" && pwd)
vad_root=$(cd "$lab/.." && pwd)
repo_root=$(cd "$vad_root/../../../.." && pwd)
link_lab="$vad_root/native-link-candidate"
frozen="$repo_root/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
cpu=${CPU:-ck802}
case "$cpu" in ck802|ck803) ;; *) echo "CPU must be ck802 or ck803"; exit 2;; esac
# LIBGCC=1 adds the toolchain libgcc.a for the chosen core as a link input. CK802 has no
# hardware divide, so the unchanged decimal() in console630_f11a.c calls __udivsi3/__umodsi3.
# That variant is separately labeled (output-$cpu-libgcc) and is not the same-inputs recipe.
libgcc=${LIBGCC:-0}
output="$lab/output-$cpu"
[ "$libgcc" = 1 ] && output="$lab/output-$cpu-libgcc"
extra=()
[ "$libgcc" = 1 ] && extra=("$("$tool_prefix-gcc" -mcpu=$cpu -print-libgcc-file-name)")
mkdir -p "$output"

# 1. Source and report hashes against the coordinator acceptance manifest (before).
python3 "$lab/check-inputs.py" "$frozen" "$vad_root" "$link_lab" "$output/input-hashes-pre.json" > "$output/input-check.txt" || {
 cat "$output/input-check.txt"
 echo "Accepted source/report hashes changed; stop and record the differences before building"
 exit 3
}

# 2. Same flags as native-link-candidate/build-offline.sh, only the core differs.
flags=(-std=c99 -mcpu=$cpu -Os -Wall -Wextra -Werror
 -I"$vad_root/fresh-sample-candidate" -I"$vad_root/native-frame-candidate"
 -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1)
sources=(
 fresh-sample-candidate/vadt_core.c
 fresh-sample-candidate/vadt_binding.c
 fresh-sample-candidate/vadt_csky_guard.c
 native-frame-candidate/vadt_frame.c
 native-frame-candidate/vadt_frame_target.c
 native-poll-candidate/h1e_vad_native_poll.c
 native-dispatch-candidate/console630_f11a.c
 native-loader-candidate/h1e_vad_native_loader.c)
objects=()
for source in "${sources[@]}"; do
 name=$(basename "$source" .c)
 "$tool_prefix-gcc" "${flags[@]}" -c "$vad_root/$source" -o "$output/$name.o"
 objects+=("$output/$name.o")
done
"$tool_prefix-gcc" -mcpu=$cpu -c "$frozen/console-hooks.S" -o "$output/console-hooks.o"
"$tool_prefix-gcc" -mcpu=$cpu -c "$vad_root/lifecycle-followup/late-publication/late-publication.s" -o "$output/constructor.o"
"$tool_prefix-gcc" -mcpu=$cpu -c "$link_lab/poll-hook.S" -o "$output/poll-hook.o"

# 3. Link with the unchanged module.ld (base 0x0112f000, imported upload/restore aliases).
"$tool_prefix-ld" -nostdlib -T "$link_lab/module.ld" -Map "$output/candidate.map" \
 "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o" \
 ${extra[@]+"${extra[@]}"} \
 -o "$output/conditional-source-$cpu-NOTINSTALL.elf"
elf="$output/conditional-source-$cpu-NOTINSTALL.elf"
"$tool_prefix-objdump" -dr "$elf" > "$output/candidate.objdump.txt"
"$tool_prefix-readelf" -S -A "$elf" > "$output/sections.txt"
"$tool_prefix-nm" -n "$elf" > "$output/symbols.txt"
test -z "$("$tool_prefix-nm" -u "$elf")"

# 4. Inputs again (after), receipt.
python3 "$lab/check-inputs.py" "$frozen" "$vad_root" "$link_lab" "$output/input-hashes-post.json" > "$output/input-check-post.txt"
python3 - "$output" "$cpu" <<'PY'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1]); cpu = sys.argv[2]
pre = json.loads((out / 'input-hashes-pre.json').read_text())['hashes']
post = json.loads((out / 'input-hashes-post.json').read_text())['hashes']
assert pre == post, 'Input changed during build'
receipt = {'status': 'conditional_offline_source_link_only', 'cpu': cpu, 'hardware_tested': False,
 'firmware_image_generated': False, 'installed': False, 'release_approved': False, 'module_example_base': '0112f000',
 'libgcc_linked': out.name.endswith('-libgcc'),
 'qualification': 'Profile compile only. Normal callee-save ABI, audited startup and delayed-publication prerequisites asserted; not target-qualified.',
 'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file() and p.name != 'link-receipt.json'}}
(out / 'link-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({k: v for k, v in receipt.items() if k != 'files'}))
PY
