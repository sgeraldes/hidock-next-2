#!/usr/bin/env bash
# Conditional source integration only: never writes a decoded firmware or OTA.
set -euo pipefail
task_lab=$(cd "$(dirname "$0")" && pwd)
vad_root=$(cd "$task_lab/.." && pwd)
repo_root=$(cd "$vad_root/../../../.." && pwd)
frozen="$repo_root/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
tool_prefix=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf
output="$task_lab/output"
for report in native-dispatch-candidate native-loader-candidate; do
 test -s "$vad_root/$report/REPORT.md" || { echo "Awaiting finalized $report report" >&2; exit 2; }
done
test -s "$task_lab/accepted-inputs.json" || { echo "Awaiting coordinator-pinned conditional source acceptance" >&2; exit 2; }
mkdir -p "$output"
python3 - "$frozen" "$vad_root" "$task_lab" "$output/input-hashes.json" <<'PY'
import hashlib,json,pathlib,sys
frozen,vad,lab,out=map(pathlib.Path,sys.argv[1:])
p=frozen/'system-decoded-NOTINSTALL.bin'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f'
expected={'upload630_parse':'0112c2c4','upload630_response':'0112ca1c','restore630_parse':'0112d7d8','restore630_response':'0112e162'}
symbols={s[2]:s[0] for line in (frozen/'symbols.txt').read_text().splitlines() if len(s:=line.split())==3}
assert all(symbols[k]==v for k,v in expected.items())
paths=[p,frozen/'symbols.txt',frozen/'module.ld',frozen/'console-hooks.S']
for folder in ['fresh-sample-candidate','native-frame-candidate','native-poll-candidate','native-dispatch-candidate','native-loader-candidate']:
 paths.extend(sorted((vad/folder).glob('*.c')))
 paths.extend(sorted((vad/folder).glob('*.h')))
paths += [vad/'lifecycle-followup/late-publication/late-publication.s',lab/'module.ld',lab/'poll-hook.S',lab/'build-offline.sh']
paths += [vad/'native-dispatch-candidate/REPORT.md',vad/'native-loader-candidate/REPORT.md',vad/'combined-source-review/native-glue-review.md']
actual={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
accepted=json.loads((lab/'accepted-inputs.json').read_text())
assert accepted['status']=='conditional_source_only_not_target_qualified'
assert accepted['hashes']==actual,'Accepted source/report hashes changed; coordinator review required'
out.write_text(json.dumps(actual,indent=2)+'\n')
PY
flags=(-std=c99 -mcpu=ck803 -Os -Wall -Wextra -Werror
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
 object="$output/$name.o"
 "$tool_prefix-gcc" "${flags[@]}" -c "$vad_root/$source" -o "$object"
 objects+=("$object")
done
"$tool_prefix-gcc" -mcpu=ck803 -c "$frozen/console-hooks.S" -o "$output/console-hooks.o"
"$tool_prefix-gcc" -mcpu=ck803 -c "$vad_root/lifecycle-followup/late-publication/late-publication.s" -o "$output/constructor.o"
"$tool_prefix-gcc" -mcpu=ck803 -c "$task_lab/poll-hook.S" -o "$output/poll-hook.o"
"$tool_prefix-ld" -nostdlib -T "$task_lab/module.ld" -Map "$output/candidate.map" \
 "${objects[@]}" "$output/console-hooks.o" "$output/constructor.o" "$output/poll-hook.o" \
 -o "$output/conditional-source-NOTINSTALL.elf"
"$tool_prefix-objdump" -dr "$output/conditional-source-NOTINSTALL.elf" > "$output/candidate.objdump.txt"
"$tool_prefix-readelf" -S "$output/conditional-source-NOTINSTALL.elf" > "$output/sections.txt"
"$tool_prefix-nm" -n "$output/conditional-source-NOTINSTALL.elf" > "$output/symbols.txt"
test -z "$("$tool_prefix-nm" -u "$output/conditional-source-NOTINSTALL.elf")"
python3 - "$output" <<'PY'
import hashlib,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); before=json.loads((out/'input-hashes.json').read_text())
assert all(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==sha for p,sha in before.items()),'Input changed during link'
receipt={'status':'conditional_offline_source_link_only','hardware_tested':False,'firmware_image_generated':False,
 'installed':False,'release_approved':False,'module_example_base':'0112f000',
 'qualification':'Normal callee-save ABI, audited startup and delayed-publication prerequisites asserted; not target-qualified.',
 'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file() and p.name!='link-receipt.json'}}
(out/'link-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='files'}))
PY
