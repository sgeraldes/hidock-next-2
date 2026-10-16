#!/usr/bin/env bash
# Link once from immutable objects. This never composes, applies, or installs a SYS.
set -euo pipefail

task_lab=$(cd "$(dirname "$0")" && pwd)
trace_root=$(cd "$task_lab/.." && pwd)
repo_root=$(cd "$trace_root/../../../.." && pwd)
vad_out="$trace_root/native-f11a-393990-candidate/output"
output="$task_lab/output"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
mkdir -p "$output"

objects=(
  "$vad_out/vadt_core.o"
  "$vad_out/vadt_binding.o"
  "$vad_out/vadt_csky_guard.o"
  "$vad_out/vadt_frame.o"
  "$vad_out/vadt_frame_target.o"
  "$vad_out/h1e_vad_native_poll.o"
  "$vad_out/h1e_vad_native_loader.o"
  "$vad_out/f11a_console_dispatch.o"
  "$vad_out/console-hooks.o"
  "$vad_out/constructor.o"
  "$vad_out/poll-hook.o"
)

python3 "$task_lab/capture_pins.py" "$output/input-pins-before.json"

elf="$output/vad-no-growth-393990-NOTINSTALL.elf"
"$tool_prefix-ld" -nostdlib -T "$task_lab/no-growth.ld" \
  -Map "$output/no-growth.map" "${objects[@]}" -o "$elf"

"$tool_prefix-readelf" -h -A -S "$elf" > "$output/sections.txt"
"$tool_prefix-objdump" -dr "$elf" > "$output/objdump.txt"
"$tool_prefix-nm" -n "$elf" > "$output/symbols.txt"
"$tool_prefix-nm" -u "$elf" > "$output/undefined.txt"
test ! -s "$output/undefined.txt"
"$tool_prefix-size" "$elf" > "$output/size.txt"
awk 'NR==2 { exit !($2 == 0 && $3 == 0) }' "$output/size.txt"

"$tool_prefix-objcopy" -O binary --only-section=.router_tail "$elf" "$output/router-tail.bin"
"$tool_prefix-objcopy" -O binary --only-section=.console_tail "$elf" "$output/console-tail.bin"
"$tool_prefix-objcopy" -O binary --only-section=.constructor_edits "$elf" "$output/constructor-edits.bin"
"$tool_prefix-objcopy" -O binary --only-section=.poll_hook "$elf" "$output/poll-hook.bin"
"$tool_prefix-objcopy" -O binary --only-section=.parser_hook "$elf" "$output/parser-hook.bin"
"$tool_prefix-objcopy" -O binary --only-section=.response_hook "$elf" "$output/response-hook.bin"

python3 "$task_lab/capture_pins.py" "$output/input-pins-after.json"
cmp "$output/input-pins-before.json" "$output/input-pins-after.json"
python3 "$task_lab/readback_layout.py"
