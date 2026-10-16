#!/usr/bin/env bash
# Export only the linked .vad_text section; this does not compose or patch a SYS.
set -euo pipefail
task_lab=$(cd "$(dirname "$0")" && pwd)
out="$task_lab/output"
elf="$out/f11a-393990-ck802-sdk-NOTINSTALL.elf"
module="$out/module-vad-text.bin"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

expected_elf=8cdf67a3d019a206296207817ab55f18477e88ea96fcf611d10fa7a563b744e8
actual_elf=$(sha256sum "$elf" | awk '{print $1}')
test "$actual_elf" = "$expected_elf"
"$tool_prefix-objcopy" -O binary --only-section=.vad_text "$elf" "$module"
test "$(wc -c < "$module")" -eq 1860
python3 - "$elf" "$module" "$out/module-export-readback.json" <<'PY'
import hashlib, json, pathlib, sys
elf, module, receipt = map(pathlib.Path, sys.argv[1:])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
record = {
    'status': 'linked_text_section_export_only',
    'elf_sha256': sha(elf),
    'section': '.vad_text',
    'section_address': '0112f000',
    'module_path': str(module),
    'module_bytes': module.stat().st_size,
    'module_sha256': sha(module),
    'firmware_image_generated': False,
    'composed': False,
    'installed': False,
}
receipt.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
PY
