#!/usr/bin/env bash
# One offline CK802 source-link attempt using only the immutable accepted C/asm inputs.
# This does not compose, patch, package, install, or flash a firmware image.
set -euo pipefail

task_lab=$(cd "$(dirname "$0")" && pwd)
trace_root=$(cd "$task_lab/.." && pwd)
repo_root=$(cd "$trace_root/../../../.." && pwd)
f11a="$trace_root/native-f11a-393990-candidate"
capture="$repo_root/research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
current_sys="$capture/out-NOTINSTALL/container-compose3/system-decoded.bin"
console_native="$capture/out-NOTINSTALL/run2/native"
frozen="$repo_root/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
output="$task_lab/output"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
gcc="$tool_prefix-gcc"
mkdir -p "$output"

# Reconfirm the accepted source set and capture immutable inputs before compilation.
python3 "$trace_root/native-ck802-candidate/check-inputs.py" \
  "$frozen" "$trace_root" "$trace_root/native-link-candidate" \
  "$output/accepted-vad-inputs.json"
python3 "$task_lab/capture_inputs.py" "$output/input-pins-before.json"

cat > "$output/toolchain-info.txt" <<EOF
compiler: $($gcc --version | head -n 1)
target: $($gcc -dumpmachine)
version: $($gcc -dumpversion)
lto-wrapper: $($gcc -print-prog-name=lto-wrapper)
lto-plugin: $($gcc -print-file-name=liblto_plugin.so)
EOF

sdk_profile=(-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks)
optimization_flags=(-ffunction-sections -fdata-sections -flto)
cflags=(-std=c99 "${sdk_profile[@]}" "${optimization_flags[@]}" -Wall -Wextra -Werror \
  -I"$trace_root/fresh-sample-candidate" -I"$trace_root/native-frame-candidate" \
  -I"$trace_root/native-poll-candidate" -I"$trace_root/native-loader-candidate" \
  -I"$trace_root/native-dispatch-candidate" -I"$f11a" -I"$task_lab" \
  -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1)
sources=(
  "$trace_root/fresh-sample-candidate/vadt_core.c"
  "$trace_root/fresh-sample-candidate/vadt_binding.c"
  "$trace_root/fresh-sample-candidate/vadt_csky_guard.c"
  "$trace_root/native-frame-candidate/vadt_frame.c"
  "$trace_root/native-frame-candidate/vadt_frame_target.c"
  "$trace_root/native-poll-candidate/h1e_vad_native_poll.c"
  "$trace_root/native-loader-candidate/h1e_vad_native_loader.c"
  "$f11a/f11a_console_dispatch.c"
)
objects=()
: > "$output/compile-commands.txt"
for source in "${sources[@]}"; do
  name=$(basename "$source" .c)
  object="$output/$name.o"
  printf 'gcc %s -c %s -o %s\n' "${cflags[*]}" "$source" "$object" >> "$output/compile-commands.txt"
  "$gcc" "${cflags[@]}" -c "$source" -o "$object"
  objects+=("$object")
done
test "$(wc -l < "$output/compile-commands.txt")" -eq 8
test "$(grep -c -F -- '-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks' "$output/compile-commands.txt")" -eq 8
test "$(grep -c -F -- '-ffunction-sections -fdata-sections -flto' "$output/compile-commands.txt")" -eq 8

# Preserve the same three accepted assembly inputs and their recorded CK802 invocation.
"$gcc" -mcpu=ck802 -c "$frozen/console-hooks.S" -o "$output/console-hooks.o"
"$gcc" -mcpu=ck802 -c "$trace_root/lifecycle-followup/late-publication/late-publication.s" -o "$output/constructor.o"
"$gcc" -mcpu=ck802 -c "$trace_root/native-link-candidate/poll-hook.S" -o "$output/poll-hook.o"
objects+=("$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o")
for object in "${objects[@]}"; do
  "$tool_prefix-readelf" -A "$object" | grep -q 'Tag_CSKY_CPU_NAME:.*"ck802"' || {
    echo "object lacks CK802 ELF attribute: $object" >&2
    exit 4
  }
done

elf="$output/vad-router-only-393990-NOTINSTALL.elf"
if ! "$gcc" "${sdk_profile[@]}" "${optimization_flags[@]}" -fuse-linker-plugin -nostdlib \
  -Wl,--gc-sections,--print-gc-sections \
  -Wl,-T,"$task_lab/router-only.ld" \
  -Wl,-Map,"$output/router-only.map" \
  "${objects[@]}" -o "$elf" > "$output/link-output.txt" 2>&1; then
  cat "$output/link-output.txt" >&2
  echo "router-only link failed; inspect link-output.txt and router-only.map for the measured section size" >&2
  exit 10
fi

"$tool_prefix-objdump" -dr "$elf" > "$output/objdump.txt"
"$tool_prefix-readelf" -h -S -A "$elf" > "$output/sections.txt"
"$tool_prefix-nm" -n "$elf" > "$output/symbols.txt"
"$tool_prefix-size" "$elf" > "$output/size.txt"
"$tool_prefix-nm" -u "$elf" > "$output/undefined.txt"
"$tool_prefix-objcopy" -O binary --only-section=.router_tail "$elf" "$output/module-vad-router-tail.bin"
test ! -s "$output/undefined.txt"
awk 'NR==2 { exit !($2 == 0 && $3 == 0) }' "$output/size.txt"
"$tool_prefix-readelf" -A "$elf" | grep -q 'Tag_CSKY_CPU_NAME:.*"ck802"'

python3 "$task_lab/export_strict_manifest.py"
python3 "$task_lab/capture_inputs.py" "$output/input-pins-after.json"
cmp "$output/input-pins-before.json" "$output/input-pins-after.json"
echo "Router-only link, exact source-hunk readback, zero-data checks, and before/after source pins passed."
echo "No firmware image was composed or installed; no hardware test was performed."
