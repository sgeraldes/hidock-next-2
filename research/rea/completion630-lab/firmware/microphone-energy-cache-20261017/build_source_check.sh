#!/usr/bin/env bash
# Source-only C checks. Does not link a firmware image or access hardware.
set -euo pipefail

repo=/mnt/g/Code/hidock-next-2
owned="$repo/research/rea/completion630-lab/firmware/microphone-energy-cache-20261017"
trace="$repo/research/rea/completion630-lab/hardware-vad-trace"
out="$owned/out-integration-source-check"
tool=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

mkdir -p "$out"
ccflags=(-std=c99 -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common \
  -fno-delete-null-pointer-checks -ffunction-sections -fdata-sections -fno-lto \
  -Wall -Wextra -Werror)

"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_cache.c" \
  -o "$out/h1e_voice_energy_cache.ck802.o"
"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_poll_adapter.c" \
  -o "$out/h1e_voice_energy_poll_adapter-disabled.ck802.o"
"$tool-gcc" "${ccflags[@]}" -DH1E_VOICE_ENERGY_POLL_ENABLED=1 \
  -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 -c \
  "$owned/h1e_voice_energy_poll_adapter.c" \
  -o "$out/h1e_voice_energy_poll_adapter-enabled-compile-only.ck802.o"
"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_reply_v2.c" \
  -o "$out/h1e_voice_energy_reply_v2.ck802.o"

"$tool-ld" -r "$out/h1e_voice_energy_cache.ck802.o" \
  "$out/h1e_voice_energy_poll_adapter-enabled-compile-only.ck802.o" \
  "$out/h1e_voice_energy_reply_v2.ck802.o" \
  -o "$out/h1e_voice_energy_integrated-source-only.ck802.o"
"$tool-size" -A "$out/h1e_voice_energy_cache.ck802.o" > "$out/cache-size.txt"
"$tool-size" -A "$out/h1e_voice_energy_poll_adapter-disabled.ck802.o" > "$out/adapter-disabled-size.txt"
"$tool-size" -A "$out/h1e_voice_energy_poll_adapter-enabled-compile-only.ck802.o" > "$out/adapter-enabled-size.txt"
"$tool-size" -A "$out/h1e_voice_energy_reply_v2.ck802.o" > "$out/reply-v2-size.txt"
"$tool-size" -A "$out/h1e_voice_energy_integrated-source-only.ck802.o" > "$out/integrated-size.txt"
"$tool-readelf" -h -A "$out/h1e_voice_energy_integrated-source-only.ck802.o" > "$out/integrated-readelf.txt"
"$tool-nm" -u "$out/h1e_voice_energy_integrated-source-only.ck802.o" > "$out/integrated-undefined.txt"
"$tool-objdump" -dr "$out/h1e_voice_energy_integrated-source-only.ck802.o" > "$out/integrated-objdump.txt"

cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  -DH1E_VOICE_ENERGY_POLL_ENABLED=1 -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 \
  "$owned/h1e_voice_energy_cache.c" "$owned/h1e_voice_energy_poll_adapter.c" \
  "$owned/test_voice_energy_poll_adapter.c" -o "$out/test-poll-adapter-host"
"$out/test-poll-adapter-host" | tee "$out/poll-adapter-host-test.txt"

cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  "$owned/h1e_voice_energy_reply_v2.c" "$owned/test_voice_energy_reply_v2.c" \
  -o "$out/test-reply-v2-host"
"$out/test-reply-v2-host" | tee "$out/reply-v2-host-test.txt"

printf '%q ' "$tool-gcc" "${ccflags[@]}" -c \
  "$owned/h1e_voice_energy_cache.c" -o "$out/h1e_voice_energy_cache.ck802.o" \
  > "$out/build-commands.txt"
printf '\n' >> "$out/build-commands.txt"
printf '%q ' "$tool-gcc" "${ccflags[@]}" -c \
  "$owned/h1e_voice_energy_poll_adapter.c" -o \
  "$out/h1e_voice_energy_poll_adapter-disabled.ck802.o" >> "$out/build-commands.txt"
printf '\n' >> "$out/build-commands.txt"
printf '%q ' "$tool-gcc" "${ccflags[@]}" \
  -DH1E_VOICE_ENERGY_POLL_ENABLED=1 \
  -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 -c \
  "$owned/h1e_voice_energy_poll_adapter.c" -o \
  "$out/h1e_voice_energy_poll_adapter-enabled-compile-only.ck802.o" >> "$out/build-commands.txt"
printf '\n' >> "$out/build-commands.txt"
printf '%q ' "$tool-gcc" "${ccflags[@]}" -c \
  "$owned/h1e_voice_energy_reply_v2.c" -o \
  "$out/h1e_voice_energy_reply_v2.ck802.o" >> "$out/build-commands.txt"
printf '\n' >> "$out/build-commands.txt"

python3 - "$owned" "$out" "$tool" <<'PY'
import hashlib
import json
import pathlib
import subprocess
import sys

owned = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
tool = pathlib.Path(sys.argv[3])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def relative(path):
    return path.relative_to(owned.parents[4]).as_posix()

sources = [
    "h1e_voice_energy_cache.h", "h1e_voice_energy_cache.c",
    "h1e_voice_energy_poll_adapter.h", "h1e_voice_energy_poll_adapter.c",
    "h1e_voice_energy_reply_v2.h", "h1e_voice_energy_reply_v2.c",
    "test_voice_energy_cache.c", "test_voice_energy_poll_adapter.c",
    "test_voice_energy_reply_v2.c", "build_source_check.sh", "INTEGRATION-PLAN.md", "README.md",
]
objects = sorted(out.glob("*.ck802.o"))
checks = [
    "poll adapter host fixture: pass; injected fake callback only",
    "v2 payload host fixture: pass",
    "CK802 relocatable object compilation: pass",
    "firmware image link/compose: not performed",
    "provider address/direct API import: none",
    "enabled object unresolved seam: h1e_voice_energy_poll_ops table; compile-only structural exercise, not an ABI approval or integration build",
    "microphone/source-route/freshness/voice semantics: unknown",
]
receipt = {
    "schema": "h1e-voice-energy-source-check-v1",
    "status": "source_objects_and_focused_host_checks_passed",
    "build_profile": {
        "compiler": str(tool) + "-gcc",
        "flags": ["-std=c99", "-mcpu=ck802", "-Os", "-fshort-enums", "-fsigned-char",
                  "-fno-common", "-fno-delete-null-pointer-checks", "-ffunction-sections",
                  "-fdata-sections", "-fno-lto", "-Wall", "-Wextra", "-Werror"],
        "default_poll_feature": "disabled",
        "enabled_poll_object": "compile-only structural exercise with a fake/injected callback; not for integration",
    },
    "source_pins": {name: {"path": relative(owned / name), "sha256": sha(owned / name)} for name in sources},
    "objects": [{"path": relative(path), "bytes": path.stat().st_size, "sha256": sha(path)} for path in objects],
    "section_reports": {path.name: path.read_text(encoding="utf-8") for path in sorted(out.glob("*-size.txt"))},
    "host_results": {
        "poll_adapter": (out / "poll-adapter-host-test.txt").read_text(encoding="utf-8").strip(),
        "reply_v2": (out / "reply-v2-host-test.txt").read_text(encoding="utf-8").strip(),
    },
    "checks_and_limits": checks,
    "undefined_symbols_in_combined_object": (out / "integrated-undefined.txt").read_text(encoding="utf-8").splitlines(),
}
(out / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
PY

sha256sum "$out"/*.ck802.o "$out"/build-receipt.json > "$out/sha256.txt"
