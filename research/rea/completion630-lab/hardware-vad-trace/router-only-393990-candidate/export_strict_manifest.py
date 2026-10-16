"""Export strict source-hunk and router-tail readback for the offline link."""
import hashlib
import json
import struct
from pathlib import Path


LAB = Path(__file__).resolve().parent
TRACE = LAB.parent
REPO = LAB.parents[4]
OUT = LAB / "output"
CAPTURE = REPO / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
SYS_PATH = CAPTURE / "out-NOTINSTALL/container-compose3/system-decoded.bin"
CONSOLE = CAPTURE / "out-NOTINSTALL/run2/native"
BASELINE = REPO / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
ROUTER = REPO / "research/rea/hardening630-lab/fixed-router"
OLD_HUNKS = TRACE / "native-ck802-candidate/sdk-profile/output/sparse-source-hunks.json"

LOAD_BASE = 0x01000000
WINDOW_BASE = 0x01128A40
WINDOW_BYTES = 1472
ROUTER_RESERVATION_END = 0x01129000
CONSOLE_RESERVATION_START = 0x0112B000
CONSOLE_RESERVATION_BYTES = 4096
CONSOLE_RESERVATION_END = CONSOLE_RESERVATION_START + CONSOLE_RESERVATION_BYTES


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_elf(path: Path):
    data = path.read_bytes()
    assert data[:7] == b"\x7fELF\x01\x01\x01", "Requires little-endian ELF32"
    shoff = struct.unpack_from("<I", data, 32)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 46)
    assert shentsize == 40
    raw = [struct.unpack_from("<10I", data, shoff + n * shentsize) for n in range(shnum)]
    names_sec = raw[shstrndx]
    names = data[names_sec[4]:names_sec[4] + names_sec[5]]
    sections = {}
    for index, item in enumerate(raw):
        name = names[item[0]:].split(b"\0", 1)[0].decode()
        sections[name] = {
            "type": item[1], "flags": item[2], "address": item[3], "offset": item[4],
            "size": item[5], "link": item[6], "info": item[7], "alignment": item[8],
            "entry_size": item[9], "index": index,
        }
    symbols = {}
    symsec = sections.get(".symtab")
    if symsec:
        symraw = raw[symsec["index"]]
        strraw = raw[symraw[6]]
        strings = data[strraw[4]:strraw[4] + strraw[5]]
        entsize = symraw[9] or 16
        for offset in range(symraw[4], symraw[4] + symraw[5], entsize):
            name_off, value, size, info, other, shndx = struct.unpack_from("<IIIBBH", data, offset)
            name = strings[name_off:].split(b"\0", 1)[0].decode()
            if name:
                symbols[name] = {"address": value, "size": size, "info": info, "section_index": shndx}
    return data, sections, symbols


def section_bytes(elf: bytes, section: dict) -> bytes:
    return elf[section["offset"]:section["offset"] + section["size"]]


def range_from_system(system: bytes, address: int, length: int) -> bytes:
    offset = address - LOAD_BASE
    assert offset >= 0 and offset + length <= len(system), (hex(address), length, len(system))
    return system[offset:offset + length]


def parse_nm(path: Path) -> dict[str, int]:
    result = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 3:
            try:
                result[parts[-1]] = int(parts[0], 16)
            except ValueError:
                continue
    return result


def decode_bsr(raw: bytes, address: int) -> int:
    assert len(raw) == 4
    word = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    assert word >> 26 == 0x38, f"not a C-SKY bsr at {address:#x}: {word:#x}"
    displacement = word & 0x3FFFFFF
    if displacement & 0x2000000:
        displacement -= 0x4000000
    return address + displacement * 2


def main() -> None:
    elf_path = OUT / "vad-router-only-393990-NOTINSTALL.elf"
    module_path = OUT / "module-vad-router-tail.bin"
    symbols_path = OUT / "symbols.txt"
    elf, sections, elf_symbols = parse_elf(elf_path)
    symbols = parse_nm(symbols_path)
    current = SYS_PATH.read_bytes()
    baseline = (BASELINE / "system-decoded-NOTINSTALL.bin").read_bytes()
    sha_current = sha(current)
    assert sha_current == "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360"
    assert sha((CONSOLE / "native630.elf").read_bytes()) == "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee"
    assert sha(baseline) == "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f"

    module = sections[".router_tail"]
    assert module["address"] == WINDOW_BASE
    assert module["size"] <= WINDOW_BYTES
    assert WINDOW_BASE + module["size"] <= ROUTER_RESERVATION_END
    module_raw = section_bytes(elf, module)
    exported = module_path.read_bytes()
    assert exported == module_raw
    assert not any(name.startswith(".console_tail") for name in sections)
    data_bytes = sections.get(".data", {}).get("size", 0)
    bss_bytes = sections.get(".bss", {}).get("size", 0)
    assert data_bytes == 0 and bss_bytes == 0

    window = current[WINDOW_BASE - LOAD_BASE:WINDOW_BASE - LOAD_BASE + WINDOW_BYTES]
    assert len(window) == WINDOW_BYTES and set(window) == {0xFF}
    assert sha(window) == "d681b2309c3b48684ac24e27fafa6f215a294dc75bcbbf5fbfb4bbaacaed0e07"
    module_preimage = current[WINDOW_BASE - LOAD_BASE:WINDOW_BASE - LOAD_BASE + module["size"]]
    assert len(module_preimage) == module["size"] and set(module_preimage) == {0xFF}

    router_elf_path = ROUTER / "router630.elf"
    router_elf, router_sections, _ = parse_elf(router_elf_path)
    router_text = router_sections[".text"]
    router_bin = (ROUTER / "router630.bin").read_bytes()
    assert router_text["address"] == 0x01128000 and router_text["size"] == 2613
    assert section_bytes(router_elf, router_text) == router_bin
    router_live = range_from_system(current, router_text["address"], router_text["size"])
    assert router_live == router_bin
    router_live_end = router_text["address"] + router_text["size"]
    assert router_live_end == 0x01128A35 and router_live_end <= WINDOW_BASE
    router_reservation = range_from_system(current, 0x01128000, 4096)
    router_gap = range_from_system(current, router_live_end, WINDOW_BASE - router_live_end)
    router_window = range_from_system(current, WINDOW_BASE, WINDOW_BYTES)
    assert len(router_reservation) == 4096 and router_reservation == router_live + router_gap + router_window

    console_elf_path = CONSOLE / "native630.elf"
    console_elf, console_sections, console_symbols = parse_elf(console_elf_path)
    console_text = console_sections[".text"]
    console_bin = (CONSOLE / "native630.bin").read_bytes()
    assert console_text["address"] == CONSOLE_RESERVATION_START and console_text["size"] == 3189
    assert section_bytes(console_elf, console_text) == console_bin
    console_live = range_from_system(current, console_text["address"], console_text["size"])
    assert console_live == console_bin
    console_reserved = range_from_system(current, CONSOLE_RESERVATION_START, CONSOLE_RESERVATION_BYTES)
    assert len(console_reserved) == CONSOLE_RESERVATION_BYTES
    console_reserved_tail = console_reserved[len(console_bin):]
    assert len(console_reserved_tail) == CONSOLE_RESERVATION_BYTES - len(console_bin)

    expected_current = {
        "console630_parse_current": 0x0112B70C,
        "console630_response_current": 0x0112B800,
    }
    for name, address in expected_current.items():
        assert symbols.get(name) == address, (name, symbols.get(name), address)
    alias_symbols = {}
    preserved_symbols = []
    for alias, function, address in [
        ("console630_parse_current", "console630_parse", 0x0112B70C),
        ("console630_response_current", "console630_response", 0x0112B800),
    ]:
        symbol = console_symbols[function]
        assert symbol["address"] == address and symbol["size"] > 0
        relative = address - console_text["address"]
        code = section_bytes(console_elf, console_text)[relative:relative + symbol["size"]]
        live_code = range_from_system(current, address, symbol["size"])
        assert code == live_code
        alias_symbols[alias] = {
            "address": f"0x{address:08x}",
            "resolved_function": function,
            "function_size": symbol["size"],
            "console_elf_sha256": sha(console_elf),
            "function_sha256": sha(code),
        }
        preserved_symbols.append({
            "name": function,
            "address": f"0x{address:08x}",
            "size": symbol["size"],
            "code_sha256": sha(code),
            "sha256": sha(code),
            "baseline_sha256": sha(live_code),
            "matches_current_console_elf": True,
            "containing_preserved_range": "current_console_reserved_4k",
        })

    old = json.loads(OLD_HUNKS.read_text())
    old_by_address = {int(item["address"], 16): item for item in old["hunks"]}
    specs = [
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
    hunks = []
    old_preimages = []
    for address, width, section_name, role, expected_after, target_symbol in sorted(specs):
        section = sections[section_name]
        relative = address - section["address"]
        assert 0 <= relative and relative + width <= section["size"], (section_name, hex(address))
        after = elf[section["offset"] + relative:section["offset"] + relative + width]
        before = current[address - LOAD_BASE:address - LOAD_BASE + width]
        baseline_before = baseline[address - LOAD_BASE:address - LOAD_BASE + width]
        assert len(before) == len(after) == width and before != after, (role, before.hex(), after.hex())
        if expected_after is not None:
            assert after.hex() == expected_after, (role, after.hex(), expected_after)
        old_before = old_by_address[address]["before_hex"]
        assert baseline_before.hex() == old_before, (role, baseline_before.hex(), old_before)
        matches_old = before.hex() == old_before
        old_preimages.append({
            "address": f"{address:08x}", "old_preimage": old_before,
            "current_preimage": before.hex(), "matches_old": matches_old,
        })
        item = {
            "address": f"{address:08x}", "width": width, "role": role,
            "before_hex": before.hex(), "after_hex": after.hex(),
            "matches_393988_preimage": matches_old,
        }
        if target_symbol:
            target = decode_bsr(after, address)
            assert symbols.get(target_symbol) == target, (role, target_symbol, hex(target), symbols.get(target_symbol))
            item.update({
                "linked_target_symbol": target_symbol,
                "linked_target_address": f"{target:08x}",
                "decoded_bsr_target_from_raw_bytes": f"{target:08x}",
                "link_register_after_call": f"{address + 4:08x}",
            })
        hunks.append(item)

    constructor = sections[".constructor_edits"]
    assert constructor["address"] == 0x01021054 and constructor["size"] == 0x8C
    assert len(hunks) == 10 and sum(item["width"] for item in hunks) == 28
    assert sum(item["matches_393988_preimage"] for item in hunks) == 8
    assert all(int(a["address"], 16) + a["width"] <= int(b["address"], 16) for a, b in zip(hunks, hunks[1:]))
    roots = [
        "console630_parser_hook", "console630_response_hook", "h1e_vad_native_poll_bridge",
        "late_publication_stub", "vadt_f11a_parse", "vadt_f11a_response",
        "vadt_init", "vadt_poll",
    ]
    linked_roots = {name: f"{symbols[name]:08x}" for name in roots if name in symbols}
    assert all(name in linked_roots for name in roots[:4]), linked_roots

    patches = []
    for address, width, section_name, role, expected_after, target_symbol in sorted(specs):
        section = sections[section_name]
        relative = address - section["address"]
        replacement = elf[section["offset"] + relative:section["offset"] + relative + width]
        hunk = next(item for item in hunks if int(item["address"], 16) == address)
        patch = {
            "address": f"0x{address:08x}",
            "width": width,
            "role": role,
            "before_hex": hunk["before_hex"],
            "replacement_hex": replacement.hex(),
            "source_elf_section": section_name,
            "elf_section_offset": relative,
            "elf_file_offset": section["offset"] + relative,
            "replacement_sha256": sha(replacement),
            "matches_393988_preimage": hunk["matches_393988_preimage"],
        }
        if target_symbol:
            target = decode_bsr(replacement, address)
            assert symbols[target_symbol] == target
            patch.update({
                "target_symbol": target_symbol,
                "target_address": f"0x{target:08x}",
                "decoded_bsr_target_from_raw_bytes": f"0x{target:08x}",
                "branch_readback_passed": True,
            })
        patches.append(patch)

    assert len(patches) == 10 and sum(item["width"] for item in patches) == 28
    router_end = WINDOW_BASE + module["size"]
    write_ranges = [
        {"name": ".router_tail", "start": WINDOW_BASE, "end_exclusive": router_end},
        {"name": ".constructor_edits", "start": sections[".constructor_edits"]["address"], "end_exclusive": sections[".constructor_edits"]["address"] + sections[".constructor_edits"]["size"]},
        {"name": ".poll_hook", "start": sections[".poll_hook"]["address"], "end_exclusive": sections[".poll_hook"]["address"] + sections[".poll_hook"]["size"]},
        {"name": ".parser_hook", "start": sections[".parser_hook"]["address"], "end_exclusive": sections[".parser_hook"]["address"] + sections[".parser_hook"]["size"]},
        {"name": ".response_hook", "start": sections[".response_hook"]["address"], "end_exclusive": sections[".response_hook"]["address"] + sections[".response_hook"]["size"]},
    ]
    console_write_disjoint = all(
        item["end_exclusive"] <= CONSOLE_RESERVATION_START or item["start"] >= CONSOLE_RESERVATION_END
        for item in write_ranges
    )
    assert console_write_disjoint, write_ranges
    assert all(
        int(item["address"], 16) + item["width"] <= CONSOLE_RESERVATION_START
        or int(item["address"], 16) >= CONSOLE_RESERVATION_END
        for item in patches
    )

    manifest = {
        "schema": "h1e-vad-router-only-393990-source-link-v1",
        "status": "offline_candidate_not_composed_not_installed",
        "compiler_profile": "ck802-sdk-flags-plus-function-sections-data-sections-lto-gc-sections",
        "profile_deviation": ["-ffunction-sections", "-fdata-sections", "-flto", "linker --gc-sections via GCC plugin"],
        "current_system_sha256": sha_current,
        "current_system_bytes": len(current),
        "current_system_load_base": "0x01000000",
        "current_console_elf_sha256": sha((CONSOLE / "native630.elf").read_bytes()),
        "current_console_symbols": {name: f"{address:08x}" for name, address in expected_current.items()},
        "fixed_router_elf_sha256": "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a",
        "fixed_router_bin_sha256": "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487",
        "elf_path": "research/rea/completion630-lab/hardware-vad-trace/router-only-393990-candidate/output/vad-router-only-393990-NOTINSTALL.elf",
        "elf_sha256": sha(elf),
        "module_section": {
            "name": ".router_tail", "address": f"0x{module['address']:08x}",
            "bytes": module["size"], "end_exclusive": f"0x{WINDOW_BASE + module['size']:08x}",
            "capacity_bytes": WINDOW_BYTES, "tail_bytes": WINDOW_BYTES - module["size"],
            "sha256": sha(module_raw), "preimage_sha256": sha(module_preimage),
            "preimage_fill": "ff", "within_system": WINDOW_BASE + module["size"] <= LOAD_BASE + len(current),
        },
        "router_candidate_window": {
            "start": "0x01128a40", "end_exclusive": "0x01129000", "bytes": WINDOW_BYTES,
            "preimage_sha256": sha(window), "preimage_fill": "ff",
            "ownership_accepted": False, "reservation_accepted": False,
        },
        "console_tail_used": False,
        "data_bytes": data_bytes,
        "bss_bytes": bss_bytes,
        "reachable_native_roots": linked_roots,
        "constructor_section_bytes": constructor["size"],
        "constructor_instruction_bytes": 16,
        "excluded_constructor_padding_bytes": constructor["size"] - 16,
        "total_instruction_bytes": 28,
        "old_393988_preimage_comparison": {
            "matches": sum(item["matches_393988_preimage"] for item in hunks),
            "mismatches": sum(not item["matches_393988_preimage"] for item in hunks),
            "per_hunk": old_preimages,
            "mismatch_reason": "Current 393990 already routes parser and response sites through its vector-console hooks.",
        },
        "hunks": hunks,
        "firmware_image_generated": False,
        "composed": False,
        "applied": False,
        "installed": False,
        "hardware_tested": False,
        "target_qualified": False,
        "qualification": "Offline source-link and exact preimage readback only; not a runtime or hardware VAD result.",
    }
    target = OUT / "sparse-source-hunks-393990.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")

    export = {
        "status": "linked_router_tail_section_export_only",
        "elf_sha256": sha(elf),
        "section": ".router_tail",
        "section_address": f"{module['address']:08x}",
        "module_path": str(module_path),
        "module_bytes": len(exported),
        "module_sha256": sha(exported),
        "console_tail_used": False,
        "firmware_image_generated": False,
        "composed": False,
        "installed": False,
    }
    (OUT / "module-export-readback.json").write_text(json.dumps(export, indent=2) + "\n")
    pins_before_path = OUT / "input-pins-before.json"
    pins_after_path = OUT / "input-pins-after.json"
    pins_before_raw = pins_before_path.read_bytes()
    pins_after_raw = pins_after_path.read_bytes()
    assert pins_before_raw == pins_after_raw
    pins = json.loads(pins_before_raw)

    segment = {
        "name": ".router_tail",
        "address": f"0x{module['address']:08x}",
        "length": module["size"],
        "end_exclusive": f"0x{router_end:08x}",
        "system_file_offset": module["address"] - LOAD_BASE,
        "elf_section": ".router_tail",
        "elf_section_offset": 0,
        "elf_section_size": module["size"],
        "elf_file_offset": module["offset"],
        "bytes_hex": module_raw.hex(),
        "sha256": sha(module_raw),
        "baseline_preimage_sha256": sha(module_preimage),
        "baseline_preimage_hex": module_preimage.hex(),
        "baseline_preimage_bytes_hex": module_preimage.hex(),
        "preimage_fill": "ff",
        "baseline_preimage_all_zero": False,
        "exported_artifact": module_path.name,
        "exported_artifact_path": str(module_path.relative_to(REPO)),
        "exported_artifact_sha256": sha(exported),
        "within_original_system": True,
        "proposed_reservation": "router_4k",
        "reservation_start": "0x01128000",
        "reservation_end": "0x01129000",
        "candidate_window_start": "0x01128a40",
        "candidate_window_end": "0x01129000",
        "candidate_window_length": WINDOW_BYTES,
        "candidate_window_preimage_sha256": sha(router_window),
        "candidate_window_preimage_fill": "ff",
        "candidate_window_preimage_all_zero": False,
    }
    console_tail_start = CONSOLE_RESERVATION_START + len(console_bin)
    preserved_ranges = [
        {
            "name": "fixed_router_live_text", "address": "0x01128000", "length": len(router_live),
            "sha256": sha(router_live), "expected_module_sha256": sha(router_bin),
            "expected_elf_sha256": sha(router_elf), "baseline_matches_live_module": True,
        },
        {
            "name": "current_console_live_module", "address": f"0x{CONSOLE_RESERVATION_START:08x}",
            "length": len(console_live), "sha256": sha(console_live),
            "expected_module_sha256": sha(console_bin), "expected_elf_sha256": sha(console_elf),
            "baseline_matches_live_module": True, "baseline_matches_current_sys": True,
        },
        {
            "name": "current_console_reserved_4k", "address": f"0x{CONSOLE_RESERVATION_START:08x}",
            "length": CONSOLE_RESERVATION_BYTES, "sha256": sha(console_reserved),
            "baseline_sha256": sha(console_reserved), "baseline_matches_current_sys": True,
            "candidate_write_set_disjoint": console_write_disjoint,
            "preimage_hex": console_reserved.hex(),
            "preimage_fill_note": "Preserves the exact pinned 4096-byte current-system range, including live console code and reserved tail.",
            "post_composition_sha256": None, "post_composition_verified": False,
            "includes_live_bytes": len(console_bin), "remaining_reserved_bytes": len(console_reserved_tail),
            "remaining_reserved_start": f"0x{console_tail_start:08x}",
            "remaining_reserved_sha256": sha(console_reserved_tail),
            "source_baseline_path": str(SYS_PATH.relative_to(REPO)),
        },
    ]

    undefined = (OUT / "undefined.txt").read_text().splitlines()
    assert not undefined
    readelf_attributes = (OUT / "sections.txt").read_text()
    assert 'Tag_CSKY_CPU_NAME:\t\t"ck802"' in readelf_attributes
    assert "Tag_CSKY_ISA_FLAGS:\t\t10246 (0x2806)" in readelf_attributes

    layout = {
        "schema": "h1e-vad-router-only-393990-layout-readback-v1",
        "status": "OFFLINE_CANDIDATE_NOTINSTALL",
        "baseline": {
            "path": str(SYS_PATH.relative_to(REPO)), "sha256": sha(current),
            "bytes": len(current), "load_base": f"0x{LOAD_BASE:08x}",
            "end_exclusive": f"0x{LOAD_BASE + len(current):08x}",
        },
        "elf_path": str(elf_path.relative_to(REPO)),
        "elf_sha256": sha(elf),
        "symbols_path": str((OUT / "symbols.txt").relative_to(REPO)),
        "symbols_sha256": sha((OUT / "symbols.txt").read_bytes()),
        "map_path": str((OUT / "router-only.map").relative_to(REPO)),
        "map_sha256": sha((OUT / "router-only.map").read_bytes()),
        "linker_script_path": str((LAB / "router-only.ld").relative_to(REPO)),
        "linker_script_sha256": sha((LAB / "router-only.ld").read_bytes()),
        "source_pins_path": str(pins_before_path.relative_to(REPO)),
        "source_pins_sha256": sha(pins_before_raw),
        "source_pins_after_path": str(pins_after_path.relative_to(REPO)),
        "source_pins_after_sha256": sha(pins_after_raw),
        "pins": {
            "current_system_sha256": sha(current),
            "current_console_elf_sha256": sha(console_elf),
            "current_console_bin_sha256": sha(console_bin),
            "fixed_router_elf_sha256": sha(router_elf),
            "fixed_router_bin_sha256": sha(router_bin),
            "input_pins_before_after_identical": True,
            "accepted_source_pin_count": pins["accepted_source_pin_count"],
            "accepted_source_pins_match": True,
            "input_pin_record_sha256": sha(pins_before_raw),
        },
        "source_byte_equivalence": {
            "accepted_source_pin_count": pins["accepted_source_pin_count"],
            "accepted_source_pins_match": True,
            "before_after_capture_identical": True,
            "current_system_exact_sha256": sha(current),
            "new_dispatcher_and_assembly_inputs_in_additional_pins": True,
            "compiler_sources_changed": False,
        },
        "build_profile": {
            "toolchain": "T-HEAD C-SKY Tools V3.10.29 Minilibc abiv2 B20210423; GCC 6.3.0",
            "target": "csky-elfabiv2",
            "c_flags_sdk": ["-std=c99", "-mcpu=ck802", "-Os", "-fshort-enums", "-fsigned-char", "-fno-common", "-fno-delete-null-pointer-checks", "-Wall", "-Wextra", "-Werror"],
            "added_c_flags": ["-ffunction-sections", "-fdata-sections", "-flto"],
            "link_flags": ["-fuse-linker-plugin", "-nostdlib", "--gc-sections"],
            "assembly_flags": ["-mcpu=ck802"],
            "profile_deviation": True,
            "elf_cpu": "ck802",
            "elf_isa_flags": "0x2806",
        },
        "proposed_reservations": {
            "router": {
                "start": "0x01128000", "bytes": 4096, "live_end_exclusive": "0x01128a35",
                "candidate_start": "0x01128a40", "candidate_max_bytes": WINDOW_BYTES,
                "candidate_end_exclusive": "0x01129000",
                "declared_by": "research/rea/hardening630-lab/fixed-router/module.ld",
                "ownership_accepted": False, "reservation_accepted": False,
            },
            "console_preservation_only": {
                "start": f"0x{CONSOLE_RESERVATION_START:08x}", "bytes": CONSOLE_RESERVATION_BYTES,
                "end_exclusive": f"0x{CONSOLE_RESERVATION_END:08x}",
                "candidate_allocation_bytes": 0,
                "declared_by": "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/module.ld",
            },
            "ownership_note": "The router tail remains a proposed suballocation; exact fill does not establish ownership or acceptance.",
        },
        "segments": [segment],
        "preserved_ranges": preserved_ranges,
        "preserved_symbols": preserved_symbols,
        "aliases": alias_symbols,
        "roots": {
            "entry": "console630_parser_hook",
            "native_patch_roots": {
                "parser": {"section": ".patch_console_parser", "symbol": "console630_parser_hook", "address": linked_roots["console630_parser_hook"]},
                "response": {"section": ".patch_console_response", "symbol": "console630_response_hook", "address": linked_roots["console630_response_hook"]},
                "poll": {"section": ".patch_vad_poll", "symbol": "h1e_vad_native_poll_bridge", "address": linked_roots["h1e_vad_native_poll_bridge"]},
                "constructor": {"section": ".edits", "symbol": "late_publication_stub", "address": linked_roots["late_publication_stub"]},
            },
            "linker_kept_sections": [".edits", ".patch_vad_poll", ".patch_console_parser", ".patch_console_response", ".stub"],
        },
        "elf_sections": {
            name: {
                "address": f"0x{sections[name]['address']:08x}",
                "size": sections[name]["size"],
                "sha256": sha(section_bytes(elf, sections[name])),
            }
            for name in [".router_tail", ".constructor_edits", ".poll_hook", ".parser_hook", ".response_hook"]
        } | {
            ".data": {"address": None, "size": data_bytes, "sha256": None},
            ".bss": {"address": None, "size": bss_bytes, "sha256": None},
            ".console_tail": {"present": False, "size": 0},
        },
        "patches": patches,
        "layout_checks": {
            "segments_within_original_system": True,
            "segments_within_declared_reservation_bounds": router_end <= ROUTER_RESERVATION_END,
            "candidate_segments_do_not_overlap_live_router_text": router_live_end <= WINDOW_BASE,
            "candidate_segments_do_not_overlap_console_reserved_4k": router_end <= CONSOLE_RESERVATION_START,
            "baseline_router_candidate_preimage_is_exact_ff": module_preimage == b"\xff" * module["size"],
            "full_router_candidate_window_is_exact_ff": router_window == b"\xff" * WINDOW_BYTES,
            "current_router_live_text_preserved": router_live == router_bin,
            "entire_console_4096_baseline_pinned": len(console_reserved) == CONSOLE_RESERVATION_BYTES,
            "entire_console_4096_candidate_write_set_disjoint": console_write_disjoint,
            "entire_console_4096_post_composition_verified": False,
            "parser_response_aliases_match_current_console": all(item["matches_current_console_elf"] for item in preserved_symbols),
            "all_native_patch_roots_retained": all(name in linked_roots for name in roots[:4]),
            "all_branch_patch_targets_decoded": all(item.get("branch_readback_passed", False) for item in patches if "target_symbol" in item),
            "patch_instruction_bytes": sum(item["width"] for item in patches),
            "undefined_symbols": len(undefined),
            "data_bytes": data_bytes,
            "bss_bytes": bss_bytes,
            "firmware_image_generated": False,
            "composed": False,
            "installed": False,
            "hardware_tested": False,
        },
        "layout": {
            "status": "proposed_offline_router_tail_suballocation",
            "ownership_accepted": False,
            "reservation_accepted": False,
            "target_qualified": False,
            "install_authorized": False,
            "qualification_note": "The exact router preimage is uniformly 0xff. This does not prove ownership. The full 4096-byte console baseline is pinned and disjoint from the candidate write set; no post-composition image exists in this task.",
        },
        "patches_summary": {"count": len(patches), "instruction_bytes": sum(item["width"] for item in patches)},
        "console_write_ranges": write_ranges,
        "console_tail_used": False,
        "undefined_symbols_list": undefined,
        "firmware_image_generated": False,
        "composed": False,
        "installed": False,
        "hardware_tested": False,
    }
    (OUT / "layout-readback.json").write_text(json.dumps(layout, indent=2) + "\n")
    summary = {
        "status": layout["status"],
        "elf_sha256": layout["elf_sha256"],
        "segments": [{"name": s["name"], "address": s["address"], "length": s["length"], "sha256": s["sha256"]} for s in [segment]],
        "patch_count": len(patches),
        "instruction_bytes": sum(item["width"] for item in patches),
        "router_tail_bytes": module["size"],
        "router_tail_budget_bytes": WINDOW_BYTES,
        "console_reserved_4k_sha256": sha(console_reserved),
        "console_4096_candidate_writes_disjoint": console_write_disjoint,
        "ownership_accepted": False,
        "reservation_accepted": False,
        "system_growth": 0,
        "firmware_image_generated": False,
        "installed": False,
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
