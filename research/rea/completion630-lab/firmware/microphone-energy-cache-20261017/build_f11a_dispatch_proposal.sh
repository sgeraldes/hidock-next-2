#!/usr/bin/env bash
# One bounded CK802 source/link proposal. Does not compose or modify a SYS.
set -euo pipefail

repo=/mnt/g/Code/hidock-next-2
owned="$repo/research/rea/completion630-lab/firmware/microphone-energy-cache-20261017"
trace="$repo/research/rea/completion630-lab/hardware-vad-trace"
provider="$repo/research/rea/completion630-lab/firmware/vad-provider-fixed-snapshot-20261017"
provider_object="$provider/build/vad_provider_raw_get.enabled.o"
current_393997="$repo/research/rea/completion630-lab/firmware/producer-continuation-system-393997/out-NOTINSTALL/system-decoded-393997-continuation-NOTINSTALL.bin"
current_393998="$repo/research/rea/completion630-lab/firmware/producer-lifecycle-system-393998/out-NOTINSTALL/system-decoded-393998-lifecycle-NOTINSTALL.bin"
accepted_sys="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/out-NOTINSTALL/compose-3/system-decoded-NOTINSTALL.bin"
accepted_elf="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"
accepted_symbols="$repo/research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/sized-symbols.txt"
out="$owned/out-provisional-link-20261017-r5-dispatch-fix5"
tool=/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf

# Fail closed if the accepted input set is incomplete or any pinned file changed.
test ! -e "$out" || { echo "refusing to overwrite $out" >&2; exit 2; }
mkdir "$out"

expect_393997=a86acfa502575c0151d31782996b91cebe5143e38f472aa5763915633e825c7e
expect_393998=f2e391ca2c895c1d34e1a49639d00571a18418886a25d4200247875cf86a4c3e
expect_accepted_sys=043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918
expect_accepted_elf=50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80
expect_provider_object=fafc03ba7db1c65e2686c829a1111855feee47bd1897db9569f886fda25fbecb

sha256sum "$current_393997" "$current_393998" "$accepted_sys" "$accepted_elf" "$accepted_symbols" "$provider_object" > "$out/source-image-pins.sha256"
grep -F "$expect_393997" "$out/source-image-pins.sha256" >/dev/null
grep -F "$expect_393998" "$out/source-image-pins.sha256" >/dev/null
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
  -DH1E_VOICE_ENERGY_BUILD_ADMITTED=1 \
  -DH1E_VOICE_ENERGY_F11A_DISPATCH_ADMITTED=1)

"$tool-gcc" "${ccflags[@]}" "${admission[@]}" \
  -I"$trace/native-frame-candidate" -I"$trace/fresh-sample-candidate" \
  -c "$owned/h1e_voice_energy_f11a_dispatch.c" \
  -o "$out/h1e_voice_energy_f11a_dispatch.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c \
  "$owned/h1e_voice_energy_loader128.c" -o "$out/h1e_voice_energy_loader128.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c \
  "$owned/h1e_voice_energy_poll_adapter.c" -o "$out/h1e_voice_energy_poll_adapter.o"
"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_cache.c" \
  -o "$out/h1e_voice_energy_cache.o"
"$tool-gcc" "${ccflags[@]}" -c "$owned/h1e_voice_energy_reply_v2.c" \
  -o "$out/h1e_voice_energy_reply_v2.o"
"$tool-gcc" "${ccflags[@]}" "${admission[@]}" -c \
  "$owned/h1e_voice_energy_f11a_reader.c" \
  -o "$out/h1e_voice_energy_f11a_reader.o"
"$tool-gcc" -mcpu=ck802 -c "$owned/integration-calls.S" \
  -o "$out/integration-calls.o"

"$tool-ld" -T "$owned/provisional-link-voice-energy-r5.ld" \
  --defsym=h1e_vad_native_poll_bridge=0x01128e34 \
  --defsym=vadt_csky_guard_enter=0x01128aa2 \
  --defsym=vadt_csky_guard_exit=0x01128a9c \
  --defsym=console630_vad_parse_current=0x01128d08 \
  --defsym=console630_vad_response_current=0x01128bf4 \
  -e h1e_voice_energy_poll_bridge \
  -Map="$out/voice-energy-provisional.map" \
  "$out/integration-calls.o" \
  "$out/h1e_voice_energy_cache.o" \
  "$out/h1e_voice_energy_loader128.o" \
  "$out/h1e_voice_energy_poll_adapter.o" \
  "$out/h1e_voice_energy_reply_v2.o" \
  "$out/h1e_voice_energy_f11a_reader.o" \
  "$out/h1e_voice_energy_f11a_dispatch.o" \
  "$provider_object" \
  -o "$out/voice-energy-provisional.elf"

"$tool-size" -A "$out/voice-energy-provisional.elf" > "$out/sections.txt"
"$tool-nm" -u "$out/voice-energy-provisional.elf" > "$out/undefined.txt"
"$tool-nm" -n -S "$out/voice-energy-provisional.elf" > "$out/symbols.txt"
"$tool-readelf" -h -A "$out/voice-energy-provisional.elf" > "$out/readelf.txt"
"$tool-objdump" -dr "$out/voice-energy-provisional.elf" > "$out/objdump.txt"
"$tool-objcopy" --dump-section .poll_dispatch_call="$out/poll-call.bin" "$out/voice-energy-provisional.elf"
"$tool-objcopy" --dump-section .parser_dispatch_call="$out/parser-call.bin" "$out/voice-energy-provisional.elf"
"$tool-objcopy" --dump-section .response_dispatch_call="$out/response-call.bin" "$out/voice-energy-provisional.elf"
"$tool-objcopy" --dump-section .constructor_allocate128="$out/constructor-allocate-128.bin" "$out/voice-energy-provisional.elf"
"$tool-objcopy" --dump-section .constructor_zero128="$out/constructor-zero-128.bin" "$out/voice-energy-provisional.elf"

test -z "$(awk '{print $NF}' "$out/undefined.txt" | sort -u)"
if grep -F 'R_CKCORE_' "$out/objdump.txt" >/dev/null; then
  echo "static provisional ELF still contains unresolved CK802 relocations" >&2
  exit 1
fi
grep -F 'h1e_voice_energy_f11a_parse_shim' "$out/symbols.txt" >/dev/null
grep -F 'h1e_voice_energy_f11a_response_shim' "$out/symbols.txt" >/dev/null
grep -F 'h1e_voice_energy_poll_bridge' "$out/symbols.txt" >/dev/null
grep -F 'console630_vad_parse_current' "$out/symbols.txt" >/dev/null
grep -F 'console630_vad_response_current' "$out/symbols.txt" >/dev/null

# Focused host exercise of only the added dispatch contract.
cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  -DH1E_VOICE_ENERGY_TARGET_BINDING=1 \
  -DH1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED=1 \
  -DH1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128=1 \
  -DH1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE=1 \
  -DH1E_VOICE_ENERGY_BUILD_ADMITTED=1 \
  -DH1E_VOICE_ENERGY_F11A_DISPATCH_ADMITTED=1 \
  -DH1E_VOICE_ENERGY_DISPATCH_HOST_TEST=1 \
  "$owned/h1e_voice_energy_f11a_dispatch.c" \
  "$owned/test_voice_energy_f11a_dispatch.c" \
  -o "$out/test-f11a-dispatch-host"
"$out/test-f11a-dispatch-host" | tee "$out/f11a-dispatch-host-test.txt"

python3 - "$repo" "$owned" "$out" "$current_393997" "$current_393998" "$accepted_sys" "$accepted_elf" "$accepted_symbols" "$provider" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

repo, owned, out, p393997, p393998, accepted_sys, accepted_elf, accepted_symbols, provider = map(pathlib.Path, sys.argv[1:])

def sha(data):
    return hashlib.sha256(data).hexdigest()

def file_sha(path):
    return sha(path.read_bytes())

images = {"393997": p393997.read_bytes(), "393998": p393998.read_bytes()}
base = 0x01000000
spans = [
    ("console630_parse_vad_aware_wrapper", 0x01128d08, 0xb2),
    ("console630_response_vad_aware_wrapper", 0x01128bf4, 0x114),
    ("h1e_vad_native_poll_bridge", 0x01128e34, 0x18),
    ("vadt_csky_guard_enter", 0x01128aa2, 10),
    ("vadt_csky_guard_exit", 0x01128a9c, 6),
    ("console_parser_wrapper_dispatch_call", 0x01128e68, 4),
    ("console_response_wrapper_dispatch_call", 0x01128ea2, 4),
]
span_checks = []
for name, address, length in spans:
    off = address - base
    first = images["393997"][off:off + length]
    second = images["393998"][off:off + length]
    if len(first) != length or first != second:
        raise SystemExit(f"pinned system span differs between 393997 and installed 393998: {name}")
    span_checks.append({
        "name": name,
        "address": f"0x{address:08x}",
        "length": length,
        "sha256_393997_and_393998": sha(first),
        "bytes_hex": first.hex(),
        "matches_393997": True,
        "matches_installed_393998": True,
    })

call_sites = [
    ("poll", 0x01020b62, "poll-call.bin", "h1e_voice_energy_poll_bridge"),
    ("parse", 0x01128e68, "parser-call.bin", "h1e_voice_energy_f11a_parse_shim"),
    ("response", 0x01128ea2, "response-call.bin", "h1e_voice_energy_f11a_response_shim"),
]
sym_lines = (out / "symbols.txt").read_text(encoding="utf-8").splitlines()
symtab = {}
for line in sym_lines:
    fields = line.split()
    if len(fields) >= 3:
        try:
            symtab[fields[-1]] = int(fields[0], 16)
        except ValueError:
            pass
objdump = (out / "objdump.txt").read_text(encoding="utf-8")
accepted_symbol_lines = accepted_symbols.read_text(encoding="utf-8").splitlines()
for expected in [
    "01128d08 000000b2 T console630_parse",
    "01128bf4 00000114 T console630_response",
    "01128e4c T console630_parser_hook",
    "01128e94 T console630_response_hook",
]:
    if not any(line.strip() == expected for line in accepted_symbol_lines):
        raise SystemExit(f"accepted ELF symbol pin not found: {expected}")
call_checks = []
for kind, address, binary, target in call_sites:
    old = images["393998"][address - base:address - base + 4]
    new = (out / binary).read_bytes()
    if len(old) != 4 or len(new) != 4 or target not in symtab:
        raise SystemExit(f"missing call-site bytes or symbol: {kind}")
    line = next((line for line in objdump.splitlines()
                 if re.search(rf"\b{address:x}:\s", line)), None)
    if line is None or "bsr" not in line.lower() or f"0x{symtab[target]:x}" not in line.lower():
        raise SystemExit(f"linked call does not disassemble to its pinned target: {kind}: {line}")
    call_checks.append({
        "kind": kind,
        "address": f"0x{address:08x}",
        "current_393998_bytes_hex": old.hex(),
        "proposed_bytes_hex": new.hex(),
        "target_symbol": target,
        "target_address": f"0x{symtab[target]:08x}",
        "linked_disassembly": line.strip(),
        "applied_to_sys": False,
    })

delegation_checks = []
for kind, address, target in [
    ("parse", 0x01128d08, "console630_vad_parse_current"),
    ("response", 0x01128bf4, "console630_vad_response_current"),
]:
    if symtab.get(target) != address:
        raise SystemExit(f"VAD-aware delegate alias does not resolve to accepted function: {target}")
    line = next((line for line in objdump.splitlines()
                 if "bsr" in line.lower() and f"0x{address:x}" in line.lower() and target in line), None)
    if line is None:
        raise SystemExit(f"new shim does not delegate through VAD-aware function: {target}")
    delegation_checks.append({
        "kind": kind,
        "symbol": target,
        "address": f"0x{address:08x}",
        "linked_disassembly": line.strip(),
        "this_is_the_vad_aware_dispatcher": True,
    })

constructor_changes = []
for name, address, binary, oldhex, register in [
    ("allocate_128", 0x01021054, "constructor-allocate-128.bin", "6030", "r0"),
    ("zero_128", 0x0102109e, "constructor-zero-128.bin", "6032", "r2"),
]:
    old = images["393998"][address - base:address - base + 2]
    new = (out / binary).read_bytes()
    if old.hex() != oldhex or len(new) != 2:
        raise SystemExit(f"constructor 96->128 plan did not match exact system bytes: {name}")
    constructor_changes.append({
        "kind": name,
        "address": f"0x{address:08x}",
        "current_96_instruction_bytes_hex": old.hex(),
        "proposed_128_instruction_bytes_hex": new.hex(),
        "register": register,
        "meaning": f"movi {register}, 0x80",
        "applied_to_sys": False,
    })

elf = out / "voice-energy-provisional.elf"
module_lines = (out / "symbols.txt").read_text(encoding="utf-8").splitlines()
end_line = next((line for line in module_lines if line.endswith(" __voice_energy_provisional_end")), None)
if end_line is None:
    raise SystemExit("linker did not emit the provisional end symbol")
end = int(end_line.split()[0], 16)
if not (0x01137000 <= end <= 0x01137800):
    raise SystemExit(f"provisional link end outside 2 KiB evaluation window: 0x{end:08x}")
undefined = (out / "undefined.txt").read_text(encoding="utf-8").splitlines()
if undefined:
    raise SystemExit("provisional ELF has undefined symbols")

manifest = {
    "schema": "h1e-voice-energy-f11a-dispatch-provisional-v1",
    "status": "offline_source_and_link_proposal_NOT_COMPOSED_NOT_INSTALLABLE",
    "identity": {
        "installed_current_system": {"path": str(p393998.relative_to(repo)), "sha256": file_sha(p393998)},
        "prior_393997_system": {"path": str(p393997.relative_to(repo)), "sha256": file_sha(p393997)},
        "accepted_dispatch_elf": {"path": str(accepted_elf.relative_to(repo)), "sha256": file_sha(accepted_elf)},
        "accepted_dispatch_symbols_sha256": file_sha(accepted_symbols),
        "accepted_dispatch_system": {"path": str(accepted_sys.relative_to(repo)), "sha256": file_sha(accepted_sys)},
        "load_base": "0x01000000",
    },
    "accepted_abi": {
        "parse_signature": "int parse(uint8_t *frame, const uint8_t *body, uint32_t length)",
        "response_signature": "int response(uint8_t *frame)",
        "parse_head_pointer": "LE32(frame+0x14), command BE16 at head+2, declared length BE32 at head+8",
        "response_fields": {"command_le32": "frame+0x18", "output_ptr_le32": "frame+0x1c", "payload_capacity_le32": "frame+0x20", "head_ptr_le32": "frame+0x28", "payload_offset": 12},
        "dispatch_wrapper_call_targets_in_accepted_elf": {
            "parse": {"symbol": "console630_parse", "address": "0x01128d08", "size": 178},
            "response": {"symbol": "console630_response", "address": "0x01128bf4", "size": 276},
            "parser_hook_wrapper": {"symbol": "console630_parser_hook", "address": "0x01128e4c"},
            "response_hook_wrapper": {"symbol": "console630_response_hook", "address": "0x01128e94"},
        },
        "current_system_wrapper_spans": span_checks,
        "wrapper_spans_match_393997_and_393998": True,
        "dispatch_note": "The C shim calls the existing VAD-aware parser/response functions; those wrappers retain F11A v1 and route all non-F11A commands to the current console. It does not call raw console functions directly.",
        "new_shim_delegate_calls": delegation_checks,
        "raw_console_aliases_bypassing_vad_not_linked": ["0x0112b70c", "0x0112b81c"],
    },
    "f11a_v2": {
        "request": "exactly one body byte with value 2, declared length 1, F11A pending command, resolved head/context, and no fragment; common admission checks are reused via the existing VAD parser with a private synthetic V1 token, then only head[9] changes to 2",
        "saved_parse_state": "head[9]=2 only after the existing VAD parser accepts all common checks; V1 state 1 remains untouched",
        "response": "state 2 reads the 128-byte sidecar cache only and returns its fixed 32-byte V2 payload; it does not call the provider",
        "all_other_traffic": "delegates unchanged to the existing VAD-aware parser/response, including F11A v1, F117, and other console commands",
        "voice_source_freshness_semantics": "unknown; raw/status/counters only",
    },
    "required_lifecycle_recipe_not_applied": {
        "constructor_96_to_128": constructor_changes,
        "existing_delayed_publication_and_detach_before_free": "retain the accepted lifecycle behavior; only the two 96-byte immediate values above are proposed to change",
    },
    "external_call_proposal_not_applied": call_checks,
    "provisional_link": {
        "elf_path": str(elf.relative_to(repo)),
        "elf_bytes": elf.stat().st_size,
        "elf_sha256": file_sha(elf),
        "start": "0x01137000",
        "end_exclusive": f"0x{end:08x}",
        "window_end_exclusive": "0x01137800",
        "fits_2k_evaluation_window": True,
        "undefined_symbol_count": 0,
        "fully_resolved_ck802_relocations": True,
        "vma_reservation_accepted": False,
        "sys_or_container_composed": False,
    },
    "provider_object": {
        "path": str((provider / "build" / "vad_provider_raw_get.enabled.o").relative_to(repo)),
        "sha256": file_sha(provider / "build" / "vad_provider_raw_get.enabled.o"),
        "enabled_for_offline_static_link_only": True,
    },
    "host_dispatch_checks": (out / "f11a-dispatch-host-test.txt").read_text(encoding="utf-8").strip(),
    "limitations": [
        "This is a source/ELF proposal only. No SYS, container, target instruction execution, hardware, or install was performed.",
        "The 0x01137000 address is an evaluation coordinate, not a reserved firmware VMA.",
        "Compile-time admission assertions do not prove constructor, object lifetime, provider scheduling, or target memory ordering.",
        "The V2 selector is raw cache reporting only and makes no microphone, voice, or freshness claim.",
    ],
}
(out / "integration-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

source_names = [
    "h1e_voice_energy_cache.h", "h1e_voice_energy_cache.c",
    "h1e_voice_energy_loader128.h", "h1e_voice_energy_loader128.c",
    "h1e_voice_energy_poll_adapter.h", "h1e_voice_energy_poll_adapter.c",
    "h1e_voice_energy_reply_v2.h", "h1e_voice_energy_reply_v2.c",
    "h1e_voice_energy_f11a_reader.h", "h1e_voice_energy_f11a_reader.c",
    "h1e_voice_energy_f11a_dispatch.h", "h1e_voice_energy_f11a_dispatch.c",
    "integration-calls.S", "provisional-link-voice-energy-r5.ld",
    "build_f11a_dispatch_proposal.sh", "test_voice_energy_f11a_dispatch.c",
]
receipt = {
    "schema": "h1e-voice-energy-f11a-dispatch-provisional-receipt-v1",
    "status": manifest["status"],
    "manifest_sha256": file_sha(out / "integration-manifest.json"),
    "source_sha256": {name: file_sha(owned / name) for name in source_names},
    "external_aliases": {item["name"]: item["sha256_393997_and_393998"] for item in span_checks},
    "proposed_call_bytes": {item["kind"]: item["proposed_bytes_hex"] for item in call_checks},
    "constructor_128_instruction_bytes": {item["kind"]: item["proposed_128_instruction_bytes_hex"] for item in constructor_changes},
    "host_dispatch_checks": manifest["host_dispatch_checks"],
}
(out / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
PY

find "$out" -maxdepth 1 -type f ! -name output-sha256.txt -print0 | sort -z | xargs -0 sha256sum > "$out/output-sha256.txt"
