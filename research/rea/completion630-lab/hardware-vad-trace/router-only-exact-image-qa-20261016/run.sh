#!/usr/bin/env bash
# Bounded CK802 instruction gate for one pinned combined SYS candidate.
# This imports an exact whole image read-only and runs four focused fixture groups.
# It does not build firmware, compose/package images, or access hardware.
set -euo pipefail
stage="${1:?stage compile|run}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$here/../../firmware"
ghidra=/home/sebastian/.local/share/rea/ghidra_12.1.4_PUBLIC
runner="$ghidra/support/analyzeHeadless"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export GHIDRA_HEADLESS_MAXMEM=2G
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

work="$(mktemp -d /tmp/vad-exact-instruction-qa-XXXXXX)"
scripts="$work/scripts"
mkdir -p "$scripts" "$work/classes" "$work/project" "$work/user"
cp "$fw/native-notify-image-runtime/harness/BoundedNativeContract630.java" "$scripts/"
cp "$fw/native-notify-image-runtime/harness/PrepareCsky.java" "$scripts/"
cp "$here/harness/VadExactQa630.java" "$scripts/"
cp_jars="$(find "$ghidra/Ghidra" -name '*.jar' | tr '\n' ':')"
nice -n 10 "$JAVA_HOME/bin/javac" -proc:none -nowarn -cp "$cp_jars" -d "$work/classes" "$scripts"/*.java
echo "javac: ok; harness only, no firmware build"
if [[ "$stage" == "compile" ]]; then
  exit 0
fi
[[ "$stage" == "run" ]] || { echo "stage must be compile or run" >&2; exit 2; }

image="${2:?exact candidate image path}"
image_sha="${3:?exact candidate SHA-256}"
elf_sha="${4:?linked candidate ELF SHA-256}"
symbols="${5:?candidate symbols.txt path}"
symbols_sha="${6:?symbols.txt SHA-256}"
layout="${7:?candidate layout-readback.json path}"
layout_sha="${8:?layout-readback.json SHA-256}"
out="${9:?output directory}"
case_mode="${10:-all}"
[[ "$case_mode" == "all" || "$case_mode" == "skip-constructor" ]] || { echo "case mode must be all|skip-constructor" >&2; exit 2; }
mkdir -p "$out"
cp "$here/harness/configure.py" "$work/"
python3 -I "$work/configure.py" "$image" "$image_sha" "$elf_sha" "$symbols" "$symbols_sha" "$layout" "$layout_sha" "$out/config.json"

if ps -eo args | grep -v grep | grep -qE 'analyzeHeadless|Ghidra-Headless|ghidra.Ghidra'; then
  echo "Another Ghidra headless run is active; not starting" >&2
  exit 3
fi
if [[ -f "$image" ]]; then
  image_wsl="$image"
else
  image_wsl="$(wslpath -u "$image")"
fi
cp "$image_wsl" "$work/system.bin"
actual_copy_sha="$(sha256sum "$work/system.bin" | cut -d' ' -f1)"
[[ "$actual_copy_sha" == "$image_sha" ]] || { echo "image copy hash mismatch" >&2; exit 4; }
bytes="$(stat -c %s "$work/system.bin")"
entry="0x01000000"
export GHIDRA_USER_HOME="$work/user"
run() { nice -n 10 taskset -c 0-7 "$@"; }

( cd "$scripts" && run "$runner" "$work/project" vad -import "$work/system.bin" \
    -processor CSKY_V2:LE:32:default -loader BinaryLoader -loader-baseAddr "$entry" \
    -noanalysis -scriptPath "$scripts" -preScript PrepareCsky.java "$entry" ) > "$out/ghidra-import.log"
grep -E '^INFO  PrepareCsky> C-SKY entry:|ERROR|Exception' "$out/ghidra-import.log" | grep -v '^INFO  HEADLESS' || true
ghidra_status=0
script_args=("$out/config.json" "$out/receipt.json")
if [[ "$case_mode" == "skip-constructor" ]]; then script_args+=("skip-constructor"); fi
( cd "$scripts" && run "$runner" "$work/project" vad -process system.bin -noanalysis -readOnly \
    -scriptPath "$scripts" -postScript VadExactQa630.java "${script_args[@]}" ) > "$out/VadExactQa630.log" || ghidra_status=$?
cp "$scripts/VadExactQa630.java" "$out/executed-VadExactQa630.java"
python3 -I "$here/validate_receipt.py" "$out/receipt.json" "$image_sha" "$elf_sha"
echo "Ghidra process exit $ghidra_status (receipt validator is authoritative); image bytes $bytes; copy SHA-256 $actual_copy_sha"
