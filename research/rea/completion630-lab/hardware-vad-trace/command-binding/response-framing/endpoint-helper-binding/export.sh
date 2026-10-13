#!/usr/bin/env bash
set -euo pipefail
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export GHIDRA_HEADLESS_MAXMEM=1G
root=/mnt/g/Code/hidock-next-2/research/rea
out="$root/completion630-lab/hardware-vad-trace/command-binding/response-framing/endpoint-helper-binding/export"
mkdir -p "$out"
/home/sebastian/.local/share/rea/ghidra_12.1.4_PUBLIC/support/analyzeHeadless \
  /home/sebastian/rea-projects hidock-h1e630-acceptance \
  -process zephyr-decoded.bin -noanalysis -readOnly \
  -scriptPath "$root/completion630-lab/hardware-vad-trace/command-binding/response-framing/endpoint-helper-binding" \
  -postScript ExportEndpointHelpers630.java "$out" > "$out/export.log" 2>&1
cat "$out/export.log"
