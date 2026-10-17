#!/usr/bin/env bash
# Four exact-image CK802 instruction fixtures for the pinned 393993 SYS. No hardware access.
set -euo pipefail
stage="${1:?stage compile|run}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$here/../../firmware"
ghidra=/home/sebastian/.local/share/rea/ghidra_12.1.4_PUBLIC
runner="$ghidra/support/analyzeHeadless"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export GHIDRA_HEADLESS_MAXMEM=2G
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

work="$(mktemp -d /tmp/vad-exact-393993-XXXXXX)"
trap 'rm -rf "$work"' EXIT
scripts="$work/scripts"
mkdir -p "$scripts" "$work/classes" "$work/project" "$work/user"
cp "$fw/native-notify-image-runtime/harness/BoundedNativeContract630.java" "$scripts/"
cp "$fw/native-notify-image-runtime/harness/PrepareCsky.java" "$scripts/"
cp "$here/harness/VadExactQa393993.java" "$scripts/"
cp_jars="$(find "$ghidra/Ghidra" -name '*.jar' | tr '\n' ':')"
nice -n 10 "$JAVA_HOME/bin/javac" -proc:none -nowarn -cp "$cp_jars" -d "$work/classes" "$scripts"/*.java
echo "javac: ok; QA harness only, no firmware build"
if [[ "$stage" == "compile" ]]; then
  exit 0
fi
[[ "$stage" == "run" ]] || { echo "stage must be compile or run" >&2; exit 2; }

image="${2:?candidate SYS path}"
image_sha="${3:?candidate SYS SHA-256}"
reference_elf="${4:?393992 reference ELF path}"
reference_elf_sha="${5:?393992 reference ELF SHA-256}"
symbols="${6:?393992 reference symbols path}"
symbols_sha="${7:?393992 reference symbols SHA-256}"
layout="${8:?393992 reference layout path}"
layout_sha="${9:?393992 reference layout SHA-256}"
compatibility="${10:?393993 compatibility report path}"
compatibility_sha="${11:?compatibility report SHA-256}"
manifest="${12:?393993 composition manifest path}"
manifest_sha="${13:?composition manifest SHA-256}"
out="${14:?output directory}"
mkdir -p "$out"
python3 -I "$here/harness/configure.py" "$image" "$image_sha" "$reference_elf" "$reference_elf_sha" \
  "$symbols" "$symbols_sha" "$layout" "$layout_sha" "$compatibility" "$compatibility_sha" \
  "$manifest" "$manifest_sha" "$out/config.json"

if ps -eo args | grep -v grep | grep -qE 'analyzeHeadless|Ghidra-Headless|ghidra.Ghidra'; then
  echo "Another Ghidra headless run is active; not starting" >&2
  exit 3
fi
if [[ ! -f "$image" ]]; then image="$(wslpath -u "$image")"; fi
cp "$image" "$work/system.bin"
actual_copy_sha="$(sha256sum "$work/system.bin" | cut -d' ' -f1)"
[[ "$actual_copy_sha" == "$image_sha" ]] || { echo "image copy hash mismatch" >&2; exit 4; }
bytes="$(stat -c %s "$work/system.bin")"
entry="0x01000000"
export GHIDRA_USER_HOME="$work/user"
run() { nice -n 10 taskset -c 0-7 "$@"; }

import_status=0
( cd "$scripts" && run "$runner" "$work/project" vad -import "$work/system.bin" \
    -processor CSKY_V2:LE:32:default -loader BinaryLoader -loader-baseAddr "$entry" \
    -noanalysis -scriptPath "$scripts" -preScript PrepareCsky.java "$entry" ) > "$out/ghidra-import.log" 2>&1 || import_status=$?
if [[ "$import_status" -ne 0 ]]; then
  python3 -I - "$out/run-meta.json" "$import_status" "$image_sha" "$bytes" <<'PY'
import json, pathlib, sys
p, status, image_sha, byte_count = sys.argv[1:]
pathlib.Path(p).write_text(json.dumps({"import_process_exit_code": int(status), "candidate_sys_sha256": image_sha, "candidate_sys_bytes": int(byte_count)}, indent=2) + "\n")
PY
  echo "Ghidra import process exit $import_status; no emulation was started"
  exit "$import_status"
fi

process_status=0
( cd "$scripts" && run "$runner" "$work/project" vad -process system.bin -noanalysis -readOnly \
    -scriptPath "$scripts" -postScript VadExactQa393993.java "$out/config.json" "$out/receipt.json" ) > "$out/VadExactQa393993.log" 2>&1 || process_status=$?
cp "$scripts/VadExactQa393993.java" "$out/executed-VadExactQa393993.java"
python3 -I - "$out/run-meta.json" "$process_status" "$image_sha" "$bytes" "$actual_copy_sha" <<'PY'
import json, pathlib, sys
p, status, image_sha, byte_count, copy_sha = sys.argv[1:]
pathlib.Path(p).write_text(json.dumps({
    "ghidra_process_exit_code": int(status),
    "candidate_sys_sha256": image_sha,
    "candidate_sys_bytes": int(byte_count),
    "temporary_copy_sha256": copy_sha,
    "hardware_or_usb_access": False,
}, indent=2) + "\n")
PY
python3 -I "$here/harness/validate_receipt.py" "$out/receipt.json" "$out/config.json"
echo "Ghidra process exit $process_status; exact candidate SYS bytes $bytes; copy SHA-256 $actual_copy_sha"
[[ "$process_status" -eq 0 ]] || exit "$process_status"
