#!/usr/bin/env bash
# Conditional offline compile/link of the accepted VAD source under the SDK CK802 profile.
# Never writes a decoded firmware, OTA or container. Accepted inputs and the
# native-link-candidate module.ld / poll-hook.S are read-only. Output: ./output only.
# Run in WSL:  ./build-sdk-profile.sh
set -euo pipefail
lab=$(cd "$(dirname "$0")" && pwd)
vad_root=$(cd "$lab/../.." && pwd)
repo_root=$(cd "$vad_root/../../../.." && pwd)
link_lab="$vad_root/native-link-candidate"
frozen="$repo_root/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
libgcc_sha=f0f80000e86c05cc3b7120762bad7b899f22ab1b3469eb83f8025520d31f40f3
output="$lab/output"
mkdir -p "$output" "$output/libgcc-members"

# 1. The 36 accepted source and report hashes (before).
python3 "$lab/../check-inputs.py" "$frozen" "$vad_root" "$link_lab" "$output/input-hashes-pre.json" > "$output/input-check-pre.txt" || {
 cat "$output/input-check-pre.txt"
 echo "Accepted source/report hashes changed; stop and record the differences before building"
 exit 3
}

# 2. One flag set for every C unit: the SDK CK802 profile plus the existing C99, warning,
#    include and gate options of native-link-candidate/build-offline.sh.
sdk_profile=(-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks)
flags=(-std=c99 "${sdk_profile[@]}" -Wall -Wextra -Werror
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
: > "$output/compile-commands.txt"
for source in "${sources[@]}"; do
 name=$(basename "$source" .c)
 echo "gcc ${flags[*]} -c $source -o $name.o" >> "$output/compile-commands.txt"
 "$tool_prefix-gcc" "${flags[@]}" -c "$vad_root/$source" -o "$output/$name.o"
 objects+=("$output/$name.o")
done
test "$(wc -l < "$output/compile-commands.txt")" -eq 8
test "$(grep -c -F -e '-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks' "$output/compile-commands.txt")" -eq 8

# 3. Assembly inputs: unchanged files, CK802 core only.
"$tool_prefix-gcc" -mcpu=ck802 -c "$frozen/console-hooks.S" -o "$output/console-hooks.o"
"$tool_prefix-gcc" -mcpu=ck802 -c "$vad_root/lifecycle-followup/late-publication/late-publication.s" -o "$output/constructor.o"
"$tool_prefix-gcc" -mcpu=ck802 -c "$link_lab/poll-hook.S" -o "$output/poll-hook.o"
for o in "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o"; do
 "$tool_prefix-readelf" -A "$o" | grep -q 'Tag_CSKY_CPU_NAME:.*"ck802"' || { echo "object is not ck802: $o"; exit 4; }
done

# 4. Pinned compiler-runtime helpers: the archive for the SDK-profile multilib is checked
#    against a pinned hash, and only the two integer helpers are taken out of it and linked
#    as explicit objects. Nothing else from libgcc can enter the module.
libgcc=$("$tool_prefix-gcc" "${sdk_profile[@]}" -print-libgcc-file-name)
case "$libgcc" in */ck802/libgcc.a) ;; *) echo "unexpected libgcc multilib: $libgcc"; exit 5;; esac
echo "$libgcc_sha  $libgcc" | sha256sum -c -
echo "$libgcc" > "$output/libgcc-path.txt"
(cd "$output/libgcc-members" && "$tool_prefix-ar" x "$libgcc" _udivsi3.o _umodsi3.o)
sha256sum "$output/libgcc-members/_udivsi3.o" "$output/libgcc-members/_umodsi3.o" > "$output/libgcc-members.sha256"

# 5. Link with the unchanged module.ld (hypothetical region 0x0112f000, imported aliases).
elf="$output/conditional-source-ck802-sdk-NOTINSTALL.elf"
"$tool_prefix-ld" -nostdlib -T "$link_lab/module.ld" -Map "$output/candidate.map" \
 "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o" \
 "$output/libgcc-members/_udivsi3.o" "$output/libgcc-members/_umodsi3.o" -o "$elf"
"$tool_prefix-objdump" -dr "$elf" > "$output/candidate.objdump.txt"
"$tool_prefix-readelf" -S -A "$elf" > "$output/sections.txt"
"$tool_prefix-nm" -n "$elf" > "$output/symbols.txt"
"$tool_prefix-size" "$elf" > "$output/size.txt"
test -z "$("$tool_prefix-nm" -u "$elf")"
awk 'NR==2 { exit !($2==0 && $3==0) }' "$output/size.txt"

# 6. Enum and char width under the old compile profile and the SDK profile (metadata only).
probe_inc=(-I"$vad_root/fresh-sample-candidate" -I"$vad_root/native-frame-candidate")
"$tool_prefix-gcc" -std=c99 -mcpu=ck802 -Os "${probe_inc[@]}" -c "$lab/enum-probe.c" -o "$output/probe-old-profile.o"
"$tool_prefix-gcc" -std=c99 "${sdk_profile[@]}" "${probe_inc[@]}" -c "$lab/enum-probe.c" -o "$output/probe-sdk-profile.o"
{
 echo "bytes: sizeof(vadt_status_t) sizeof(vadt_age_status_t) char_is_signed sizeof(vadt_telemetry_t)"
 echo "-- old profile: -mcpu=ck802 -Os"
 "$tool_prefix-objdump" -s -j .rodata "$output/probe-old-profile.o"
 echo "-- SDK profile: ${sdk_profile[*]}"
 "$tool_prefix-objdump" -s -j .rodata "$output/probe-sdk-profile.o"
} > "$output/enum-probe.txt"

# 7. Inputs again (after) and the receipt.
python3 "$lab/../check-inputs.py" "$frozen" "$vad_root" "$link_lab" "$output/input-hashes-post.json" > "$output/input-check-post.txt"
python3 - "$output" "$libgcc" "${sdk_profile[*]}" <<'PY'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1]); libgcc = pathlib.Path(sys.argv[2]); profile = sys.argv[3]
pre = json.loads((out / 'input-hashes-pre.json').read_text())['hashes']
post = json.loads((out / 'input-hashes-post.json').read_text())['hashes']
assert pre == post, 'Input changed during build'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
receipt = {'status': 'conditional_offline_source_link_only', 'profile': 'ck802-sdk-flags', 'compile_flags': profile,
 'hardware_tested': False, 'firmware_image_generated': False, 'installed': False, 'release_approved': False,
 'module_example_base': '0112f000',
 'libgcc_archive': {'path': str(libgcc), 'sha256': sha(libgcc), 'members_linked': ['_udivsi3.o', '_umodsi3.o'],
  'member_sha256': {m.name: sha(m) for m in sorted((out / 'libgcc-members').iterdir())}},
 'qualification': 'Compiler-profile parity only. Normal callee-save ABI, audited startup and delayed-publication prerequisites asserted; not target-qualified.',
 'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != 'link-receipt.json'}}
(out / 'link-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({k: v for k, v in receipt.items() if k not in ('files',)}))
PY

# 8. Sparse instruction hunks matched to the pinned 393988 image. No patch is applied.
python3 "$lab/export-sparse-hunks-sdk.py"
