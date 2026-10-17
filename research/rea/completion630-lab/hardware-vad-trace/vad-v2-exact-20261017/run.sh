#!/usr/bin/env bash
# One bounded exact-instruction run against the pinned NOTINSTALL emulator fixture.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lab="$here/../.."
fw="$lab/firmware"
image="$fw/microphone-energy-instruction-fixture-20261017/out-INSTRUCTION-FIXTURE-NOTINSTALL/instruction-fixture-393998-voice-energy-NOTINSTALL.bin"
fixture_receipt="$fw/microphone-energy-instruction-fixture-20261017/out-INSTRUCTION-FIXTURE-NOTINSTALL/fixture-receipt.json"
out="$here/out-NOTINSTALL/four-cases"
ghidra=/home/sebastian/.local/share/rea/ghidra_12.1.4_PUBLIC
runner="$ghidra/support/analyzeHeadless"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export GHIDRA_HEADLESS_MAXMEM=2G
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

[[ -f "$image" && -f "$fixture_receipt" ]] || { echo "pinned emulator fixture or receipt missing" >&2; exit 2; }
[[ "$(sha256sum "$image" | cut -d' ' -f1)" == cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482 ]] || { echo "exact emulator fixture SHA mismatch" >&2; exit 3; }
[[ "$(sha256sum "$fixture_receipt" | cut -d' ' -f1)" == e6d16935bcbc1d5a323a6b8de3b9ecfc994a197478afa5028f689e6104c0ea4d ]] || { echo "fixture receipt SHA mismatch" >&2; exit 4; }
[[ "$(stat -c %s "$image")" == 1275904 ]] || { echo "exact emulator fixture size mismatch" >&2; exit 5; }
if ps -eo args | grep -v grep | grep -qE 'analyzeHeadless|Ghidra-Headless|ghidra.Ghidra'; then
  echo "Another Ghidra run is active; leaving its process untouched" >&2
  exit 6
fi

work="$(mktemp -d /tmp/vad-v2-exact-XXXXXX)"
trap 'rm -rf "$work"' EXIT
scripts="$work/scripts"
mkdir -p "$scripts" "$work/classes" "$work/project" "$work/user" "$out"
cp "$fw/native-notify-image-runtime/harness/BoundedNativeContract630.java" "$scripts/"
cp "$fw/native-notify-image-runtime/harness/PrepareCsky.java" "$scripts/"
cp "$here/harness/VoiceEnergyV2ExactInstructionGate.java" "$scripts/"
cp_jars="$(find "$ghidra/Ghidra" -name '*.jar' | tr '\n' ':')"
nice -n 10 "$JAVA_HOME/bin/javac" -proc:none -nowarn -cp "$cp_jars" -d "$work/classes" "$scripts"/*.java
cp "$scripts/VoiceEnergyV2ExactInstructionGate.java" "$out/executed-VoiceEnergyV2ExactInstructionGate.java"
cp "$image" "$work/system.bin"
actual_copy_sha="$(sha256sum "$work/system.bin" | cut -d' ' -f1)"
[[ "$actual_copy_sha" == cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482 ]] || { echo "temporary exact image copy SHA mismatch" >&2; exit 7; }

if [[ ! -x "$runner" ]]; then echo "Ghidra headless runner unavailable at $runner" >&2; exit 8; fi
export GHIDRA_USER_HOME="$work/user"
run() { nice -n 10 taskset -c 0-7 "$@"; }
entry=0x01000000
import_status=0
(cd "$scripts" && run "$runner" "$work/project" vad -import "$work/system.bin" \
  -processor CSKY_V2:LE:32:default -loader BinaryLoader -loader-baseAddr "$entry" \
  -noanalysis -scriptPath "$scripts" -preScript PrepareCsky.java "$entry") > "$out/ghidra-import.log" 2>&1 || import_status=$?
if [[ "$import_status" -ne 0 ]]; then
  printf '{"import_process_exit_code":%d,"fixture_sha256":"%s","fixture_bytes":1275904,"emulation_started":false}\n' \
    "$import_status" cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482 > "$out/run-meta.json"
  echo "Ghidra import failed; no instruction fixtures were run" >&2
  exit "$import_status"
fi

image_abs="$(realpath "$image")"
receipt_abs="$(realpath "$fixture_receipt")"
case_receipt_abs="$(realpath -m "$out/receipt.json")"
process_status=0
(cd "$scripts" && run "$runner" "$work/project" vad -process system.bin -noanalysis -readOnly \
  -scriptPath "$scripts" -postScript VoiceEnergyV2ExactInstructionGate.java "$image_abs" "$receipt_abs" "$case_receipt_abs") \
  > "$out/VoiceEnergyV2ExactInstructionGate.log" 2>&1 || process_status=$?
receipt_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("status", "missing"))' "$out/receipt.json" 2>/dev/null || echo missing)"
case_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8")).get("cases", [])))' "$out/receipt.json" 2>/dev/null || echo 0)"
if [[ "$receipt_status" != passed_four_exact_fixture_cases || "$case_count" != 4 ]]; then
  [[ "$process_status" -ne 0 ]] || process_status=9
fi
printf '{"ghidra_process_exit_code":%d,"qa_status":"%s","case_count":%d,"fixture_sha256":"%s","fixture_bytes":1275904,"temporary_copy_sha256":"%s","hardware_usb_app_access":false,"firmware_build_or_composition":false}\n' \
  "$process_status" "$receipt_status" "$case_count" cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482 "$actual_copy_sha" > "$out/run-meta.json"
sha_files=("$image" "$fixture_receipt" "$out/executed-VoiceEnergyV2ExactInstructionGate.java" "$out/VoiceEnergyV2ExactInstructionGate.log" "$out/run-meta.json" "$out/receipt.json")
for preserved in "$out/receipt-first-run.json" "$out/VoiceEnergyV2ExactInstructionGate-first-run.log" "$out/run-meta-first-run.json"; do
  [[ -f "$preserved" ]] && sha_files+=("$preserved")
done
sha256sum "${sha_files[@]}" > "$out/SHA256SUMS"
echo "Four-case emulator gate process exit=$process_status; fixture SHA=$actual_copy_sha; receipt=$out/receipt.json"
exit "$process_status"
