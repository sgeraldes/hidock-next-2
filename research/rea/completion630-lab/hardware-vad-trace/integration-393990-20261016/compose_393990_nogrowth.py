#!/usr/bin/env python3
"""Compose a bounded, no-growth H1E 393990 VAD image from pinned ELF ranges.

The accepted layout manifest is the sole placement contract. Every inserted
segment and changed instruction must be backed by exact ELF bytes, an approved
manifest range, and a pinned zero/current preimage in the selected 393990 SYS.
The candidate must retain the exact SYS length and must invert byte-for-byte to
the pinned baseline. The packer then replaces only encoded zephyr plus its XML
size/CRC fields and ACTTEST0 checksums. All outputs are offline NOTINSTALL.

No install, device, app, network, or hardware operation is performed.
"""
import sys
sys.dont_write_bytecode = True

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAD = HERE.parent
COMPLETION = HERE.parents[1]
REA = HERE.parents[2]
REPO = HERE.parents[4]
TRACE = HERE.parent

BASE_VA = 0x01000000
SEED = 0x08000050
VERSION_CODE = 393990
VERSION_NAME = "6.3.6_vectors001"
BOARD = "ats2835p_evb"
SYSTEM_HEADER_BYTES = 48

CAPTURE = COMPLETION / "firmware/capture-vector-selected-diagnostic"
BASE_DIR = CAPTURE / "out-NOTINSTALL/container-compose3"
BASE_SYSTEM = BASE_DIR / "system-decoded.bin"
BASE_CONTAINER = BASE_DIR / "H1E-6.3.6_vectors001-EXPERIMENTAL-NOT-INSTALL.bin"
BASE_CONSOLE_ELF = CAPTURE / "out-NOTINSTALL/run2/native/native630.elf"
BASE_CONSOLE_BIN = CAPTURE / "out-NOTINSTALL/run2/native/native630.bin"
BASE_ROUTER_DIR = REPO / "research/rea/hardening630-lab/fixed-router"
BASE_ROUTER_ELF = BASE_ROUTER_DIR / "router630.elf"
BASE_ROUTER_BIN = BASE_ROUTER_DIR / "router630.bin"
BASE_COMPOSER = CAPTURE / "compose_container.py"
BASE_VERIFIER = CAPTURE / "verify_container.py"

SDK = REA / "references/build_atf_image.py"
DECODER = REA / "decode_randomizer.py"
PARSER = REA / "extract_acttest.py"
OBJDUMP = Path("/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf-objdump")
INTEGRATION_BUILDER = TRACE / "firmware-integration/build_candidate.py"
CONTAINER_PACKER = TRACE / "firmware-container/package_vad_container.py"

BASE_PINS = {
    "base_container": (BASE_CONTAINER, "d0cd083ff19d56325dca12ea7785c4deb270cf2ef68fa6b7af1c64b0baa651a0"),
    "base_system": (BASE_SYSTEM, "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360"),
    "base_console_elf": (BASE_CONSOLE_ELF, "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee"),
    "base_console_bin": (BASE_CONSOLE_BIN, "9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2"),
    "base_router_elf": (BASE_ROUTER_ELF, "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a"),
    "base_router_bin": (BASE_ROUTER_BIN, "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487"),
    "integration_builder_reference": (INTEGRATION_BUILDER, "de45afc0567ee03a638fcf0d5ea9a2c9767f9d7ce6f27786bcbe77608c8c2851"),
    "container_packer_reference": (CONTAINER_PACKER, "2477a315db72eee36086089686b280da078655c525d7ecd330a09ef1fa436918"),
    "base_composer": (BASE_COMPOSER, "b715a3d68cadb49d64758205c79db696296d81e88d9d01c9a20357a6d4c9abcc"),
    "base_verifier": (BASE_VERIFIER, "e95a5f24e8e17e04541af9a83da41cd548f63c5cf1aa045c6a3724aa5198898b"),
    "sdk": (SDK, "30b5d37f67bb57af44d02da829429c59bb734d5c7c0acc1a1ce5f15029401c17"),
    "decoder": (DECODER, "3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5"),
    "parser": (PARSER, "8adf114c2ee531f12778b346482c344717659a130892515258505781efccc592"),
}
OBJDUMP_SHA256 = "e6aad5acbaf952d53ed470878b95acfcffeca7c4e001fe7bbf1c0dce4fd07cdd"

# Exact required patch set for this H1E 393990 composition. New bytes always
# come from the actual accepted ELF source section recorded in its manifest.
PATCHES = {
    0x01020B62: (4, "native_poll_bridge", "h1e_vad_native_poll_bridge"),
    0x01021054: (2, "allocate_96", None),
    0x0102105C: (2, "retain_private_pointer", None),
    0x0102106A: (2, "private_failure_pointer", None),
    0x01021070: (4, "final_publication_decision", "late_publication_stub"),
    0x0102109E: (2, "zero_96", None),
    0x010210A8: (2, "retain_private_pointer_after_zero", None),
    0x010210DE: (2, "private_gpio_object", None),
    0x0103907A: (4, "f11a_response_dispatch", "console630_response_hook"),
    0x0103A996: (4, "f11a_parser_dispatch", "console630_parser_hook"),
}
PREIMAGES = {
    0x01020B62: "ffe303f8", 0x01021054: "4030", 0x0102105C: "00b5",
    0x0102106A: "0095", 0x01021070: "403ce30f", 0x0102109E: "4032",
    0x010210A8: "e095", 0x010210DE: "6095", 0x0103907A: "07e01395",
    0x0103A996: "07e06188",
}
CURRENT_HOOK_TARGETS = {0x0103907A: 0x0112BAA0, 0x0103A996: 0x0112BA58}
CURRENT_CONSOLE_SYMBOLS = {"console630_parse_current": 0x0112B70C, "console630_response_current": 0x0112B800}
INSTRUCTION_CHECKS = {
    0x01021054: ("movi", "r0, 96"),
    0x0102105C: ("mov", "r7, r0"),
    0x0102106A: ("mov", "r0, r7"),
    0x0102109E: ("movi", "r2, 96"),
    0x010210A8: ("mov", "r7, r7"),
    0x010210DE: ("mov", "r3, r7"),
}
XML_ZEPHYR = re.compile(rb"(<file_name>zephyr\.bin</file_name>\s*<file_size>)[^<]+(</file_size>\s*<checksum>)[^<]+(</checksum>)")
PARTITION_ORDER = ["ota.xml", "zephyr.bin", "RomeApp.bin", "UAC.bin", "IG1202dl.bin", "sdfs.bin", "mbrec.bin"]


class Refused(Exception):
    pass


def need(ok, code, detail):
    if not ok:
        raise Refused(f"{code}: {detail}")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_int(value, code="INTEGER"):
    try:
        if isinstance(value, bool):
            raise ValueError("boolean is not an address")
        return int(value, 0) if isinstance(value, str) else int(value)
    except (TypeError, ValueError) as exc:
        raise Refused(f"{code}: invalid integer {value!r}") from exc


def load_pins():
    data = {}
    for key, (path, expected) in BASE_PINS.items():
        need(path.is_file(), "MISSING_INPUT", f"{key}: {path}")
        raw = path.read_bytes()
        need(sha(raw) == expected, "PIN_MISMATCH", f"{key}: {sha(raw)} != {expected}")
        data[key] = raw
    need(OBJDUMP.is_file() and sha(OBJDUMP.read_bytes()) == OBJDUMP_SHA256,
         "PIN_MISMATCH", "CK802 objdump differs from its pin")
    return data


def import_pinned(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    need(spec is not None and spec.loader is not None, "HELPER_IMPORT", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(Path(module.__file__).resolve() == path.resolve(), "HELPER_PATH", f"{name} loaded from {module.__file__}")
    return module


def raw_parse_container(data):
    """Independent ACTTEST0 parse including padding and trailing-byte checks."""
    need(len(data) >= 512 and data[:8] == b"ACTTEST0", "CONTAINER_MAGIC", "ACTTEST0 header missing")
    header_crc, count = struct.unpack_from("<IB", data, 8)
    version, total, data_crc = struct.unpack_from("<III", data, 16)
    need(data[13:16] == bytes(3) and data[28:32] == bytes(4), "CONTAINER_RESERVED", "reserved bytes nonzero")
    need(version == 0x01000000 and total == len(data) and 1 <= count <= 15, "CONTAINER_HEADER", "version/length/count")
    need(zlib.crc32(data[12:512]) == header_crc, "CONTAINER_HEADER_CRC", "mismatch")
    need(zlib.crc32(data[512:]) == data_crc, "CONTAINER_DATA_CRC", "mismatch")
    need(data[32 + 32 * count:512] == bytes(512 - 32 - 32 * count), "CONTAINER_DIRECTORY_PADDING", "nonzero bytes")
    entries, cursor = [], 512
    for i in range(count):
        raw_name, load, offset, size, run, crc = struct.unpack_from("<12sIIIII", data, 32 + 32 * i)
        label = raw_name.rstrip(b"\0")
        need(raw_name == label.ljust(12, b"\0") and re.fullmatch(rb"[A-Za-z0-9_.-]+", label), "CONTAINER_NAME", str(i))
        need(offset == cursor and size > 0 and offset + size <= len(data), "CONTAINER_LAYOUT", label.decode())
        payload = data[offset:offset + size]
        need(zlib.crc32(payload) == crc, "CONTAINER_ENTRY_CRC", label.decode())
        end = offset + size + 512 - size % 512
        need(data[offset + size:end] == b"\xff" * (end - offset - size), "CONTAINER_ENTRY_PAD", label.decode())
        entries.append({"name": label.decode(), "load": load, "run": run, "offset": offset,
                        "size": size, "crc": crc, "sha256": sha(payload)})
        cursor = end
    need(cursor == len(data), "CONTAINER_TRAILING_BYTES", f"parsed through {cursor}, length {len(data)}")
    return entries


def xml_summary(raw):
    root = ET.fromstring(raw)
    parts = {}
    for part in root.findall("./partitions/partition"):
        parts[part.findtext("file_name")] = {key: part.findtext(key) for key in ("type", "name", "file_id", "file_size", "checksum")}
    return {"version_code": root.findtext("./firmware_version/version_code"),
            "version_name": root.findtext("./firmware_version/version_name"),
            "board": root.findtext("./firmware_version/board_name"),
            "ota_version_check": root.findtext("./firmware_version/ota_version_check"),
            "partitionsNum": root.findtext("./partitions/partitionsNum"), "partitions": parts}


def xml_fields(element, parent=""):
    tag = element.tag + (f"[{element.findtext('file_name')}]" if element.tag == "partition" else "")
    here = f"{parent}/{tag}"
    values = {here: (element.text or "").strip()} if len(element) == 0 else {}
    for child in element:
        values.update(xml_fields(child, here))
    return values


def load_baseline(pins, decoder, parser):
    raw, decoded = pins["base_container"], pins["base_system"]
    extracted = parser.parse(raw)
    entries = raw_parse_container(raw)
    need([(e["name"], e["offset"], e["size"], int(e["crc32"], 16)) for e in extracted["entries"]] ==
         [(e["name"], e["offset"], e["size"], e["crc"]) for e in entries],
         "BASE_PARSER_DISAGREEMENT", "pinned parser and independent parser disagree")
    need([e["name"] for e in entries] == PARTITION_ORDER, "BASE_PARTITIONS", "directory order/set changed")
    need(extracted["version"] == VERSION_NAME and extracted["board"] == BOARD, "BASE_IDENTITY", "not selected 393990 image")
    payloads = {e["name"]: raw[e["offset"]:e["offset"] + e["size"]] for e in entries}
    need(decoder.transform(payloads["zephyr.bin"], SEED) == decoded and len(decoded) == 1237504,
         "BASE_SYS_DECODE", "decoded system differs from pinned current SYS")
    boot = decoder.transform(payloads["mbrec.bin"], SEED)
    need(len(boot) == 4096 and sha(boot) == "7bd8bce552f7a07d3ce5bd5f25a71eb162e46ae71118d4e495e285b6034fc168",
         "BASE_BOOT", "selected compose3 boot differs")
    need(boot[0xF80:0xF84] == b"FVER" and zlib.crc32(boot[0xF80:0xFFC]) == struct.unpack_from("<I", boot, 0xFFC)[0],
         "BASE_BOOT_FVER", "FVER CRC invalid")
    need(struct.unpack_from("<I", boot, 0xF84)[0] == VERSION_CODE and boot[0xF8C:0xFCC].rstrip(b"\0").decode() == VERSION_NAME,
         "BASE_BOOT_IDENTITY", "FVER code/name mismatch")
    summary = xml_summary(payloads["ota.xml"])
    need(int(summary["version_code"], 0) == VERSION_CODE and summary["version_name"] == VERSION_NAME and summary["board"] == BOARD,
         "BASE_XML_IDENTITY", "ota.xml code/name/board mismatch")
    for entry in entries:
        need(entry["load"] == entry["run"] == 0, "BASE_LOAD_RUN", entry["name"])
    need(sha(payloads["zephyr.bin"]) == "8ee0b1b6ced635b84e5f493eb1b12ce842623eb8cb5854ba04a80a43942203bd",
         "BASE_ZEPHYR_ENCODED", "encoded baseline SYS mismatch")
    need(sha(payloads["mbrec.bin"]) == "133358b389b9995dcb0430a52360dde0f4c17bbf6ecb05b51af387d5b75f2ec5",
         "BASE_BOOT_ENCODED", "encoded baseline boot mismatch")
    return {"raw": raw, "decoded": decoded, "boot": boot, "entries": entries,
            "payloads": payloads, "xml_summary": summary}


def parse_elf(elf):
    need(elf[:7] == b"\x7fELF\x01\x01\x01", "ELF_FORMAT", "ELF32 little-endian required")
    (e_type, machine, _version, _entry, _phoff, shoff, _flags, _ehsize,
     _phentsize, _phnum, shentsize, shnum, shstrndx) = struct.unpack_from("<HHIIIIIHHHHHH", elf, 16)
    need(e_type == 2 and machine == 252, "ELF_PROFILE", f"expected C-SKY executable, type={e_type}, machine={machine}")
    need(shentsize == 40 and 0 < shnum < 4096 and shstrndx < shnum, "ELF_SECTIONS", "bad section table")
    raw = [struct.unpack_from("<10I", elf, shoff + i * shentsize) for i in range(shnum)]
    names_hdr = raw[shstrndx]
    names = elf[names_hdr[4]:names_hdr[4] + names_hdr[5]]
    sections = []
    for index, (name, kind, flags, addr, off, size, link, info, align, ent) in enumerate(raw):
        need(kind == 8 or off + size <= len(elf), "ELF_SECTION_RANGE", str(index))
        label = names[name:].split(b"\0", 1)[0].decode("ascii") if name < len(names) else ""
        sections.append({"index": index, "name": label, "type": kind, "flags": flags, "addr": addr,
                         "off": off, "size": size, "link": link, "info": info, "align": align, "ent": ent})
    by_name = {s["name"]: s for s in sections}
    need(len(by_name) == len(sections), "ELF_SECTION_NAMES", "duplicate sections")
    return sections, by_name


def elf_symbols(elf, sections):
    tables = [s for s in sections if s["type"] == 2]
    need(len(tables) == 1, "ELF_SYMBOLS", f"found {len(tables)} symbol tables")
    table = tables[0]
    strings_hdr = sections[table["link"]]
    strings = elf[strings_hdr["off"]:strings_hdr["off"] + strings_hdr["size"]]
    need(table["size"] % 16 == 0, "ELF_SYMBOLS", "bad symbol entry size")
    found, unresolved = {}, []
    for i in range(table["size"] // 16):
        name, value, _size, info, _other, shndx = struct.unpack_from("<IIIBBH", elf, table["off"] + i * 16)
        label = strings[name:].split(b"\0", 1)[0].decode("ascii") if name < len(strings) else ""
        if label:
            found.setdefault(label, []).append(value)
            if shndx == 0 and info >> 4 in (1, 2):
                unresolved.append(label)
    need(not unresolved, "ELF_UNDEFINED", ", ".join(unresolved))
    return found


def parse_symbols_text(data):
    result = {}
    for line in data.decode("ascii").splitlines():
        fields = line.split()
        if len(fields) == 3 and re.fullmatch(r"[0-9a-fA-F]+", fields[0]):
            result.setdefault(fields[2], []).append(int(fields[0], 16))
    return result


def decode_bsr(raw, address):
    need(len(raw) == 4, "BSR_WIDTH", f"{address:08x}")
    value = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    need(value >> 26 == 0x38, "BSR_ENCODING", f"{address:08x}: {raw.hex()}")
    displacement = value & 0x03FFFFFF
    if displacement & 0x02000000:
        displacement -= 0x04000000
    return address + displacement * 2


def decode_movi(raw):
    need(len(raw) == 2, "MOVI_WIDTH", raw.hex())
    half = int.from_bytes(raw, "little")
    need(half & 0xF800 == 0x3000, "MOVI_ENCODING", raw.hex())
    return (half >> 8) & 7, half & 0xFF


def contained(path, root):
    resolved, base = path.resolve(), root.resolve()
    need(resolved == base or base in resolved.parents, "PATH_SCOPE", f"{path} is outside {root}")
    return resolved


def read_layout(args, baseline, pins):
    artifact_root = Path(args.artifact_root).resolve()
    manifest_path = contained(Path(args.manifest), artifact_root)
    elf_path = contained(Path(args.elf), artifact_root)
    symbols_path = contained(Path(args.symbols), artifact_root)
    need(manifest_path.is_file() and elf_path.is_file() and symbols_path.is_file(), "LAYOUT_FILES", "manifest/ELF/symbols missing")
    manifest_raw, elf, symbols_raw = manifest_path.read_bytes(), elf_path.read_bytes(), symbols_path.read_bytes()
    need(sha(manifest_raw) == args.manifest_sha256, "LAYOUT_MANIFEST_PIN", sha(manifest_raw))
    need(sha(elf) == args.elf_sha256, "LAYOUT_ELF_PIN", sha(elf))
    need(sha(symbols_raw) == args.symbols_sha256, "LAYOUT_SYMBOLS_PIN", sha(symbols_raw))
    manifest = json.loads(manifest_raw)

    def manifest_file_matches(field, actual):
        raw_path = manifest
        for component in field.split("."):
            raw_path = raw_path.get(component) if isinstance(raw_path, dict) else None
        need(isinstance(raw_path, str) and raw_path, "LAYOUT_PATH_BINDING", f"manifest lacks {field}")
        path = Path(raw_path)
        if not path.is_absolute():
            path = REPO / path
        need(path.resolve() == actual.resolve(), "LAYOUT_PATH_BINDING", f"{field}: {raw_path} != {actual}")

    base = manifest.get("baseline", {})
    base_sha = base.get("sha256", manifest.get("baseline_sha256"))
    base_len = base.get("bytes", manifest.get("baseline_bytes"))
    base_address = base.get("load_base", manifest.get("baseline_base_address"))
    need(base_sha == sha(baseline["decoded"]) and base_len == len(baseline["decoded"]) and
         parse_int(base_address, "LAYOUT_BASE_ADDRESS") == BASE_VA,
         "LAYOUT_BASE_BINDING", "manifest is not pinned to exact selected 393990 SYS")
    manifest_file_matches("baseline.path", BASE_SYSTEM)
    need(manifest.get("elf_sha256") == sha(elf), "LAYOUT_ELF_BINDING", "manifest does not bind actual ELF")
    need(manifest.get("symbols_sha256") == sha(symbols_raw), "LAYOUT_SYMBOLS_BINDING", "manifest does not bind actual symbols file")
    manifest_file_matches("elf_path", elf_path)
    manifest_file_matches("symbols_path", symbols_path)
    contract = manifest.get("layout", {})
    checks = manifest.get("layout_checks", {})
    need(manifest.get("status") == "OFFLINE_CANDIDATE_NOTINSTALL" and
         contract.get("status") == "proposed_offline_suballocation" and
         contract.get("ownership_accepted") is False and contract.get("reservation_accepted") is False and
         contract.get("target_qualified") is False and contract.get("install_authorized") is False and
         manifest.get("installed", checks.get("installed")) is False and
         manifest.get("firmware_image_generated", checks.get("firmware_image_generated")) is False and
         checks.get("full_candidate_windows_match_declared_fill") is True and checks.get("composed") is False and
         checks.get("installed") is False and checks.get("hardware_tested") is False,
         "LAYOUT_STATUS", "manifest must remain a proposed offline NOTINSTALL layout")

    sections, by_section = parse_elf(elf)
    attrs = by_section.get(".csky.attributes")
    need(attrs is not None and b"ck802" in elf[attrs["off"]:attrs["off"] + attrs["size"]], "ELF_CK802", "CK802 attribute missing")
    symbols = elf_symbols(elf, sections)
    symbols_text = parse_symbols_text(symbols_raw)
    segment_rows = manifest.get("segments")
    need(isinstance(segment_rows, list) and len(segment_rows) == 2, "LAYOUT_SEGMENTS", "exactly two explicit tail segments expected")
    expected_segment_names = {".router_tail", ".console_tail"}
    need({s.get("name") for s in segment_rows} == expected_segment_names, "LAYOUT_SEGMENT_NAMES", str([s.get("name") for s in segment_rows]))
    expected_fills = {".router_tail": 0xFF, ".console_tail": 0x00}
    approved_segments = []
    for seg in segment_rows:
        name = seg["name"]
        address = parse_int(seg.get("address"), "SEGMENT_ADDRESS")
        length = parse_int(seg.get("length"), "SEGMENT_LENGTH")
        section_name = seg.get("elf_section")
        source_offset = parse_int(seg.get("elf_section_offset"), "SEGMENT_SOURCE_OFFSET")
        section_file_offset = parse_int(seg.get("elf_file_offset"), "SEGMENT_FILE_OFFSET")
        need(section_name in by_section, "SEGMENT_SECTION", f"{name}: {section_name}")
        sec = by_section[section_name]
        need(sec["type"] == 1 and sec["flags"] & 2 and sec["flags"] & 4 and not sec["flags"] & 1,
             "SEGMENT_FLAGS", f"{name}: source is not read-only allocatable executable PROGBITS")
        need(address == sec["addr"] + source_offset and section_file_offset == sec["off"] + source_offset,
             "SEGMENT_ELF_MAPPING", f"{name}: VA/file offset does not map to ELF section")
        need(length > 0 and source_offset + length <= sec["size"], "SEGMENT_LENGTH", f"{name}: out of source section")
        start, end = address, address + length
        reservation_start = parse_int(seg.get("reservation_start"), "SEGMENT_RESERVATION_START")
        reservation_end = parse_int(seg.get("reservation_end"), "SEGMENT_RESERVATION_END")
        window_start = parse_int(seg.get("candidate_window_start"), "SEGMENT_WINDOW_START")
        window_end = parse_int(seg.get("candidate_window_end"), "SEGMENT_WINDOW_END")
        need(BASE_VA <= reservation_start < reservation_end <= BASE_VA + len(baseline["decoded"]) and
             reservation_start <= window_start < window_end <= reservation_end and
             window_start <= start < end <= window_end,
             "SEGMENT_WINDOW", f"{name}: {start:08x}..{end:08x} outside explicit manifest window")
        actual = elf[section_file_offset:section_file_offset + length]
        need(len(actual) == length and sha(actual) == seg.get("sha256"), "SEGMENT_ELF_HASH", name)
        export_ref = seg.get("exported_artifact")
        need(isinstance(export_ref, str), "SEGMENT_EXPORT", f"{name}: no exported raw segment path")
        exported_path = contained(manifest_path.parent / export_ref, artifact_root)
        need(exported_path.is_file(), "SEGMENT_EXPORT", str(exported_path))
        exported = exported_path.read_bytes()
        need(exported == actual and sha(exported) == seg.get("exported_artifact_sha256"),
             "SEGMENT_EXPORT_HASH", name)
        manifest_artifact_path = Path(seg.get("exported_artifact_path", ""))
        if not manifest_artifact_path.is_absolute():
            manifest_artifact_path = REPO / manifest_artifact_path
        need(manifest_artifact_path.resolve() == exported_path.resolve(), "SEGMENT_EXPORT_PATH", name)
        before = baseline["decoded"][start - BASE_VA:end - BASE_VA]
        fill_hex = str(seg.get("preimage_fill", "")).lower().removeprefix("0x")
        need(fill_hex == f"{expected_fills[name]:02x}" and len(before) == length and
             before == bytes([expected_fills[name]]) * length and
             sha(before) == seg.get("baseline_preimage_sha256"),
             "SEGMENT_BASELINE_PREIMAGE", f"{name}: pinned baseline does not match exact expected uniform fill/hash")
        window_fill_hex = str(seg.get("candidate_window_preimage_fill", "")).lower().removeprefix("0x")
        window_preimage = baseline["decoded"][window_start - BASE_VA:window_end - BASE_VA]
        need(window_fill_hex == fill_hex and len(window_preimage) == window_end - window_start and
             window_preimage == bytes([expected_fills[name]]) * len(window_preimage) and
             sha(window_preimage) == seg.get("candidate_window_preimage_sha256"),
             "SEGMENT_WINDOW_PREIMAGE", f"{name}: exact candidate window fill/hash differs from the manifest")
        declared_preimage = seg.get("baseline_preimage_hex", seg.get("baseline_preimage_bytes_hex"))
        if declared_preimage is not None:
            try:
                manifest_preimage = bytes.fromhex(declared_preimage)
            except (TypeError, ValueError) as exc:
                raise Refused(f"SEGMENT_PREIMAGE_HEX: {name}: malformed declared preimage") from exc
            need(manifest_preimage == before, "SEGMENT_PREIMAGE_HEX", f"{name}: manifest preimage differs from pinned baseline")
        approved_segments.append({"name": name, "address": start, "length": length,
                                  "start_offset": start - BASE_VA, "end_offset": end - BASE_VA,
                                  "elf_section": section_name, "elf_section_offset": source_offset,
                                  "elf_file_offset": section_file_offset, "bytes": actual,
                                  "sha256": sha(actual), "preimage_sha256": sha(before),
                                  "preimage_fill": fill_hex,
                                  "path": str(exported_path), "exported_sha256": sha(exported),
                                  "reservation_start": reservation_start, "reservation_end": reservation_end,
                                  "window_start": window_start, "window_end": window_end,
                                  "window_preimage_sha256": sha(window_preimage), "window_preimage_fill": window_fill_hex})
    approved_segments.sort(key=lambda s: s["address"])
    for left, right in zip(approved_segments, approved_segments[1:]):
        need(left["address"] + left["length"] <= right["address"], "SEGMENT_OVERLAP", f"{left['name']} and {right['name']}")

    preserved_rows = manifest.get("preserved_ranges")
    need(isinstance(preserved_rows, list) and len(preserved_rows) == 2, "PRESERVED_RANGES", "exact router and console live ranges required")
    preserved_expected = {
        "fixed_router_live_text": (0x01128000, len(pins["base_router_bin"]), "base_router_bin", "base_router_elf"),
        "current_console_live_module": (0x0112B000, len(pins["base_console_bin"]), "base_console_bin", "base_console_elf"),
    }
    preserved = []
    for row in preserved_rows:
        name = row.get("name")
        need(name in preserved_expected, "PRESERVED_RANGE_NAME", str(name))
        address, length, bin_key, elf_key = preserved_expected[name]
        start = parse_int(row.get("address"), "PRESERVED_RANGE_ADDRESS")
        got_length = parse_int(row.get("length"), "PRESERVED_RANGE_LENGTH")
        raw = baseline["decoded"][start - BASE_VA:start - BASE_VA + got_length]
        need(start == address and got_length == length and len(raw) == length and
             sha(raw) == row.get("sha256") == row.get("expected_module_sha256") == sha(pins[bin_key]) and
             row.get("expected_elf_sha256") == sha(pins[elf_key]) and row.get("baseline_matches_live_module") is True,
             "PRESERVED_RANGE_READBACK", name)
        for seg in approved_segments:
            need(seg["address"] + seg["length"] <= start or seg["address"] >= start + length,
                 "SEGMENT_LIVE_OVERLAP", f"{seg['name']} overlaps {name}")
        preserved.append({"name": name, "address": start, "length": length, "sha256": sha(raw)})
    need({item["name"] for item in preserved} == set(preserved_expected), "PRESERVED_RANGE_SET", "router/console range set incomplete")

    patch_rows = manifest.get("patches")
    need(isinstance(patch_rows, list) and len(patch_rows) == len(PATCHES), "LAYOUT_PATCHES", "exactly ten instruction patches expected")
    approved_patches, patch_ranges = [], []
    for patch in patch_rows:
        address_raw = patch.get("address")
        address = int(address_raw, 16) if isinstance(address_raw, str) else int(address_raw)
        need(address in PATCHES, "PATCH_ADDRESS", f"unapproved site {address:08x}")
        width, expected_role, expected_target = PATCHES[address]
        role = patch.get("role")
        need(patch.get("width", patch.get("length")) == width and role == expected_role, "PATCH_ROLE", f"{address:08x}: {role}")
        before_hex = patch.get("before_hex")
        replacement_hex = patch.get("replacement_hex")
        need(before_hex == PREIMAGES[address] and replacement_hex and len(bytes.fromhex(replacement_hex)) == width,
             "PATCH_HEX", f"{role}: preimage/replacement width")
        before = baseline["decoded"][address - BASE_VA:address - BASE_VA + width]
        need(before.hex() == before_hex, "PATCH_BASELINE_PREIMAGE", role)
        source_section_name = patch.get("source_elf_section")
        source_offset = parse_int(patch.get("elf_section_offset"), "PATCH_SOURCE_OFFSET")
        need(source_section_name in by_section, "PATCH_SOURCE_SECTION", f"{role}: {source_section_name}")
        source_section = by_section[source_section_name]
        source_file_offset = parse_int(patch.get("elf_file_offset"), "PATCH_SOURCE_FILE_OFFSET")
        need(source_offset + width <= source_section["size"] and source_file_offset == source_section["off"] + source_offset,
             "PATCH_SOURCE_RANGE", role)
        need(source_section["type"] == 1 and source_section["flags"] & 2 and source_section["flags"] & 4 and not source_section["flags"] & 1,
             "PATCH_SOURCE_FLAGS", f"{role}: source is not read-only allocatable executable PROGBITS")
        actual = elf[source_file_offset:source_file_offset + width]
        need(actual.hex() == replacement_hex and sha(actual) == patch.get("replacement_sha256"),
             "PATCH_ELF_BYTES", f"{role}: replacement differs from actual linked ELF")
        need(source_section["addr"] + source_offset == address, "PATCH_ELF_ADDRESS", role)
        symbol_name = patch.get("target_symbol", patch.get("linked_target_symbol"))
        if expected_target:
            need(symbol_name == expected_target, "PATCH_TARGET_SYMBOL", f"{role}: {symbol_name}")
            need(len(symbols.get(expected_target, [])) == 1 and symbols_text.get(expected_target) == symbols[expected_target],
                 "PATCH_TARGET_SYMBOLS", expected_target)
            target = decode_bsr(actual, address)
            need(target == symbols[expected_target][0] and
                 parse_int(patch.get("target_address"), "PATCH_TARGET_ADDRESS") == target and
                 parse_int(patch.get("decoded_bsr_target_from_raw_bytes"), "PATCH_DECODED_TARGET") == target and
                 patch.get("branch_readback_passed") is True,
                 "PATCH_BRANCH_TARGET", role)
            need(approved_segments and any(seg["address"] <= target < seg["address"] + seg["length"] for seg in approved_segments),
                 "PATCH_TARGET_PLACEMENT", f"{role} target {target:08x} not inside an inserted segment")
        else:
            need(symbol_name in (None, ""), "PATCH_UNEXPECTED_TARGET", role)
            target = None
        patch_ranges.append((address - BASE_VA, address - BASE_VA + width, role))
        approved_patches.append({"address": address, "offset": address - BASE_VA, "width": width,
                                 "role": role, "before": before, "after": actual,
                                 "source_section": source_section_name, "source_offset": source_offset,
                                 "source_file_offset": source_file_offset, "target_symbol": symbol_name,
                                 "target": target, "sha256": sha(actual)})
    approved_patches.sort(key=lambda p: p["address"])
    for left, right in zip(approved_patches, approved_patches[1:]):
        need(left["address"] + left["width"] <= right["address"], "PATCH_OVERLAP", f"{left['role']} / {right['role']}")
    for patch in approved_patches:
        for segment in approved_segments:
            need(patch["address"] + patch["width"] <= segment["address"] or
                 patch["address"] >= segment["address"] + segment["length"], "PATCH_SEGMENT_OVERLAP", patch["role"])

    symbols_required = {target for _width, _role, target in PATCHES.values() if target}
    for name in symbols_required | set(CURRENT_CONSOLE_SYMBOLS):
        need(len(symbols.get(name, [])) == 1 and symbols_text.get(name) == symbols[name], "ELF_SYMBOL", name)
    for name, expected in CURRENT_CONSOLE_SYMBOLS.items():
        need(symbols[name][0] == expected, "CURRENT_CONSOLE_SYMBOL", name)
    for address, expected in CURRENT_HOOK_TARGETS.items():
        need(decode_bsr(baseline["decoded"][address - BASE_VA:address - BASE_VA + 4], address) == expected,
             "CURRENT_HOOK_PREIMAGE", f"{address:08x}")
    alloc = next((p for p in approved_patches if p["address"] == 0x01021054), None)
    zero = next((p for p in approved_patches if p["address"] == 0x0102109E), None)
    need(alloc and zero and decode_movi(alloc["after"]) == (0, 0x60) and decode_movi(zero["after"]) == (2, 0x60),
         "CONSTRUCTOR_TAIL_SIZE", "ELF does not allocate and clear 0x60 bytes")
    # New code symbols must be inside the explicit inserted ranges, including the
    # poll wrapper, delayed-publication stub and both F11A hook entry points.
    target_values = {name: symbols[name][0] for name in symbols_required}
    for name, value in target_values.items():
        need(any(seg["address"] <= value < seg["address"] + seg["length"] for seg in approved_segments),
             "ELF_SYMBOL_PLACEMENT", f"{name} at {value:08x} is not in a manifest segment")

    return {"manifest": manifest, "manifest_path": manifest_path, "manifest_sha256": sha(manifest_raw),
            "elf_path": elf_path, "elf_sha256": sha(elf), "symbols_path": symbols_path,
            "symbols_sha256": sha(symbols_raw), "elf": elf, "sections": by_section,
            "symbols": {name: values[0] for name, values in symbols.items() if len(values) == 1},
            "segments": approved_segments, "preserved_ranges": preserved, "patches": approved_patches}


def compose_system(baseline, layout):
    frozen = baseline["decoded"]
    output = bytearray(frozen)
    ranges = []
    for seg in layout["segments"]:
        output[seg["start_offset"]:seg["end_offset"]] = seg["bytes"]
        ranges.append((seg["start_offset"], seg["end_offset"], seg["name"]))
    for patch in layout["patches"]:
        output[patch["offset"]:patch["offset"] + patch["width"]] = patch["after"]
        ranges.append((patch["offset"], patch["offset"] + patch["width"], patch["role"]))
    need(len(output) == len(frozen), "NO_GROWTH_LENGTH", "candidate SYS length changed")
    return bytes(output), ranges


def objdump_rows(path, start, stop):
    run = subprocess.run([str(OBJDUMP), "-D", "-b", "binary", "-m", "csky", f"--adjust-vma=0x{BASE_VA:08x}",
                          f"--start-address=0x{start:08x}", f"--stop-address=0x{stop:08x}", str(path)],
                         capture_output=True, text=True, timeout=120)
    need(run.returncode == 0, "OBJDUMP", run.stderr[-1000:])
    rows = {}
    for line in run.stdout.splitlines():
        parts = line.split("\t")
        m = re.match(r"^\s*([0-9a-f]+):$", parts[0])
        if m and len(parts) >= 3:
            rows[int(m.group(1), 16)] = (parts[2].strip(), parts[3].strip() if len(parts) > 3 else "",
                                         parts[4].strip() if len(parts) > 4 else "")
    return rows, run.stdout


def readback_system(path, candidate, baseline, layout, allowed_ranges):
    data = path.read_bytes()
    need(len(data) == len(baseline["decoded"]) and sha(data) == sha(candidate), "SYSTEM_DISK_READBACK", "length/hash mismatch")
    need(data[:SYSTEM_HEADER_BYTES] == baseline["decoded"][:SYSTEM_HEADER_BYTES], "SYSTEM_HEADER", "first 48 bytes changed")
    diffs = [i for i, (a, b) in enumerate(zip(baseline["decoded"], data)) if a != b]
    outside = [i for i in diffs if not any(start <= i < end for start, end, _name in allowed_ranges)]
    need(not outside, "SYSTEM_UNAPPROVED_DIFF", str([hex(i) for i in outside[:8]]))
    inverse = bytearray(data)
    for seg in layout["segments"]:
        inverse[seg["start_offset"]:seg["end_offset"]] = baseline["decoded"][seg["start_offset"]:seg["end_offset"]]
    for patch in layout["patches"]:
        inverse[patch["offset"]:patch["offset"] + patch["width"]] = patch["before"]
    need(bytes(inverse) == baseline["decoded"], "SYSTEM_INVERSE", "segments plus ten patches do not restore exact baseline")

    ranges_to_disasm = [(0x01021024, 0x010210F0), (0x01020B62, 0x01020B66),
                        (0x0103907A, 0x0103907E), (0x0103A996, 0x0103A99A)]
    for patch in layout["patches"]:
        if patch["target_symbol"]:
            target = patch["target"]
            ranges_to_disasm.append((target, min(target + 0x20, BASE_VA + len(data))))
    texts, all_rows = [], []
    for start, stop in ranges_to_disasm:
        rows, listing = objdump_rows(path, start, stop)
        all_rows.append((start, stop, rows))
        texts.append(f"===== 0x{start:08x}-0x{stop:08x}\n{listing}")
    def row_at(address):
        for start, stop, rows in all_rows:
            if start <= address < stop and address in rows:
                return rows[address]
        raise Refused(f"OBJDUMP_MISSING: {address:08x}")

    branch_records = []
    for patch in layout["patches"]:
        if not patch["target_symbol"]:
            continue
        raw = data[patch["offset"]:patch["offset"] + patch["width"]]
        py_target = decode_bsr(raw, patch["address"])
        row = row_at(patch["address"])
        need(row[0] == "bsr", "SYSTEM_BSR_DISASSEMBLY", patch["role"])
        obj_target = int(row[1].split()[0], 16)
        need(py_target == obj_target == patch["target"], "SYSTEM_BSR_TARGET", patch["role"])
        branch_records.append({"role": patch["role"], "site": f"{patch['address']:08x}",
                               "raw_bytes": raw.hex(), "symbol": patch["target_symbol"],
                               "target_python": f"{py_target:08x}", "target_objdump": f"{obj_target:08x}"})
    for address, expected in INSTRUCTION_CHECKS.items():
        need(row_at(address)[:2] == expected, "SYSTEM_CONSTRUCTOR_INSTRUCTION", f"{address:08x}: {row_at(address)[:2]}")
    need(row_at(0x01021070)[0] == "bsr" and int(row_at(0x01021070)[1].split()[0], 16) == layout["symbols"]["late_publication_stub"],
         "SYSTEM_LATE_PUBLICATION", "constructor does not call linked publication stub")
    old_alloc = decode_movi(baseline["decoded"][0x01021054 - BASE_VA:0x01021056 - BASE_VA])
    old_zero = decode_movi(baseline["decoded"][0x0102109E - BASE_VA:0x010210A0 - BASE_VA])
    alloc = decode_movi(data[0x01021054 - BASE_VA:0x01021056 - BASE_VA])
    zero = decode_movi(data[0x0102109E - BASE_VA:0x010210A0 - BASE_VA])
    need(old_alloc == (0, 0x40) and old_zero == (2, 0x40) and alloc == (0, 0x60) and zero == (2, 0x60),
         "SYSTEM_TAIL_ALLOCATION", "constructor allocation/clear changed unexpectedly")
    need(0x40 + 32 == alloc[1], "SYSTEM_TAIL_BOUNDS", "32-byte telemetry tail does not fit exactly")
    return {"sha256": sha(data), "bytes": len(data), "baseline_sha256": sha(baseline["decoded"]),
            "baseline_bytes": len(baseline["decoded"]), "growth_bytes": 0,
            "differing_bytes": len(diffs), "unapproved_differing_bytes": 0,
            "inverse_reconstructs_baseline": True, "header_0_47_identical": True,
            "segments": [{"name": s["name"], "address": f"{s['address']:08x}", "bytes": s["length"], "sha256": s["sha256"],
                          "baseline_preimage_sha256": s["preimage_sha256"]} for s in layout["segments"]],
            "branches": branch_records,
            "constructor": {"old_allocation": old_alloc[1], "new_allocation": alloc[1],
                            "old_zero": old_zero[1], "new_zero": zero[1], "tail_offset": 0x40, "tail_bytes": 32},
            "instruction_listing": "readback-instructions.txt", "listing_text": "\n".join(texts)}


def write_exclusive(path, data):
    with path.open("xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def publish_no_clobber(partial, final):
    os.link(partial, final)
    os.unlink(partial)


def verify_container(path, baseline, candidate, decoder, parser):
    raw = path.read_bytes()
    extracted, entries = parser.parse(raw), raw_parse_container(raw)
    need([(e["name"], e["offset"], e["size"], int(e["crc32"], 16)) for e in extracted["entries"]] ==
         [(e["name"], e["offset"], e["size"], e["crc"]) for e in entries], "PACKED_PARSER_AGREEMENT", "parsers disagree")
    need(extracted["version"] == VERSION_NAME and extracted["board"] == BOARD, "PACKED_IDENTITY", "version/board changed")
    old_entries = baseline["entries"]
    need([e["name"] for e in entries] == [e["name"] for e in old_entries], "PACKED_ORDER", "partition order changed")
    need([(e["offset"], e["load"], e["run"]) for e in entries] == [(e["offset"], e["load"], e["run"]) for e in old_entries],
         "PACKED_OFFSETS", "no-growth candidate must preserve every partition offset/load/run")
    payloads = {e["name"]: raw[e["offset"]:e["offset"] + e["size"]] for e in entries}
    old = baseline["payloads"]
    need(len(raw) == len(baseline["raw"]), "PACKED_LENGTH", "container length changed")
    need(len(payloads["zephyr.bin"]) == len(old["zephyr.bin"]), "PACKED_ZEPHYR_SIZE", "no-growth system changed zephyr length")
    need(payloads["mbrec.bin"] == old["mbrec.bin"], "PACKED_BOOT_PARTITION", "mbrec payload changed")
    for name in ("RomeApp.bin", "UAC.bin", "IG1202dl.bin", "sdfs.bin"):
        need(payloads[name] == old[name], "PACKED_OTHER_PARTITION", name)
    before_xml, after_xml = old["ota.xml"], payloads["ota.xml"]
    mask = lambda x: XML_ZEPHYR.sub(lambda m: m[1] + b"@" + m[2] + b"@" + m[3], x)
    need(mask(before_xml) == mask(after_xml), "PACKED_XML_SCOPE", "XML changed outside zephyr size/CRC fields")
    old_fields, new_fields = xml_fields(ET.fromstring(before_xml)), xml_fields(ET.fromstring(after_xml))
    changed_fields = sorted(k for k in set(old_fields) | set(new_fields) if old_fields.get(k) != new_fields.get(k))
    need(all(k.endswith(("/partition[zephyr.bin]/file_size", "/partition[zephyr.bin]/checksum")) for k in changed_fields),
         "PACKED_XML_FIELDS", str(changed_fields))
    old_summary, new_summary = baseline["xml_summary"], xml_summary(after_xml)
    need(new_summary["version_code"] == old_summary["version_code"] and new_summary["version_name"] == old_summary["version_name"] and
         new_summary["board"] == BOARD, "PACKED_XML_IDENTITY", "same 393990 identity not retained")
    decoded = decoder.transform(payloads["zephyr.bin"], SEED)
    need(decoded == candidate, "PACKED_SYS_DECODE", "packed zephyr does not decode to candidate")
    boot = decoder.transform(payloads["mbrec.bin"], SEED)
    need(boot == baseline["boot"], "PACKED_BOOT_READBACK", "decoded boot changed")
    need(int(new_summary["partitions"]["zephyr.bin"]["file_size"], 16) == len(payloads["zephyr.bin"]) and
         int(new_summary["partitions"]["zephyr.bin"]["checksum"], 16) == zlib.crc32(payloads["zephyr.bin"]),
         "PACKED_ZEPHYR_XML", "zephyr size/CRC disagree with actual payload")
    return {"sha256": sha(raw), "bytes": len(raw), "decoded_system_sha256": sha(decoded),
            "decoded_system_bytes": len(decoded), "boot_decoded_sha256": sha(boot),
            "outer_header_crc32": f"0x{struct.unpack_from('<I', raw, 8)[0]:08x}",
            "outer_data_crc32": f"0x{struct.unpack_from('<I', raw, 24)[0]:08x}",
            "partitions": [{"name": e["name"], "offset": e["offset"], "size": e["size"],
                            "crc32": f"0x{e['crc']:08x}", "sha256": e["sha256"],
                            "payload_byte_identical_to_baseline": payloads[e["name"]] == old[e["name"]]}
                           for e in entries],
            "ota_xml_changed_fields": changed_fields,
            "checks": ["independent ACTTEST0 directory and CRC readback", "pinned parser agreement",
                       "exact same partition offsets and container length", "only zephyr size/CRC XML fields changed",
                       "boot/version and other partition payloads byte-identical", "decoded zephyr equals candidate SYS"]}


def run(args):
    pins = load_pins()
    decoder = import_pinned("decode_randomizer_393990", DECODER)
    parser = import_pinned("extract_acttest_393990", PARSER)
    packager = import_pinned("package_vad_container_393990", CONTAINER_PACKER)
    packager.VERSION_NAME = VERSION_NAME
    packager.VERSION_CODE = VERSION_CODE
    baseline = load_baseline(pins, decoder, parser)
    packager.BASE_BOOT_SHA = sha(baseline["boot"])
    layout = read_layout(args, baseline, pins)
    candidate, allowed_ranges = compose_system(baseline, layout)
    out_root = HERE / "out-NOTINSTALL"
    out_root.mkdir(exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = out_root / f"vad-393990-nogrowth-{stamp}-{layout['elf_sha256'][:8]}"
    run_dir.mkdir(exist_ok=False)

    sys_name = "system-decoded-vad-393990-EXPERIMENTAL-NOTINSTALL.bin"
    sys_partial, sys_final = run_dir / (sys_name + ".partial"), run_dir / sys_name
    write_exclusive(sys_partial, candidate)
    sys_readback = readback_system(sys_partial, candidate, baseline, layout, allowed_ranges)
    publish_no_clobber(sys_partial, sys_final)
    need(sha(sys_final.read_bytes()) == sys_readback["sha256"], "SYSTEM_FINAL_READBACK", "published system changed")
    listing_path = run_dir / "readback-instructions.txt"
    write_exclusive(listing_path, sys_readback.pop("listing_text").encode())

    # Pack exactly once from the verified on-disk decoded candidate.
    disk_candidate = sys_final.read_bytes()
    encoded = decoder.transform(disk_candidate, SEED, decrypt=False)
    need(len(encoded) == len(baseline["payloads"]["zephyr.bin"]) and decoder.transform(encoded, SEED) == disk_candidate,
         "ENCODED_ZEPHYR", "encoded system length/roundtrip differs")
    container_name = f"H1E-{VERSION_NAME}-vad-nogrowth-EXPERIMENTAL-NOTINSTALL.bin"
    container_partial, container_final = run_dir / (container_name + ".partial"), run_dir / container_name
    try:
        sdk_stdout_sha = packager.pack(baseline["payloads"], PARTITION_ORDER, disk_candidate, decoder,
                                       pins["sdk"], container_partial)
        package_readback = packager.verify_container(container_partial, baseline["raw"], baseline["payloads"],
                                                     baseline["entries"], disk_candidate, decoder, parser)
    except packager.PackError as exc:
        raise Refused(f"CONTAINER_PACKER: {exc}") from exc
    need(container_partial.is_file(), "CONTAINER_PACK", "pinned package_vad_container packer did not write the partial artifact")
    container_readback = verify_container(container_partial, baseline, disk_candidate, decoder, parser)
    need(package_readback["artifact_sha256"] == container_readback["sha256"] and
         package_readback["artifact_bytes"] == container_readback["bytes"] and
         package_readback["decoded_system_sha256"] == container_readback["decoded_system_sha256"],
         "CONTAINER_CHECKER_DISAGREEMENT", "pinned container packer and independent no-growth checker disagree")
    publish_no_clobber(container_partial, container_final)
    try:
        final_package_readback = packager.verify_container(container_final, baseline["raw"], baseline["payloads"],
                                                           baseline["entries"], disk_candidate, decoder, parser)
    except packager.PackError as exc:
        raise Refused(f"CONTAINER_FINAL_PACKER_READBACK: {exc}") from exc
    final_container_readback = verify_container(container_final, baseline, disk_candidate, decoder, parser)
    need(final_container_readback["sha256"] == container_readback["sha256"] and
         final_package_readback["artifact_sha256"] == final_container_readback["sha256"],
         "CONTAINER_FINAL_READBACK", "published container changed")

    unchanged_inputs = {key: sha(path.read_bytes()) == digest for key, (path, digest) in BASE_PINS.items()}
    need(all(unchanged_inputs.values()), "INPUT_MUTATION", "a pinned source input changed")
    receipt = {
        "status": "structural_readback_passed_EXPERIMENTAL_NOTINSTALL",
        "schema": "h1e-393990-vad-nogrowth-receipt-v1",
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "identity": {"version_name": VERSION_NAME, "version_code": VERSION_CODE, "board": BOARD,
                     "same_as_baseline": True, "new_version_allocated": False},
        "flags": {"EXPERIMENTAL": True, "NOTINSTALL": True, "installable": False,
                  "approved_for_installation": False, "installed": False, "physical_boot_verified": False,
                  "hardware_qualified": False, "release_or_publication": False, "full_vendor_source_rebuild": False},
        "inputs": {key: {"path": str(path.relative_to(REPO)), "sha256": digest, "bytes": len(pins[key])}
                   for key, (path, digest) in BASE_PINS.items()},
        "composer": {"path": str(Path(__file__).relative_to(REPO)), "sha256": sha(Path(__file__).read_bytes()),
                     "sdk_builder_sha256": BASE_PINS["sdk"][1], "decoder_sha256": BASE_PINS["decoder"][1],
                     "parser_sha256": BASE_PINS["parser"][1], "objdump_sha256": OBJDUMP_SHA256,
                     "sdk_stdout_sha256": sdk_stdout_sha},
        "accepted_layout": {"manifest_path": str(layout["manifest_path"].relative_to(REPO)),
                            "manifest_sha256": layout["manifest_sha256"], "elf_path": str(layout["elf_path"].relative_to(REPO)),
                            "elf_sha256": layout["elf_sha256"], "symbols_path": str(layout["symbols_path"].relative_to(REPO)),
                            "symbols_sha256": layout["symbols_sha256"],
                            "segments": [{"name": s["name"], "address": f"{s['address']:08x}", "bytes": s["length"],
                                          "sha256": s["sha256"], "baseline_preimage_sha256": s["preimage_sha256"],
                                          "elf_section": s["elf_section"], "elf_file_offset": s["elf_file_offset"]}
                                         for s in layout["segments"]],
                            "patches": [{"address": f"{p['address']:08x}", "width": p["width"], "role": p["role"],
                                         "before_hex": p["before"].hex(), "after_hex": p["after"].hex(),
                                         "source_section": p["source_section"], "source_file_offset": p["source_file_offset"],
                                         "target_symbol": p["target_symbol"],
                                         "target": None if p["target"] is None else f"{p['target']:08x}"}
                                        for p in layout["patches"]]},
        "decoded_candidate": {"path": sys_final.name, "sha256": sys_readback["sha256"], "bytes": sys_readback["bytes"],
                              "readback": sys_readback},
        "container_candidate": {"path": container_final.name, "sha256": final_container_readback["sha256"],
                                "bytes": final_container_readback["bytes"], "readback": final_container_readback},
        "read_only_base_inputs_unchanged_after_build": unchanged_inputs,
        "remaining_gates": [
            "shared no-growth linker/reservation acceptance is required before treating placement as qualified",
            "same-version installer acceptance is not tested",
            "no target CK802 execution or physical H1E VAD behavior was tested",
            "no hardware boot, power, thermal, or recovery qualification was performed",
            "native provider freshness and VAD/speech meaning remain unverified",
        ],
        "interpretation": "Offline exact-image and ACTTEST0 structure/readback evidence only; no install or release qualification.",
    }
    receipt_path = run_dir / "receipt.json"
    write_exclusive(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode())
    return run_dir, receipt


def baseline_only():
    pins = load_pins()
    decoder = import_pinned("decode_randomizer_393990_baseline", DECODER)
    parser = import_pinned("extract_acttest_393990_baseline", PARSER)
    base = load_baseline(pins, decoder, parser)
    return {"status": "pinned_393990_baseline_readback_passed", "base_container_sha256": sha(base["raw"]),
            "base_container_bytes": len(base["raw"]), "base_system_sha256": sha(base["decoded"]),
            "base_system_bytes": len(base["decoded"]), "boot_sha256": sha(base["boot"]),
            "version_name": VERSION_NAME, "version_code": VERSION_CODE, "board": BOARD,
            "partition_order": PARTITION_ORDER, "baseline_repack": "not run"}


def validate_only(args):
    pins = load_pins()
    decoder = import_pinned("decode_randomizer_393990_validate", DECODER)
    parser = import_pinned("extract_acttest_393990_validate", PARSER)
    baseline = load_baseline(pins, decoder, parser)
    layout = read_layout(args, baseline, pins)
    candidate, _ranges = compose_system(baseline, layout)
    return {"status": "pinned_no_growth_layout_preflight_passed",
            "manifest_sha256": layout["manifest_sha256"], "elf_sha256": layout["elf_sha256"],
            "symbols_sha256": layout["symbols_sha256"], "candidate_system_sha256": sha(candidate),
            "candidate_system_bytes": len(candidate), "growth_bytes": 0,
            "segments": [{"name": s["name"], "address": f"0x{s['address']:08x}",
                          "bytes": s["length"], "sha256": s["sha256"],
                          "preimage_fill": s["preimage_fill"],
                          "preimage_sha256": s["preimage_sha256"],
                          "candidate_window_preimage_sha256": s["window_preimage_sha256"]}
                         for s in layout["segments"]],
            "patch_count": len(layout["patches"]), "patch_bytes": sum(p["width"] for p in layout["patches"]),
            "container_pack": "not run", "candidate_written": False}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--baseline-only", action="store_true", help="verify pinned input only, with no build/repack")
    cli.add_argument("--validate-only", action="store_true", help="validate pinned layout and in-memory composition without writing or packing")
    cli.add_argument("--artifact-root", type=Path, default=VAD / "no-growth-393990-candidate")
    cli.add_argument("--manifest", type=Path, default=VAD / "no-growth-393990-candidate/output/layout-readback.json")
    cli.add_argument("--elf", type=Path, default=VAD / "no-growth-393990-candidate/output/vad-no-growth-393990-NOTINSTALL.elf")
    cli.add_argument("--symbols", type=Path, default=VAD / "no-growth-393990-candidate/output/symbols.txt")
    cli.add_argument("--manifest-sha256")
    cli.add_argument("--elf-sha256")
    cli.add_argument("--symbols-sha256")
    args = cli.parse_args()
    try:
        if args.baseline_only and args.validate_only:
            raise Refused("CHOOSE_ONE_MODE: --baseline-only and --validate-only are mutually exclusive")
        if args.baseline_only:
            result = baseline_only()
        elif args.validate_only:
            for label in ("manifest_sha256", "elf_sha256", "symbols_sha256"):
                need(re.fullmatch(r"[0-9a-f]{64}", getattr(args, label) or "") is not None,
                     "EXTERNAL_PIN_REQUIRED", f"--{label.replace('_', '-')} must be a pinned lowercase SHA-256")
            result = validate_only(args)
        else:
            for label in ("manifest_sha256", "elf_sha256", "symbols_sha256"):
                need(re.fullmatch(r"[0-9a-f]{64}", getattr(args, label) or "") is not None,
                     "EXTERNAL_PIN_REQUIRED", f"--{label.replace('_', '-')} must be a pinned lowercase SHA-256")
            result = run(args)
    except (Refused, OSError, ValueError, KeyError, IndexError, struct.error, subprocess.SubprocessError) as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    if args.baseline_only or args.validate_only:
        print(json.dumps(result, indent=2))
    else:
        run_dir, receipt = result
        print(json.dumps({"status": receipt["status"], "run_dir": str(run_dir),
                          "decoded_sha256": receipt["decoded_candidate"]["sha256"],
                          "container_sha256": receipt["container_candidate"]["sha256"],
                          "bytes": receipt["decoded_candidate"]["bytes"],
                          "container_bytes": receipt["container_candidate"]["bytes"], "NOTINSTALL": True}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
