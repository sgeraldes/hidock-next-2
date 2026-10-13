"""Extract instruction hunks from the conditional ELF; never patches firmware."""
import hashlib
import json
import struct
from pathlib import Path

lab = Path(__file__).resolve().parent
repo = lab.parent.parents[3]
frozen_path = repo / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin"
elf_path = lab / "output/conditional-source-NOTINSTALL.elf"
frozen = frozen_path.read_bytes()
elf = elf_path.read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(frozen) == "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f"
assert elf[:7] == b"\x7fELF\x01\x01\x01", "Requires little-endian ELF32"
offset = struct.unpack_from("<I", elf, 32)[0]
entry_size, count, names_index = struct.unpack_from("<HHH", elf, 46)
assert entry_size == 40
sections = [struct.unpack_from("<10I", elf, offset + i * entry_size) for i in range(count)]
names_section = sections[names_index]
names = elf[names_section[4]:names_section[4] + names_section[5]]
by_name = {names[s[0]:].split(b"\0", 1)[0].decode(): s for s in sections}
spec = [
    (0x01021054, 2, ".constructor_edits", "allocate_96", "6030"),
    (0x0102105c, 2, ".constructor_edits", "retain_private_pointer", "c36d"),
    (0x0102106a, 2, ".constructor_edits", "private_failure_pointer", "1f6c"),
    (0x01021070, 4, ".constructor_edits", "final_publication_decision", None),
    (0x0102109e, 2, ".constructor_edits", "zero_96", "6032"),
    (0x010210a8, 2, ".constructor_edits", "retain_private_pointer_after_zero", "df6d"),
    (0x010210de, 2, ".constructor_edits", "private_gpio_object", "df6c"),
    (0x01020b62, 4, ".poll_hook", "existing_native_getter_bridge", None),
    (0x0103a996, 4, ".parser_hook", "native_parser_dispatch", None),
    (0x0103907a, 4, ".response_hook", "native_response_dispatch", None),
]
symbols = {parts[2]: int(parts[0], 16) for line in (lab / "output/symbols.txt").read_text().splitlines() if len(parts := line.split()) == 3}
targets = {
    "final_publication_decision": "late_publication_stub",
    "existing_native_getter_bridge": "h1e_vad_native_poll_bridge",
    "native_parser_dispatch": "console630_parser_hook",
    "native_response_dispatch": "console630_response_hook",
}
hunks = []
for address, width, section_name, role, expected in sorted(spec):
    section = by_name[section_name]
    relative = address - section[3]
    assert 0 <= relative and relative + width <= section[5]
    after = elf[section[4] + relative:section[4] + relative + width]
    before = frozen[address - 0x01000000:address - 0x01000000 + width]
    assert len(before) == len(after) == width and before != after
    if expected is not None:
        assert after.hex() == expected, role
    hunk = {"address": f"{address:08x}", "width": width, "role": role, "before_hex": before.hex(), "after_hex": after.hex()}
    if role in targets:
        hunk["linked_target_symbol"] = targets[role]
        hunk["linked_target_address"] = f"{symbols[targets[role]]:08x}"
    hunks.append(hunk)
assert len(hunks) == 10 and sum(h["width"] for h in hunks) == 28
assert all(int(a["address"], 16) + a["width"] <= int(b["address"], 16) for a, b in zip(hunks, hunks[1:]))
manifest = {
    "status": "sparse_source_hunks_only_not_installable",
    "source_sha256": sha(frozen), "elf_sha256": sha(elf),
    "firmware_image_generated": False, "applied": False,
    "constructor_section_bytes": by_name[".constructor_edits"][5],
    "constructor_instruction_bytes": 16,
    "excluded_constructor_padding_bytes": by_name[".constructor_edits"][5] - 16,
    "total_instruction_bytes": 28, "hunks": hunks,
    "remaining": "Module placement/capacity, release prerequisites and authorized target qualification; no firmware apply path enabled.",
}
target = lab / "output/sparse-source-hunks.json"
target.write_text(json.dumps(manifest, indent=2) + "\n")
assert frozen_path.read_bytes() == frozen and elf_path.read_bytes() == elf
print(json.dumps({"manifest": str(target), "hunks": len(hunks), "instruction_bytes": 28, "excluded_constructor_padding_bytes": manifest["excluded_constructor_padding_bytes"], "applied": False}))
