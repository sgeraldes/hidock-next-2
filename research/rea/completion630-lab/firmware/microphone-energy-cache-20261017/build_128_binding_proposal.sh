#!/usr/bin/env bash
# CK802 source-only link at a provisional address. No SYS/container composition.
set -euo pipefail

repo=/mnt/g/Code/hidock-next-2
owned="$repo/research/rea/completion630-lab/firmware/microphone-energy-cache-20261017"
trace="$repo/research/rea/completion630-lab/hardware-vad-trace"
provider="$repo/research/rea/completion630-lab/firmware/vad-provider-fixed-snapshot-20261017"
provider_object="$provider/build/vad_provider_raw_get.enabled.o"
out="$owned/out-provisional-link-20261017-r4"
tool=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

baseline_sys="$repo/research/rea/completion630-lab/firmware/producer-continuation-system-393997/out-NOTINSTALL/system-decoded-393997-continuation-NOTINSTALL.bin"
accepted_sys="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/out-NOTINSTALL/compose-3/system-decoded-NOTINSTALL.bin"
accepted_elf="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"

test ! -e "$out" || { echo "refusing to overwrite $out" >&2; exit 2; }
mkdir "$out"

expect_current_sys=a86acfa502575c0151d31782996b91cebe5143e38f472aa5763915633e825c7e
expect_accepted_sys=043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918
expect_accepted_elf=50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80
expect_provider_object=fafc03ba7db1c65e2686c829a1111855feee47bd1897db9569f886fda25fbecb

sha256sum "$baseline_sys" "$accepted_sys" "$accepted_elf" "$provider_object" > "$out/source-image-pins.sha256"
grep -F "$expect_current_sys" "$out/source-image-pins.sha256" >/dev/null
grep -F "$expect_accepted_sys" "$out/source-image-pins.sha256" >/dev/null
grep -F "$expect_accepted_elf" "$out/source-image-pins.sha256" >/dev/null
grep -F "$expect_provider_object" "$out/source-image-pins.sha256" >/dev/null

ccflags=(-std=c99 -mcpu=ck802 -Os -fshort-enums -fsigned-char -fno-common \
  -fno-delete-null-pointer-checks -ffunction-sections -fdata-sections -fno-lto \
  -Wall -Wextra -Werror)
admission=(-DH1E_VOICE_ENERGY_POLL_ENABLED=1 \
  -DH1E_VOICE_ENERGY_TARGET_BINDING=1 \
  -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 \
  -DH1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128=1 \
  -DH1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE=1 \
  -DH1E_VOICE_ENERGY_BUILD_ADMITTED=1)
admission_missing_constructor=(-DH1E_VOICE_ENERGY_POLL_ENABLED=1 \
  -DH1E_VOICE_ENERGY_TARGET_BINDING=1 \
  -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 \
  -DH1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE=1 \
  -DH1E_VOICE_ENERGY_BUILD_ADMITTED=1)

set +e
"$tool-gcc" "${ccflags[@]}" "${admission_missing_constructor[@]}" -c \
  "$owned/h1e_voice_energy_loader128.c" -o "$out/should-not-build-loader.o" \
  > "$out/loader-missing-constructor-gate.txt" 2>&1
loader_gate_status=$?
"$tool-gcc" "${ccflags[@]}" "${admission_missing_constructor[@]}" -c \
  "$owned/h1e_voice_energy_f11a_reader.c" -o "$out/should-not-build-reader.o" \
  > "$out/reader-missing-constructor-gate.txt" 2>&1
reader_gate_status=$?
set -e
test "$loader_gate_status" -ne 0
test "$reader_gate_status" -ne 0
grep -F 'requires an explicit constructor assertion' "$out/loader-missing-constructor-gate.txt" >/dev/null
grep -F 'requires the 128-byte constructor assertion' "$out/reader-missing-constructor-gate.txt" >/dev/null

"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_cache.c" \
  -o "$out/h1e_voice_energy_cache.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c "$owned/h1e_voice_energy_loader128.c" \
  -o "$out/h1e_voice_energy_loader128.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c "$owned/h1e_voice_energy_poll_adapter.c" \
  -o "$out/h1e_voice_energy_poll_adapter.o"
"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_reply_v2.c" \
  -o "$out/h1e_voice_energy_reply_v2.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c "$owned/h1e_voice_energy_f11a_reader.c" \
  -o "$out/h1e_voice_energy_f11a_reader.o"

# These constants are the live symbols from the accepted CK802 ELF. The current
# 393997 decoded SYS is byte-checked at the same addresses before link proceeds.
"$tool-ld" -T "$owned/provisional-link-1137000.ld" \
  --defsym=h1e_vad_native_poll_bridge=0x01128e34 \
  --defsym=vadt_csky_guard_enter=0x01128aa2 \
  --defsym=vadt_csky_guard_exit=0x01128a9c \
  -e h1e_voice_energy_poll_bridge \
  -Map="$out/voice-energy-provisional.map" \
  "$out/h1e_voice_energy_cache.o" \
  "$out/h1e_voice_energy_loader128.o" \
  "$out/h1e_voice_energy_poll_adapter.o" \
  "$out/h1e_voice_energy_reply_v2.o" \
  "$out/h1e_voice_energy_f11a_reader.o" \
  "$provider_object" \
  -o "$out/voice-energy-provisional.elf"

"$tool-size" -A "$out/voice-energy-provisional.elf" > "$out/sections.txt"
"$tool-nm" -u "$out/voice-energy-provisional.elf" > "$out/undefined.txt"
"$tool-nm" -n -S "$out/voice-energy-provisional.elf" > "$out/symbols.txt"
"$tool-readelf" -h -A "$out/voice-energy-provisional.elf" > "$out/readelf.txt"
"$tool-objdump" -dr "$out/voice-energy-provisional.elf" > "$out/objdump.txt"

undefined_symbols=$(awk '{print $NF}' "$out/undefined.txt" | sort -u)
test -z "$undefined_symbols"
if grep -F 'R_CKCORE_' "$out/objdump.txt" >/dev/null; then
  echo "static provisional ELF still contains unresolved CK802 relocations" >&2
  exit 1
fi
grep -F 'h1e_voice_energy_f11a_reply_select' "$out/symbols.txt" >/dev/null
grep -F 'h1e_voice_energy_f11a_reply_v2_read' "$out/symbols.txt" >/dev/null
grep -F 'h1e_voice_energy_poll_bridge' "$out/symbols.txt" >/dev/null
grep -F 'ASSERT' "$owned/provisional-link-1137000.ld" >/dev/null

# Focused host checks for writer preservation and the 32-byte payload codec.
cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  "$owned/h1e_voice_energy_cache.c" "$owned/test_voice_energy_cache.c" \
  -o "$out/test-cache-host"
"$out/test-cache-host" | tee "$out/cache-host-test.txt"
cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  "$owned/h1e_voice_energy_reply_v2.c" "$owned/test_voice_energy_reply_v2.c" \
  -o "$out/test-reply-v2-host"
"$out/test-reply-v2-host" | tee "$out/reply-v2-host-test.txt"
cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  -DH1E_VOICE_ENERGY_POLL_ENABLED=1 -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 \
  "$owned/h1e_voice_energy_cache.c" "$owned/h1e_voice_energy_poll_adapter.c" \
  "$owned/test_voice_energy_poll_adapter.c" -o "$out/test-poll-adapter-host"
"$out/test-poll-adapter-host" | tee "$out/poll-adapter-host-test.txt"

python3 - "$repo" "$owned" "$out" "$baseline_sys" "$accepted_sys" "$accepted_elf" "$provider" <<'PY'
import hashlib
import json
import pathlib
import struct
import sys

repo, owned, out, current_sys, accepted_sys, accepted_elf, provider = map(pathlib.Path, sys.argv[1:])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

current = current_sys.read_bytes()
accepted = accepted_sys.read_bytes()
regions = [
    ("h1e_vad_native_poll_bridge", 0x01128e34, 24),
    ("vadt_csky_guard_enter", 0x01128aa2, 10),
    ("vadt_csky_guard_exit", 0x01128a9c, 6),
]
region_checks = []
for name, address, length in regions:
    offset = address - 0x01000000
    a, b = current[offset:offset + length], accepted[offset:offset + length]
    if len(a) != length or a != b:
        raise SystemExit(f"current SYS function bytes differ from accepted ELF image: {name}")
    region_checks.append({
        "symbol": name,
        "address": f"0x{address:08x}",
        "length": length,
        "bytes_sha256": hashlib.sha256(a).hexdigest(),
        "current_393997_matches_accepted_elf": True,
    })

obj = out / "voice-energy-provisional.elf"
syms = (out / "symbols.txt").read_text(encoding="utf-8")
end_line = next((line for line in syms.splitlines() if line.endswith(" __voice_energy_provisional_end")), None)
if end_line is None:
    raise SystemExit("linker did not emit the provisional end symbol")
end = int(end_line.split()[0], 16)
if not (0x01137000 <= end <= 0x01137800):
    raise SystemExit(f"provisional link end outside 2 KiB window: 0x{end:08x}")
size = end - 0x01137000

sources = [
    "h1e_voice_energy_cache.h", "h1e_voice_energy_cache.c",
    "h1e_voice_energy_poll_adapter.h", "h1e_voice_energy_poll_adapter.c",
    "h1e_voice_energy_loader128.h", "h1e_voice_energy_loader128.c",
    "h1e_voice_energy_reply_v2.h", "h1e_voice_energy_reply_v2.c",
    "h1e_voice_energy_f11a_reader.h", "h1e_voice_energy_f11a_reader.c",
    "provisional-link-1137000.ld", "build_128_binding_proposal.sh",
    "INTEGRATION-PLAN.md", "README.md", "test_voice_energy_cache.c",
    "test_voice_energy_poll_adapter.c", "test_voice_energy_reply_v2.c",
]
receipt = {
    "schema": "h1e-voice-energy-128-binding-provisional-link-v1",
    "status": "offline_provisional_link_source_only_not_reserved_not_composed",
    "identity": {
        "current_decoded_sys_sha256": sha(current_sys),
        "accepted_composition_sys_sha256": sha(accepted_sys),
        "accepted_elf_sha256": sha(accepted_elf),
        "current_sys_load_base": "0x01000000",
    },
    "external_symbol_pins": region_checks,
    "provisional_layout": {
        "start": "0x01137000",
        "end_exclusive": f"0x{end:08x}",
        "window_end_exclusive": "0x01137800",
        "bytes": size,
        "fits_2k_evaluation_window": True,
        "ownership_or_vma_reservation_granted": False,
        "image_or_container_composed": False,
    },
    "provider": {
        "symbol": "vad_provider_raw_get",
        "object_linked": True,
        "object_path": "research/rea/completion630-lab/firmware/vad-provider-fixed-snapshot-20261017/build/vad_provider_raw_get.enabled.o",
        "object_sha256": "fafc03ba7db1c65e2686c829a1111855feee47bd1897db9569f886fda25fbecb",
        "header_sha256_at_build": sha(provider / "src" / "vad_provider_raw_get.h"),
        "implementation_sha256_at_build": sha(provider / "src" / "vad_provider_raw_get.c"),
    },
    "features": {
        "object_extent": "0x80",
        "sidecar_offset": "0x60",
        "f11a_v1_selector": "delegates directly to the caller-supplied existing v1 callback",
        "f11a_v2_selector": "bounded cache snapshot only; never queries provider",
        "voice_or_microphone_semantics": "unknown; raw/status/counters only",
        "target_build_assertions": [
            "H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1",
            "H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128=1",
            "H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE=1",
            "H1E_VOICE_ENERGY_BUILD_ADMITTED=1",
        ],
        "assertions_are_evidence": False,
    },
    "linked_elf": {"path": obj.name, "bytes": obj.stat().st_size, "sha256": sha(obj),
                   "fully_resolved_relocations": True, "undefined_symbol_count": 0},
    "objects": [{"path": p.name, "bytes": p.stat().st_size, "sha256": sha(p)}
                for p in sorted(out.glob("*.o"))],
    "sources": {name: sha(owned / name) for name in sources},
    "host_results": {
        "cache": (out / "cache-host-test.txt").read_text(encoding="utf-8").strip(),
        "reply_v2": (out / "reply-v2-host-test.txt").read_text(encoding="utf-8").strip(),
        "poll_adapter_fake_ops": (out / "poll-adapter-host-test.txt").read_text(encoding="utf-8").strip(),
    },
    "undefined_symbols": (out / "undefined.txt").read_text(encoding="utf-8").splitlines(),
    "negative_admission_checks": {
        "loader_without_constructor128_assertion": "refused as expected",
        "reader_without_constructor128_assertion": "refused as expected",
        "logs": ["loader-missing-constructor-gate.txt", "reader-missing-constructor-gate.txt"],
    },
    "limits": [
        "No SYS/container composition or VMA reservation.",
        "Provider object is linked from the other owner's pinned enabled adapter build.",
        "Constructor128 and detach-before-free are compile assertions, not established lifecycle evidence.",
        "No claim of microphone routing, freshness, voice semantics, target memory ordering, installation, or release qualification.",
    ],
}
(out / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
PY

find "$out" -maxdepth 1 -type f ! -name output-sha256.txt -print0 | sort -z | xargs -0 sha256sum > "$out/output-sha256.txt"
