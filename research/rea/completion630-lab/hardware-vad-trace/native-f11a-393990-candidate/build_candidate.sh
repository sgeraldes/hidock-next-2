#!/usr/bin/env bash
# Conditional CK802 source link and focused dispatcher test only.
# Never composes, patches, packages, installs, or flashes a firmware image.
set -euo pipefail

task_lab=$(cd "$(dirname "$0")" && pwd)
vad_root=$(cd "$task_lab/.." && pwd)
repo_root=$(cd "$vad_root/../../../.." && pwd)
capture="$repo_root/research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
current_native="$capture/out-NOTINSTALL/run2/native"
current_sys="$capture/out-NOTINSTALL/container-compose3/system-decoded.bin"
frozen="$repo_root/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
output="$task_lab/output"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

mkdir -p "$output"

# Reconfirm the accepted non-console VAD sources, then pin both the exact current
# 393990 SYS and current console ELF/module before linking.
python3 "$vad_root/native-ck802-candidate/check-inputs.py" \
  "$frozen" "$vad_root" "$vad_root/native-link-candidate" \
  "$output/accepted-vad-inputs.json"
python3 "$task_lab/capture_inputs.py" "$output/build-inputs-before.json"

# Exercise only this new dispatcher on the host. The target-address resolver and
# current parser/response are stubbed; the VAD frame functions are stubs too.
cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  -DH1E_F11A_DISPATCH_HOST_TEST=1 \
  -I"$task_lab" -I"$vad_root/native-dispatch-candidate" \
  -I"$vad_root/native-frame-candidate" -I"$vad_root/fresh-sample-candidate" \
  "$task_lab/f11a_console_dispatch.c" "$task_lab/f11a_console_dispatch_test.c" \
  -o "$output/f11a-dispatch-host-test"
"$output/f11a-dispatch-host-test" | tee "$output/f11a-dispatch-host-test.txt"

sdk_profile=(-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks)
cflags=(-std=c99 "${sdk_profile[@]}" -Wall -Wextra -Werror \
  -I"$vad_root/fresh-sample-candidate" -I"$vad_root/native-frame-candidate" \
  -I"$vad_root/native-poll-candidate" -I"$vad_root/native-loader-candidate" \
  -I"$vad_root/native-dispatch-candidate" -I"$task_lab" \
  -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1)
sources=(
  fresh-sample-candidate/vadt_core.c
  fresh-sample-candidate/vadt_binding.c
  fresh-sample-candidate/vadt_csky_guard.c
  native-frame-candidate/vadt_frame.c
  native-frame-candidate/vadt_frame_target.c
  native-poll-candidate/h1e_vad_native_poll.c
  native-loader-candidate/h1e_vad_native_loader.c
  native-f11a-393990-candidate/f11a_console_dispatch.c
)
objects=()
: > "$output/compile-commands.txt"
for source in "${sources[@]}"; do
  name=$(basename "$source" .c)
  object="$output/$name.o"
  printf 'gcc %s -c %s -o %s\n' "${cflags[*]}" "$vad_root/$source" "$object" >> "$output/compile-commands.txt"
  "$tool_prefix-gcc" "${cflags[@]}" -c "$vad_root/$source" -o "$object"
  objects+=("$object")
done
test "$(wc -l < "$output/compile-commands.txt")" -eq 8
test "$(grep -c -F -- '-mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common -fno-delete-null-pointer-checks' "$output/compile-commands.txt")" -eq 8

# The inherited assembly recipe intentionally supplies only the CK802 CPU flag;
# the prior SDK-profile review records this as a full assembler-flag-parity caveat.
"$tool_prefix-gcc" -mcpu=ck802 -c "$frozen/console-hooks.S" -o "$output/console-hooks.o"
"$tool_prefix-gcc" -mcpu=ck802 -c "$vad_root/lifecycle-followup/late-publication/late-publication.s" -o "$output/constructor.o"
"$tool_prefix-gcc" -mcpu=ck802 -c "$vad_root/native-link-candidate/poll-hook.S" -o "$output/poll-hook.o"
for object in "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o"; do
  "$tool_prefix-readelf" -A "$object" | grep -q 'Tag_CSKY_CPU_NAME:.*"ck802"' || {
    echo "object lacks CK802 ELF attribute: $object" >&2
    exit 4
  }
done

# No libgcc archive is linked here. If the reduced source actually needs a helper,
# the undefined-symbol check below fails and records that concrete requirement.
elf="$output/f11a-393990-ck802-sdk-NOTINSTALL.elf"
"$tool_prefix-ld" -nostdlib -T "$task_lab/module.ld" -Map "$output/candidate.map" \
  "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o" \
  -o "$elf"
"$tool_prefix-objdump" -dr "$elf" > "$output/candidate.objdump.txt"
"$tool_prefix-readelf" -S -A "$elf" > "$output/sections.txt"
"$tool_prefix-nm" -n "$elf" > "$output/symbols.txt"
"$tool_prefix-size" "$elf" > "$output/size.txt"
"$tool_prefix-nm" -u "$elf" > "$output/undefined.txt"
test ! -s "$output/undefined.txt"
awk 'NR==2 { exit !($2 == 0 && $3 == 0) }' "$output/size.txt"

python3 "$task_lab/export_strict_manifest.py"
python3 "$task_lab/capture_inputs.py" "$output/build-inputs-after.json"
cmp "$output/build-inputs-before.json" "$output/build-inputs-after.json"

python3 - "$output" <<'PY'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((out / 'sparse-source-hunks-393990.json').read_text())
assert manifest['current_system_sha256'] == 'abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360'
assert manifest['new_elf_sha256'] == sha(out / 'f11a-393990-ck802-sdk-NOTINSTALL.elf')
receipt = {
    'schema': 'h1e-vad-393990-source-link-receipt-v1',
    'status': 'conditional_source_link_and_dispatcher_host_test_only',
    'profile': 'ck802-sdk-flags',
    'current_system_sha256': manifest['current_system_sha256'],
    'current_console_elf_sha256': manifest['current_console_elf_sha256'],
    'module_base_example': manifest['new_module_base'],
    'new_elf_sha256': manifest['new_elf_sha256'],
    'sparse_manifest_sha256': sha(out / 'sparse-source-hunks-393990.json'),
    'sparse_hunks': len(manifest['hunks']),
    'instruction_bytes': manifest['total_instruction_bytes'],
    'constructor_padding_excluded_bytes': manifest['excluded_constructor_padding_bytes'],
    'undefined_symbols': [],
    'data_bytes': 0,
    'bss_bytes': 0,
    'libgcc_linked': False,
    'host_dispatch_test': (out / 'f11a-dispatch-host-test.txt').read_text().strip().splitlines()[-1],
    'firmware_image_generated': False,
    'composed': False,
    'installed': False,
    'hardware_tested': False,
    'release_approved': False,
    'qualification': 'Compiler-profile and focused dispatch evidence only; no SYS image, target execution, partition capacity, or physical qualification.',
    'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != 'link-receipt.json'},
}
(out / 'link-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({k: v for k, v in receipt.items() if k not in ('files',)}))
PY
