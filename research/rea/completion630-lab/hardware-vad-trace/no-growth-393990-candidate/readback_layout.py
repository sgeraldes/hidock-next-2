"""Verify the CK802 multi-section link against the exact 393990 baseline."""
import hashlib
import json
import struct
from pathlib import Path


LAB = Path(__file__).resolve().parent
TRACE = LAB.parent
REPO = LAB.parents[4]
OUT = LAB / "output"
VAD = TRACE / "native-f11a-393990-candidate" / "output"
CAPTURE = REPO / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
SYS = CAPTURE / "out-NOTINSTALL/container-compose3/system-decoded.bin"
CONSOLE = CAPTURE / "out-NOTINSTALL/run2/native"
ROUTER = REPO / "research/rea/hardening630-lab/fixed-router"
RESTORE4 = REPO / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
ELF_PATH = OUT / "vad-no-growth-393990-NOTINSTALL.elf"
LOAD_BASE = 0x01000000
SYSTEM_BYTES = 1_237_504


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_elf(path: Path) -> tuple[bytes, dict, dict]:
    data = path.read_bytes()
    assert data[:7] == b"\x7fELF\x01\x01\x01", "Requires little-endian ELF32"
    shoff = struct.unpack_from("<I", data, 32)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 46)
    assert shentsize == 40
    raw_sections = [struct.unpack_from("<10I", data, shoff + n * shentsize) for n in range(shnum)]
    names_sec = raw_sections[shstrndx]
    names = data[names_sec[4]:names_sec[4] + names_sec[5]]
    sections = {}
    for section in raw_sections:
        name = names[section[0]:].split(b"\0", 1)[0].decode()
        sections[name] = {
            "type": section[1], "flags": section[2], "address": section[3],
            "offset": section[4], "size": section[5], "link": section[6],
            "info": section[7], "alignment": section[8], "entry_size": section[9],
        }

    symbols = {}
    symsec = sections[".symtab"]
    strsec = raw_sections[symsec["link"]]
    strings = data[strsec[4]:strsec[4] + strsec[5]]
    entsize = symsec["entry_size"] or 16
    for at in range(symsec["offset"], symsec["offset"] + symsec["size"], entsize):
        name_off, value, size, info, other, shndx = struct.unpack_from("<IIIBBH", data, at)
        name = strings[name_off:].split(b"\0", 1)[0].decode()
        if name:
            symbols[name] = {"address": value, "size": size, "info": info, "section_index": shndx}
    return data, sections, symbols


def section_bytes(data: bytes, section: dict) -> bytes:
    return data[section["offset"]:section["offset"] + section["size"]]


def decode_bsr(raw: bytes, address: int) -> int:
    assert len(raw) == 4
    word = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    assert word >> 26 == 0x38, f"not a C-SKY bsr at {address:#x}: {word:#x}"
    displacement = word & 0x3FFFFFF
    if displacement & 0x2000000:
        displacement -= 0x4000000
    return address + displacement * 2


def range_from_sys(system: bytes, address: int, length: int) -> bytes:
    offset = address - LOAD_BASE
    assert offset >= 0 and offset + length <= len(system), (hex(address), length, len(system))
    return system[offset:offset + length]


def exported(name: str) -> bytes:
    return (OUT / name).read_bytes()


def main() -> None:
    pins = json.loads((OUT / "input-pins-before.json").read_text())
    assert (OUT / "input-pins-before.json").read_bytes() == (OUT / "input-pins-after.json").read_bytes()
    system = SYS.read_bytes()
    assert len(system) == SYSTEM_BYTES
    assert sha(system) == "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360"
    elf, sections, symbols = parse_elf(ELF_PATH)

    assert sections[".router_tail"]["address"] == 0x01128A40
    assert sections[".console_tail"]["address"] == 0x0112BE00
    assert sections[".router_tail"]["size"] <= 1472
    assert sections[".console_tail"]["size"] <= 512
    assert sections[".router_tail"]["size"] == len(exported("router-tail.bin"))
    assert sections[".console_tail"]["size"] == len(exported("console-tail.bin"))
    original_vad_text = (VAD / "module-vad-text.bin").read_bytes()
    assert sections[".router_tail"]["size"] + sections[".console_tail"]["size"] == len(original_vad_text)

    segments = []
    for name, artifact, reservation, expected_address in [
        (".router_tail", "router-tail.bin", "router_4k", 0x01128A40),
        (".console_tail", "console-tail.bin", "console_4k", 0x0112BE00),
    ]:
        sec = sections[name]
        raw = section_bytes(elf, sec)
        assert raw == exported(artifact)
        assert sec["address"] == expected_address
        source_offset = sec["address"] - LOAD_BASE
        assert source_offset + len(raw) <= SYSTEM_BYTES, (name, source_offset, len(raw), SYSTEM_BYTES)
        before = range_from_sys(system, sec["address"], len(raw))
        assert before
        preimage_all_zero = not any(before)
        expected_fill = 0xFF if name == ".router_tail" else 0x00
        assert before == bytes([expected_fill]) * len(before), (
            name, f"expected uniform fill {expected_fill:02x}", sha(before)
        )
        window_start = 0x01128A40 if name == ".router_tail" else 0x0112BE00
        window_end = 0x01129000 if name == ".router_tail" else 0x0112C000
        window_preimage = range_from_sys(system, window_start, window_end - window_start)
        assert window_preimage == bytes([expected_fill]) * len(window_preimage), (
            name, "full proposed window does not match declared fill", sha(window_preimage)
        )
        segments.append({
            "name": name,
            "address": f"0x{sec['address']:08x}",
            "length": len(raw),
            "end_exclusive": f"0x{sec['address'] + len(raw):08x}",
            "system_file_offset": source_offset,
            "elf_section": name,
            "elf_section_offset": 0,
            "elf_section_size": sec["size"],
            "elf_file_offset": sec["offset"],
            "bytes_hex": raw.hex(),
            "sha256": sha(raw),
            "baseline_preimage_sha256": sha(before),
            "baseline_preimage_hex": before.hex(),
            "baseline_preimage_bytes_hex": before.hex(),
            "preimage_fill": f"{expected_fill:02x}",
            "baseline_preimage_all_zero": preimage_all_zero,
            "exported_artifact": artifact,
            "exported_artifact_path": f"research/rea/completion630-lab/hardware-vad-trace/no-growth-393990-candidate/output/{artifact}",
            "exported_artifact_sha256": sha(exported(artifact)),
            "within_original_system": True,
            "proposed_reservation": reservation,
            "reservation_start": "0x01128000" if name == ".router_tail" else "0x0112b000",
            "reservation_end": "0x01129000" if name == ".router_tail" else "0x0112c000",
            "candidate_window_start": "0x01128a40" if name == ".router_tail" else "0x0112be00",
            "candidate_window_end": "0x01129000" if name == ".router_tail" else "0x0112c000",
            "candidate_window_length": len(window_preimage),
            "candidate_window_preimage_sha256": sha(window_preimage),
            "candidate_window_preimage_fill": f"{expected_fill:02x}",
            "candidate_window_preimage_all_zero": not any(window_preimage),
        })

    assert segments[0]["end_exclusive"] <= "0x01129000"
    assert int(segments[1]["end_exclusive"], 16) <= 0x0112C000

    # Bind both live modules to exact ELF, raw-module, and baseline bytes.
    router_elf, router_sections, _ = parse_elf(ROUTER / "router630.elf")
    router_sec = router_sections[".text"]
    router_bin = (ROUTER / "router630.bin").read_bytes()
    assert router_sec["address"] == 0x01128000 and router_sec["size"] == 2613
    assert section_bytes(router_elf, router_sec) == router_bin
    assert sha(router_elf) == "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a"
    assert sha(router_bin) == "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487"
    router_live = range_from_sys(system, router_sec["address"], router_sec["size"])
    assert router_live == router_bin

    console_elf, console_sections, console_symbols = parse_elf(CONSOLE / "native630.elf")
    console_sec = console_sections[".text"]
    console_bin = (CONSOLE / "native630.bin").read_bytes()
    assert console_sec["address"] == 0x0112B000 and console_sec["size"] == 3189
    assert section_bytes(console_elf, console_sec) == console_bin
    assert sha(console_elf) == "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee"
    assert sha(console_bin) == "9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2"
    console_live = range_from_sys(system, console_sec["address"], console_sec["size"])
    assert console_live == console_bin

    preserved_symbols = []
    for symbol, address in [("console630_parse", 0x0112B70C), ("console630_response", 0x0112B800)]:
        item = console_symbols[symbol]
        assert item["address"] == address and item["size"] > 0
        begin = address - console_sec["address"]
        code = section_bytes(console_elf, console_sec)[begin:begin + item["size"]]
        actual = range_from_sys(system, address, item["size"])
        assert code == actual
        preserved_symbols.append({
            "name": symbol,
            "address": f"0x{address:08x}",
            "size": item["size"],
            "sha256": sha(code),
            "baseline_sha256": sha(actual),
            "matches_current_console_elf": True,
            "containing_preserved_range": "current_console_live_module",
        })

    # Validate inherited linker assertions and the fixed router dependencies.
    router_ld = (ROUTER / "module.ld").read_text()
    deps = (ROUTER / "dependencies.ld").read_text()
    console_ld = (RESTORE4 / "module.ld").read_text()
    assert ".text 0x01128000" in router_ld and "SIZEOF(.text)<=4096" in router_ld
    assert "rules_configure = 0x0112a000" in deps
    assert ".text 0x0112b000" in console_ld and "SIZEOF(.text)<=4096" in console_ld
    assert ".upload_text 0x0112c000" in console_ld and ".restore_text 0x0112d000" in console_ld

    patch_specs = [
        (0x01020B62, 4, ".poll_hook", "native_poll_bridge", "h1e_vad_native_poll_bridge"),
        (0x01021054, 2, ".constructor_edits", "allocate_96", None),
        (0x0102105C, 2, ".constructor_edits", "retain_private_pointer", None),
        (0x0102106A, 2, ".constructor_edits", "private_failure_pointer", None),
        (0x01021070, 4, ".constructor_edits", "final_publication_decision", "late_publication_stub"),
        (0x0102109E, 2, ".constructor_edits", "zero_96", None),
        (0x010210A8, 2, ".constructor_edits", "retain_private_pointer_after_zero", None),
        (0x010210DE, 2, ".constructor_edits", "private_gpio_object", None),
        (0x0103907A, 4, ".response_hook", "f11a_response_dispatch", "console630_response_hook"),
        (0x0103A996, 4, ".parser_hook", "f11a_parser_dispatch", "console630_parser_hook"),
    ]
    old_manifest_path = VAD / "sparse-source-hunks-393990.json"
    old_manifest = json.loads(old_manifest_path.read_text())
    old_by_addr = {int(item["address"], 16): item for item in old_manifest["hunks"]}
    patches = []
    for address, width, sec_name, role, target_symbol in patch_specs:
        sec = sections[sec_name]
        relative = address - sec["address"]
        assert relative >= 0 and relative + width <= sec["size"]
        replacement = elf[sec["offset"] + relative:sec["offset"] + relative + width]
        before = range_from_sys(system, address, width)
        assert before.hex() == old_by_addr[address]["before_hex"]
        assert replacement != before
        item = {
            "address": f"0x{address:08x}",
            "width": width,
            "role": role,
            "before_hex": before.hex(),
            "replacement_hex": replacement.hex(),
            "source_elf_section": sec_name,
            "elf_section_offset": relative,
            "elf_file_offset": sec["offset"] + relative,
            "replacement_sha256": sha(replacement),
            "matches_393988_preimage": old_by_addr[address]["matches_393988_preimage"],
        }
        if target_symbol:
            target = decode_bsr(replacement, address)
            symbol_address = symbols[target_symbol]["address"]
            assert target == symbol_address, (role, hex(target), target_symbol, hex(symbol_address))
            item.update({
                "target_symbol": target_symbol,
                "target_address": f"0x{target:08x}",
                "decoded_bsr_target_from_raw_bytes": f"0x{target:08x}",
                "branch_readback_passed": True,
            })
        patches.append(item)
    assert len(patches) == 10
    assert sum(item["width"] for item in patches) == 28

    assert symbols["console630_parse_current"]["address"] == 0x0112B70C
    assert symbols["console630_response_current"]["address"] == 0x0112B800
    assert not (OUT / "undefined.txt").read_text().strip()

    payload = {
        "schema": "h1e-vad-no-growth-393990-layout-readback-v1",
        "status": "OFFLINE_CANDIDATE_NOTINSTALL",
        "baseline": {
            "path": str(SYS.relative_to(REPO)),
            "sha256": sha(system),
            "bytes": len(system),
            "load_base": f"0x{LOAD_BASE:08x}",
            "end_exclusive": f"0x{LOAD_BASE + len(system):08x}",
        },
        "elf_path": str(ELF_PATH.relative_to(REPO)),
        "elf_sha256": sha(elf),
        "symbols_path": str((OUT / "symbols.txt").relative_to(REPO)),
        "symbols_sha256": sha((OUT / "symbols.txt").read_bytes()),
        "map_path": str((OUT / "no-growth.map").relative_to(REPO)),
        "map_sha256": sha((OUT / "no-growth.map").read_bytes()),
        "linker_script_path": str((LAB / "no-growth.ld").relative_to(REPO)),
        "linker_script_sha256": sha((LAB / "no-growth.ld").read_bytes()),
        "source_pins_path": str((OUT / "input-pins-before.json").relative_to(REPO)),
        "source_pins_sha256": sha((OUT / "input-pins-before.json").read_bytes()),
        "proposed_reservations": {
            "router": {"start": "0x01128000", "bytes": 4096, "live_end_exclusive": "0x01128a35", "candidate_start": "0x01128a40", "candidate_max_bytes": 1472, "declared_by": str((ROUTER / "module.ld").relative_to(REPO))},
            "console": {"start": "0x0112b000", "bytes": 4096, "live_end_exclusive": "0x0112bc75", "candidate_start": "0x0112be00", "candidate_max_bytes": 512, "declared_by": str((RESTORE4 / "module.ld").relative_to(REPO)), "future_producer_observation": "Parent reports a separate active producer diagnostic at 3568 live bytes and 0x0112bdf0 end; artifact and ownership receipt were not supplied to this subtask, so this is an unpinned projection only."},
            "ownership_note": "These are proposed suballocations inside inherited declared reservations. This artifact does not record shared ownership acceptance or authorize application.",
        },
        "segments": segments,
        "preserved_ranges": [
            {"name": "fixed_router_live_text", "address": "0x01128000", "length": len(router_live), "sha256": sha(router_live), "expected_module_sha256": sha(router_bin), "expected_elf_sha256": sha(router_elf), "baseline_matches_live_module": True},
            {"name": "current_console_live_module", "address": "0x0112b000", "length": len(console_live), "sha256": sha(console_live), "expected_module_sha256": sha(console_bin), "expected_elf_sha256": sha(console_elf), "baseline_matches_live_module": True},
        ],
        "preserved_symbols": preserved_symbols,
        "patches": patches,
        "layout_checks": {
            "segments_within_original_system": all(item["within_original_system"] for item in segments),
            "segments_within_declared_reservation_bounds": True,
            "candidate_segments_do_not_overlap_live_modules": True,
            "candidate_segments_do_not_overlap_each_other": True,
            "baseline_candidate_segments_all_zero": all(item["baseline_preimage_all_zero"] for item in segments),
            "router_tail_baseline_is_erased_fill_ff": segments[0]["baseline_preimage_bytes_hex"] == "ff" * segments[0]["length"],
            "baseline_candidate_segments_match_declared_fill": all(
                item["baseline_preimage_bytes_hex"] == item["preimage_fill"] * item["length"]
                for item in segments
            ),
            "full_candidate_windows_match_declared_fill": all(
                item["candidate_window_preimage_fill"] == item["preimage_fill"]
                for item in segments
            ),
            "physical_span_inside_original_system": all(item["within_original_system"] for item in segments),
            "initial_zero_only_guard_failed_for_router_tail": not segments[0]["baseline_preimage_all_zero"],
            "candidate_sections_fit_existing_physical_bounds": True,
            "current_router_console_bytes_preserved": True,
            "parser_response_addresses_preserved": True,
            "patch_instruction_bytes": sum(item["width"] for item in patches),
            "undefined_symbols": 0,
            "data_bytes": 0,
            "bss_bytes": 0,
            "firmware_image_generated": False,
            "composed": False,
            "installed": False,
            "hardware_tested": False,
        },
        "layout": {
            "status": "proposed_offline_suballocation",
            "ownership_accepted": False,
            "reservation_accepted": False,
            "target_qualified": False,
            "install_authorized": False,
            "qualification_note": "The exact pinned preimages are uniformly 0xff in the router segment and 0x00 in the console segment. A zero-only guard initially flagged the router fill; the manifest records exact fill and does not infer free space or ownership from fill. Shared reservation acceptance and installation authority remain false.",
        },
    }
    target = OUT / "layout-readback.json"
    target.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({
        "status": payload["status"],
        "elf_sha256": payload["elf_sha256"],
        "segments": [{"name": s["name"], "address": s["address"], "length": s["length"], "sha256": s["sha256"]} for s in segments],
        "patch_count": len(patches),
        "instruction_bytes": sum(item["width"] for item in patches),
        "zero_preimage_all_segments": all(item["baseline_preimage_all_zero"] for item in segments),
        "declared_fill_preimages_passed": all(
            item["baseline_preimage_bytes_hex"] == item["preimage_fill"] * item["length"]
            for item in segments
        ),
        "system_bytes": len(system),
        "system_growth": 0,
        "layout_manifest": str(target),
    }))


if __name__ == "__main__":
    main()
