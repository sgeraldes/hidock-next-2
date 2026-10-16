#!/usr/bin/env bash
set -euo pipefail
work="${1:?existing exact-image Ghidra work directory}"
expected_sha="${2:?pinned SYS SHA-256}"
log="${3:?trace log path}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ghidra=/home/sebastian/.local/share/rea/ghidra_12.1.4_PUBLIC
runner="$ghidra/support/analyzeHeadless"
[[ -f "$work/project/vad.gpr" ]]
[[ -f "$work/system.bin" ]]
actual_sha="$(sha256sum "$work/system.bin" | cut -d' ' -f1)"
[[ "$actual_sha" == "$expected_sha" ]] || { echo "already-imported SYS SHA mismatch" >&2; exit 4; }
if ps -eo args | grep -v grep | grep -qE 'analyzeHeadless|Ghidra-Headless|ghidra.Ghidra'; then
  echo "Another Ghidra headless run is active; not starting" >&2
  exit 3
fi
cp "$here/harness/F11aSnapshotTrace630.java" "$work/scripts/"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export GHIDRA_USER_HOME="$work/user" GHIDRA_HEADLESS_MAXMEM=2G
( cd "$work/scripts" && nice -n 10 taskset -c 0-7 "$runner" "$work/project" vad -process system.bin \
    -noanalysis -readOnly -scriptPath "$work/scripts" -postScript F11aSnapshotTrace630.java ) > "$log"
echo "read-only trace reused existing exact SYS import $expected_sha"
