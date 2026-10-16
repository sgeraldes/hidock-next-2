"""Export a strict sparse source-hunk manifest for the current 393990 SYS.

This reads the pinned current SYS and the newly linked ELF. It never patches or
composes a firmware image.
"""
import hashlib
import json
import struct
from pathlib import Path

lab = Path(__file__).resolve().parent
vad_root = lab.parent
repo = lab.parents[4]
sys_path = repo / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic/out-NOTINSTALL/container-compose3/system-decoded.bin"
console_dir = repo / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic/out-NOTINSTALL/run2/native"
baseline_path = repo / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin"
manifest_path = vad_root / "native-ck802-candidate/sdk-profile/output/sparse-source-hunks.json"
elf_path = lab / "output/f11a-393990-ck802-sdk-NOTINSTALL.elf"
symbols_path = lab / "output/symbols.txt"
current = sys_path.read_bytes()
baseline = baseline_path.read_bytes()
elf = elf_path.read_bytes()
sha = lambda data: hashlib.sha256(data).hexdigest()

assert sha(current) == "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360"
assert sha(baseline) == "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f"
assert sha((console_dir / "native630.elf").read_bytes()) == "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee"
assert elf[:7] == b"\x7fELF\x01\x01\x01", "Requires little-endian ELF32"

section_offset = struct.unpack_from("<I", elf, 32)[0]
section_entry_size, section_count, section_names_index = struct.unpack_from("<HHH", elf, 46)
assert section_entry_size == 40
sections = [struct.unpack_from("<10I", elf, section_offset + i * section_entry_size) for i in range(section_count)]
name_section = sections[section_names_index]
section_names = elf[name_section[4]:name_section[4] + name_section[5]]
section_by_name = {
    section_names[section[0]:].split(b"\0", 1)[0].decode(): section
    for section in sections
}

symbol_addresses = {}
for line in symbols_path.read_text().splitlines():
    parts = line.split()
    if len(parts) >= 3:
        try:
            symbol_addresses[parts[-1]] = int(parts[0], 16)
        except ValueError:
            pass

expected_current = {
    "console630_parse_current": 0x0112B70C,
    "console630_response_current": 0x0112B800,
}
for symbol, address in expected_current.items():
    assert symbol_addresses.get(symbol) == address, (symbol, symbol_addresses.get(symbol), address)

old_manifest = json.loads(manifest_path.read_text())
old_by_address = {int(item["address"], 16): item for item in old_manifest["hunks"]}

spec = [
    (0x01020B62, 4, ".poll_hook", "native_poll_bridge", None, "h1e_vad_native_poll_bridge"),
    (0x01021054, 2, ".constructor_edits", "allocate_96", "6030", None),
    (0x0102105C, 2, ".constructor_edits", "retain_private_pointer", "c36d", None),
    (0x0102106A, 2, ".constructor_edits", "private_failure_pointer", "1f6c", None),
    (0x01021070, 4, ".constructor_edits", "final_publication_decision", None, "late_publication_stub"),
    (0x0102109E, 2, ".constructor_edits", "zero_96", "6032", None),
    (0x010210A8, 2, ".constructor_edits", "retain_private_pointer_after_zero", "df6d", None),
    (0x010210DE, 2, ".constructor_edits", "private_gpio_object", "df6c", None),
    (0x0103907A, 4, ".response_hook", "f11a_response_dispatch", None, "console630_response_hook"),
    (0x0103A996, 4, ".parser_hook", "f11a_parser_dispatch", None, "console630_parser_hook"),
]


def decode_bsr(raw: bytes, address: int) -> int:
    """Decode C-SKY 32-bit bsr from raw little-endian halfwords."""
    assert len(raw) == 4
    word = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    assert word >> 26 == 0x38, f"not a bsr at {address:#x}: {word:#x}"
    displacement = word & 0x3FFFFFF
    if displacement & 0x2000000:
        displacement -= 0x4000000
    return address + displacement * 2


hunks = []
old_preimage_status = []
for address, width, section_name, role, expected_after, target_symbol in sorted(spec):
    section = section_by_name[section_name]
    relative = address - section[3]
    assert 0 <= relative and relative + width <= section[5], (section_name, hex(address))
    after = elf[section[4] + relative:section[4] + relative + width]
    before = current[address - 0x01000000:address - 0x01000000 + width]
    baseline_before = baseline[address - 0x01000000:address - 0x01000000 + width]
    assert len(before) == len(after) == width and before != after, (role, before.hex(), after.hex())
    if expected_after is not None:
        assert after.hex() == expected_after, (role, after.hex(), expected_after)
    old = old_by_address[address]
    old_matches = baseline_before.hex() == old["before_hex"]
    assert old_matches, (role, baseline_before.hex(), old["before_hex"])
    current_matches_old = before.hex() == old["before_hex"]
    old_preimage_status.append({
        "address": f"{address:08x}",
        "old_preimage": old["before_hex"],
        "current_preimage": before.hex(),
        "matches_old": current_matches_old,
    })
    item = {
        "address": f"{address:08x}",
        "width": width,
        "role": role,
        "before_hex": before.hex(),
        "after_hex": after.hex(),
        "matches_393988_preimage": current_matches_old,
    }
    if target_symbol:
        target = decode_bsr(after, address)
        assert symbol_addresses.get(target_symbol) == target, (role, target_symbol, hex(target), symbol_addresses.get(target_symbol))
        item.update({
            "linked_target_symbol": target_symbol,
            "linked_target_address": f"{target:08x}",
            "decoded_bsr_target_from_raw_bytes": f"{target:08x}",
            "link_register_after_call": f"{address + 4:08x}",
        })
    hunks.append(item)

assert len(hunks) == 10 and sum(item["width"] for item in hunks) == 28
assert sum(item["matches_393988_preimage"] for item in hunks) == 8
assert all(int(a["address"], 16) + a["width"] <= int(b["address"], 16) for a, b in zip(hunks, hunks[1:]))
assert len(section_by_name[".constructor_edits"]) == 10
constructor_section = section_by_name[".constructor_edits"]
assert constructor_section[5] == 0x8C

manifest = {
    "schema": "h1e-vad-sparse-source-hunks-v2",
    "status": "conditional_source_hunks_only_not_composed_or_installable",
    "profile": "ck802-sdk-flags",
    "byte_order_note": "before_hex and after_hex are raw file bytes, little-endian per halfword; they are not objdump display words.",
    "current_system_sha256": sha(current),
    "current_system_bytes": len(current),
    "current_container_version": 393990,
    "current_console_elf_sha256": sha((console_dir / "native630.elf").read_bytes()),
    "current_console_symbols": {name: f"{address:08x}" for name, address in expected_current.items()},
    "baseline_393988_sha256": sha(baseline),
    "new_elf_sha256": sha(elf),
    "new_module_base": "0112f000",
    "firmware_image_generated": False,
    "composed": False,
    "applied": False,
    "installed": False,
    "target_qualified": False,
    "constructor_section_bytes": constructor_section[5],
    "constructor_instruction_bytes": 16,
    "excluded_constructor_padding_bytes": constructor_section[5] - 16,
    "total_instruction_bytes": 28,
    "old_393988_preimage_comparison": {
        "matches": 8,
        "mismatches": 2,
        "per_hunk": old_preimage_status,
        "mismatch_reason": "Current 393990 already routes parser/response sites through its vector-console hooks; this module's hook branches target new wrappers that forward non-F11A traffic to those current console functions."
    },
    "hunks": hunks,
    "capacity_note": "The hypothetical link address is not a declared reservation and this manifest does not establish SYS partition capacity or authorize image composition."
}
target = lab / "output/sparse-source-hunks-393990.json"
target.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({
    "manifest": str(target),
    "hunks": len(hunks),
    "instruction_bytes": 28,
    "excluded_constructor_padding_bytes": manifest["excluded_constructor_padding_bytes"],
    "current_base_sha256": manifest["current_system_sha256"],
    "image_generated": False,
}))
