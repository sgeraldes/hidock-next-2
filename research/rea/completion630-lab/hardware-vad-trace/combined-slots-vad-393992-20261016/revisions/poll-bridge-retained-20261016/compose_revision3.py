#!/usr/bin/env python3
"""Compose one pinned offline slots+VAD ACTTEST candidate (EXPERIMENTAL/NOTINSTALL).

The linker output is a single router-tail module plus ten source-section
instruction windows. This tool verifies the actual new slots SYS, console ELF,
accepted VAD input receipts, linked ELF bytes/targets, exact write-set, inverse,
ACTTEST payloads, identity fields, and CRCs. It performs no device, USB,
network, install, or release operation and never edits its inputs.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve()
REVISION = SCRIPT_PATH.parent
HERE = SCRIPT_PATH.parents[2]
REPO = HERE.parents[4]
COMPLETION = HERE.parents[1]
REA = HERE.parents[2]
FIRMWARE = COMPLETION / "firmware"
BASE_VA = 0x01000000
SEED = 0x08000050
CODE = 393992
NAME = "6.3.8_vad001"
BOARD = "ats2835p_evb"
OLD_CODE = 393990
OLD_NAME = "6.3.6_vectors001"
SYS_BYTES = 1237504
ROUTER_LIVE = (0x01128000, 2613)
ROUTER_WINDOW = (0x01128A40, 1472)
CONSOLE_RANGE = (0x0112B000, 4096)
SYSTEM_HEADER_BYTES = 48
PARTITION_ORDER = ["ota.xml", "zephyr.bin", "RomeApp.bin", "UAC.bin", "IG1202dl.bin", "sdfs.bin", "mbrec.bin"]
CHANGED_PARTS = {"ota.xml", "zephyr.bin", "mbrec.bin"}

BASE_DIR = FIRMWARE / "capture-vector-selected-diagnostic" / "out-NOTINSTALL" / "container-compose3"
BASE_CONTAINER = BASE_DIR / "H1E-6.3.6_vectors001-EXPERIMENTAL-NOT-INSTALL.bin"
BASE_BOOT = BASE_DIR / "boot-decoded.bin"
BASE_SYS = BASE_DIR / "system-decoded.bin"
SLOT_SYS = (FIRMWARE / "capture-stream-slot-exact-image-qa" / "out-NOTINSTALL" /
            "compose-20261016T071238Z-19674" / "system-decoded-NOTINSTALL.bin")
CONSOLE_DIR = FIRMWARE / "capture-stream-slot-diagnostic" / "out-NOTINSTALL" / "slot-run2" / "native"
CONSOLE_ELF = CONSOLE_DIR / "native630.elf"
CONSOLE_BIN = CONSOLE_DIR / "native630.bin"
ROUTER_DIR = REPO / "research" / "rea" / "hardening630-lab" / "fixed-router"
ROUTER_ELF = ROUTER_DIR / "router630.elf"
ROUTER_BIN = ROUTER_DIR / "router630.bin"
OLD_LAYOUT = HERE.parent / "router-only-393990-candidate" / "output" / "layout-readback.json"
OLD_LINK_SCRIPT = HERE.parent / "router-only-393990-candidate" / "router-only.ld"
OLD_COMPOSER = (FIRMWARE / "capture-stream-slot-install-candidate" / "compose_container.py")
RESERVATION_MD = COMPLETION / "application" / "SHARED-MODULE-RESERVATIONS.md"
RESERVATION_JSON = COMPLETION / "application" / "shared-module-reservations.json"
SDK = REA / "references" / "build_atf_image.py"
DECODER = REA / "decode_randomizer.py"
PARSER = REA / "extract_acttest.py"
SDK_PARSER_HELPER = FIRMWARE / "capture-stream-slot-install-candidate" / "parse_with_sdk.mjs"
SDK_SHA = "30b5d37f67bb57af44d02da829429c59bb734d5c7c0acc1a1ce5f15029401c17"
DECODER_SHA = "3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5"
PARSER_SHA = "8adf114c2ee531f12778b346482c344717659a130892515258505781efccc592"
SDK_PARSER_HELPER_SHA = "abbb72734ae7100e5e067a7048a2dfd43a1ecc91f00fe511749c31072334326f"

PINNED = {
    "baseline_container": (BASE_CONTAINER, "d0cd083ff19d56325dca12ea7785c4deb270cf2ef68fa6b7af1c64b0baa651a0"),
    "baseline_boot_decoded": (BASE_BOOT, "7bd8bce552f7a07d3ce5bd5f25a71eb162e46ae71118d4e495e285b6034fc168"),
    "baseline_system_decoded": (BASE_SYS, "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360"),
    "current_slots_system": (SLOT_SYS, "ebee46c51239a4ad971c54cf4b4c12e2a29d516aebd15065ec258de099168771"),
    "current_slots_console_elf": (CONSOLE_ELF, "82f0343772b192a2276461f13824607f00378702221500b61960920822e8b8c0"),
    "current_slots_console_bin": (CONSOLE_BIN, "75631f4f1c65a5b5a8f1b4a2ca4e9288421b05d40d7c1f2fa83a0dc9dc5bc7b1"),
    "fixed_router_elf": (ROUTER_ELF, "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a"),
    "fixed_router_bin": (ROUTER_BIN, "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487"),
    "prior_router_layout": (OLD_LAYOUT, "46b380301df7490743f521f49f5ebd069f5d49c924737b3cbceeb422617fdfd5"),
    "prior_link_script": (OLD_LINK_SCRIPT, "1c322c78281e79bdd8821d9b0f8d6a215d12c0359a3c76516a24e17d69915408"),
    "identity_reference": (OLD_COMPOSER, "069fe4d7aa2cbd50bf56fe5da88c502da21ad51c4a5edad5e6a4bec8820e282b"),
    "reservation_source": (RESERVATION_MD, "f620e81803262ffa71c5c782a6267a258d2855f6417a20781a7d5ec854027196"),
    "reservation_json": (RESERVATION_JSON, "9f9b33715a20428db62f31365acd1f25e61a0e7a3eb9fb505db358f3e72cba00"),
    "sdk_packer": (SDK, SDK_SHA),
    "randomizer_decoder": (DECODER, DECODER_SHA),
    "acttest_parser": (PARSER, PARSER_SHA),
}

LINK_OUT = REVISION / "link" / "output-nonlto-bridge"
ELF = LINK_OUT / "vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"
ELF_MODULE = LINK_OUT / "module-vad-router-tail.bin"
ELF_SYMBOLS = LINK_OUT / "symbols.txt"
ELF_SECTIONS = LINK_OUT / "sections.txt"
ELF_MAP = LINK_OUT / "router-only-nonlto-poll-bridge.map"
LINK_SCRIPT = HERE / "link" / "router-only-combined.ld"
INPUT_DIR = HERE / "inputs"
OBJECT_DIR = INPUT_DIR / "objects"
BRIDGE_OBJECT = LINK_OUT / "h1e_vad_native_poll_nonlto.o"

OBJECT_PINS = {
    "vadt_core.o": "e1700b6d6045ab30109a33cc6bfbe9a72823fe764be2e73187523c64352cbb45",
    "vadt_binding.o": "36b3edfde28409b7625a08e153f3e7018af3e917e8573d03fcb183f4eafd9878",
    "vadt_csky_guard.o": "aed552adcb70c83ac05e30bdbf6a78b7c4c305a11f08ddb2648915a650efe2aa",
    "vadt_frame.o": "a6d66c3e62daec2b5ae42b47488a8cc816f98e3723dd934d082445752e47eba5",
    "vadt_frame_target.o": "1f08d9a2d510f3f689cc41bf329488050b325ba31c00755e977fdd4d2e76210f",
    "h1e_vad_native_poll.o": "fcb93274a8b347dc02725598e26aeccede7006377423f7a66d0e00862592cab0",
    "h1e_vad_native_loader.o": "c7a7b6f8bb4fb7f0b58931d0b4bc991e59be60971d91addc641705e104249a16",
    "f11a_console_dispatch.o": "bb0b9ca5378d16ca4585931f6a1d90e54634fc86b49e792d780d3b1861f85146",
    "console-hooks.o": "46bf2f587bc957868d95e88a888fb67b20c865be3d410c9d6fd2439f8496098a",
    "constructor.o": "2d0d49b72e19d397943409ca073b1ad973c48ae93bc088d24efabec7b240d67d",
    "poll-hook.o": "5770421e88e3e654e24eb9555530f260fbbfc8c3a83d1349d17083afa706ff83",
}

PATCH_SPECS = [
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
EXPECTED_ROOTS = {
    "h1e_vad_native_poll_bridge": 0x01128E34,
    "console630_parser_hook": 0x01128E4C,
    "console630_response_hook": 0x01128E94,
    "late_publication_stub": 0x01128F04,
}
EXPECTED_ALIASES = {"console630_parse_current": 0x0112B70C, "console630_response_current": 0x0112B81C}
INSTRUCTION_REPLACEMENTS = {
    0x01021054: "6030", 0x0102105C: "c36d", 0x0102106A: "1f6c",
    0x0102109E: "6032", 0x010210A8: "df6d", 0x010210DE: "df6c",
}
XML_PART_RE = re.compile(
    rb"(<file_name>([^<]+)</file_name>\s*<file_size>)[^<]+(</file_size>\s*<checksum>)[^<]+(</checksum>)"
)
ALLOWED_BOOT = set(range(20, 24)) | set(range(0xF84, 0xF88)) | set(range(0xF8C, 0xFCC)) | set(range(0xFFC, 0x1000))


class Refused(RuntimeError):
    pass


def need(condition: bool, code: str, detail: str) -> None:
    if not condition:
        raise Refused(f"{code}: {detail}")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(REPO.resolve()).as_posix()


def read_pin(key: str) -> bytes:
    path, expected = PINNED[key]
    need(path.is_file(), "MISSING_INPUT", f"{key}: {path}")
    data = path.read_bytes()
    need(sha(data) == expected, "PIN_MISMATCH", f"{key}: got {sha(data)}, expected {expected}")
    return data


def load_pinned_module(name: str, path: Path, expected_sha: str):
    raw = path.read_bytes()
    need(sha(raw) == expected_sha, "HELPER_PIN", f"{path}")
    spec = importlib.util.spec_from_file_location(name, path)
    need(spec is not None and spec.loader is not None, "HELPER_IMPORT", str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    need(Path(module.__file__).resolve() == path.resolve(), "HELPER_PATH", str(module.__file__))
    return module


def parse_elf(data: bytes):
    need(data[:7] == b"\x7fELF\x01\x01\x01", "ELF_FORMAT", "ELF32 little-endian required")
    e_type, machine = struct.unpack_from("<HH", data, 16)
    shoff = struct.unpack_from("<I", data, 32)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 46)
    need(e_type == 2 and machine == 252 and shentsize == 40 and 0 < shnum < 4096 and shstrndx < shnum,
         "ELF_HEADER", f"type={e_type}, machine={machine}, sections={shnum}")
    raw = [struct.unpack_from("<10I", data, shoff + i * shentsize) for i in range(shnum)]
    names_hdr = raw[shstrndx]
    names = data[names_hdr[4]:names_hdr[4] + names_hdr[5]]
    sections = {}
    for index, (name, kind, flags, address, offset, size, link, info, align, entsize) in enumerate(raw):
        need(kind == 8 or offset + size <= len(data), "ELF_SECTION_RANGE", str(index))
        label = names[name:].split(b"\0", 1)[0].decode("ascii") if name < len(names) else ""
        need(label not in sections, "ELF_SECTION_DUPLICATE", label)
        sections[label] = {"index": index, "type": kind, "flags": flags, "address": address,
                           "offset": offset, "size": size, "link": link, "info": info,
                           "alignment": align, "entry_size": entsize}
    symsec = sections.get(".symtab")
    need(symsec is not None and symsec["entry_size"] == 16, "ELF_SYMBOL_TABLE", "expected ELF32 symtab")
    strsec = next((s for s in sections.values() if s["index"] == symsec["link"]), None)
    need(strsec is not None, "ELF_STRING_TABLE", "missing .symtab linked strings")
    strings = data[strsec["offset"]:strsec["offset"] + strsec["size"]]
    symbols = {}
    undefined = []
    for off in range(symsec["offset"], symsec["offset"] + symsec["size"], symsec["entry_size"]):
        name_off, value, size, info, _other, shndx = struct.unpack_from("<IIIBBH", data, off)
        name = strings[name_off:].split(b"\0", 1)[0].decode("ascii") if name_off < len(strings) else ""
        if not name:
            continue
        symbols[name] = {"address": value, "size": size, "info": info, "section_index": shndx}
        if shndx == 0 and info >> 4 in (1, 2):
            undefined.append(name)
    return sections, symbols, undefined


def get_section(data: bytes, section: dict) -> bytes:
    return data[section["offset"]:section["offset"] + section["size"]]


def decode_bsr(raw: bytes, address: int) -> int:
    need(len(raw) == 4, "BSR_WIDTH", f"{address:#x}")
    word = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    need(word >> 26 == 0x38, "BSR_OPCODE", f"{address:#x} bytes={raw.hex()}")
    disp = word & 0x03FFFFFF
    if disp & 0x02000000:
        disp -= 0x04000000
    return address + disp * 2


def slice_va(data: bytes, address: int, length: int) -> bytes:
    off = address - BASE_VA
    need(off >= 0 and off + length <= len(data), "VA_RANGE", f"{address:#x}+{length}")
    return data[off:off + length]


def parse_symbols_text(data: bytes) -> dict[str, int]:
    result = {}
    for line in data.decode("ascii").splitlines():
        fields = line.split()
        if len(fields) == 3 and re.fullmatch(r"[0-9a-fA-F]+", fields[0]):
            result[fields[2]] = int(fields[0], 16)
    return result


def diff_runs(before: bytes, after: bytes) -> tuple[list[int], list[tuple[int, int]]]:
    need(len(before) == len(after), "DIFF_LENGTH", f"{len(before)} != {len(after)}")
    changed = [i for i, (a, b) in enumerate(zip(before, after)) if a != b]
    runs = []
    if changed:
        start = prev = changed[0]
        for pos in changed[1:]:
            if pos == prev + 1:
                prev = pos
            else:
                runs.append((start, prev + 1))
                start = prev = pos
        runs.append((start, prev + 1))
    return changed, runs


def raw_parse_container(data: bytes) -> list[dict]:
    need(len(data) >= 512 and data[:8] == b"ACTTEST0", "CONTAINER_MAGIC", "ACTTEST0 header missing")
    header_crc, count = struct.unpack_from("<IB", data, 8)
    version, total, data_crc = struct.unpack_from("<III", data, 16)
    need(data[13:16] == bytes(3) and data[28:32] == bytes(4), "CONTAINER_RESERVED", "nonzero reserved bytes")
    need(version == 0x01000000 and total == len(data) and 1 <= count <= 15, "CONTAINER_HEADER", "version/length/count")
    need(zlib.crc32(data[12:512]) == header_crc, "CONTAINER_HEADER_CRC", "mismatch")
    need(zlib.crc32(data[512:]) == data_crc, "CONTAINER_DATA_CRC", "mismatch")
    need(data[32 + 32 * count:512] == bytes(512 - 32 - 32 * count), "CONTAINER_DIR_PADDING", "nonzero padding")
    entries = []
    cursor = 512
    for i in range(count):
        raw_name, load, offset, size, run, crc = struct.unpack_from("<12sIIIII", data, 32 + 32 * i)
        label = raw_name.rstrip(b"\0")
        need(raw_name == label.ljust(12, b"\0") and re.fullmatch(rb"[A-Za-z0-9_.-]+", label), "CONTAINER_NAME", str(i))
        need(offset == cursor and size > 0 and offset + size <= len(data), "CONTAINER_LAYOUT", label.decode())
        payload = data[offset:offset + size]
        need(zlib.crc32(payload) == crc, "CONTAINER_ENTRY_CRC", label.decode())
        end = offset + size + 512 - size % 512
        need(data[offset + size:end] == b"\xff" * (end - offset - size), "CONTAINER_ENTRY_PADDING", label.decode())
        entries.append({"name": label.decode(), "load": load, "run": run, "offset": offset, "size": size,
                        "crc32": crc, "sha256": sha(payload)})
        cursor = end
    need(cursor == len(data), "CONTAINER_TRAILING", f"parsed through {cursor}/{len(data)}")
    return entries


def xml_summary(raw: bytes) -> dict:
    root = ET.fromstring(raw)
    parts = {}
    for part in root.findall("./partitions/partition"):
        parts[part.findtext("file_name")] = {
            key: part.findtext(key) for key in ("type", "name", "file_id", "file_size", "checksum")
        }
    return {"version_code": root.findtext("./firmware_version/version_code"),
            "version_name": root.findtext("./firmware_version/version_name"),
            "board": root.findtext("./firmware_version/board_name"),
            "ota_version_check": root.findtext("./firmware_version/ota_version_check"),
            "partitionsNum": root.findtext("./partitions/partitionsNum"), "partitions": parts}


def boot_identity(boot: bytes, name: str, code: int, image_header, sum16) -> bytes:
    need(len(boot) == 4096 and boot[0xF80:0xF84] == b"FVER", "BOOT_FVER", "bad FVER block")
    need(zlib.crc32(boot[0xF80:0xFFC]) == struct.unpack_from("<I", boot, 0xFFC)[0], "BOOT_FVER_CRC", "invalid before update")
    before_header = image_header(boot)
    out = bytearray(boot)
    struct.pack_into("<I", out, 0xF84, code)
    out[0xF8C:0xFCC] = name.encode("ascii").ljust(64, b"\0")
    struct.pack_into("<I", out, 0xFFC, zlib.crc32(out[0xF80:0xFFC]))
    header_size, body_size = before_header["header_size"], before_header["body_size"]
    struct.pack_into("<H", out, 22, (0xFFFF - sum16(out[header_size:header_size + body_size])) & 0xFFFF)
    struct.pack_into("<H", out, 20, 0)
    struct.pack_into("<H", out, 20, (0xFFFF - sum16(out[:header_size])) & 0xFFFF)
    need(image_header(bytes(out)) == before_header, "BOOT_ACTH_HEADER", "identity update changed header geometry")
    need(all(a == b or i in ALLOWED_BOOT for i, (a, b) in enumerate(zip(boot, out))),
         "BOOT_ALLOWED_RANGES", "boot changed outside version/checksum windows")
    return bytes(out)


def build_xml(old: bytes, code: int, name: str, size_crc: dict[str, tuple[int, int]]) -> bytes:
    new, count = re.subn(rb"(<version_code>)[^<]+(</version_code>)",
                         lambda m: m.group(1) + ("0x%x" % code).encode() + m.group(2), old)
    need(count == 1, "XML_VERSION_CODE", f"matched {count}")
    new, count = re.subn(rb"(<version_name>)[^<]+(</version_name>)",
                         lambda m: m.group(1) + name.encode("ascii") + m.group(2), new)
    need(count == 1, "XML_VERSION_NAME", f"matched {count}")
    for filename, (size, crc) in size_crc.items():
        pat = rb"(<file_name>" + re.escape(filename.encode("ascii")) + rb"</file_name>\s*<file_size>)[^<]+(</file_size>\s*<checksum>)[^<]+(</checksum>)"
        new, count = re.subn(pat, lambda m: m.group(1) + ("0x%x" % size).encode() + m.group(2) +
                             ("0x%08x" % crc).encode() + m.group(3), new)
        need(count == 1, "XML_PARTITION_CRC", f"{filename}: matched {count}")
    need(len(new) <= len(old), "XML_CAPACITY", f"new XML {len(new)} > baseline {len(old)}")
    # The version is shorter; preserve the exact ACTTEST directory partition size
    # and all following offsets with legal trailing XML whitespace.
    new += b" " * (len(old) - len(new))
    need(len(new) == len(old), "XML_LENGTH", "directory payload size changed")
    ET.fromstring(new)
    return new


def load_source_receipts() -> dict:
    accepted_path = INPUT_DIR / "accepted-vad-inputs.json"
    before_path = INPUT_DIR / "input-pins-before.json"
    after_path = INPUT_DIR / "input-pins-after.json"
    accepted_raw, before_raw, after_raw = accepted_path.read_bytes(), before_path.read_bytes(), after_path.read_bytes()
    accepted = json.loads(accepted_raw)
    before, after = json.loads(before_raw), json.loads(after_raw)
    need(sha(accepted_raw) == "24c97109ea79776cb7b1045acbf78865b528f78b493208840692693555051c70",
         "VAD_SOURCE_RECEIPT", "accepted source receipt pin changed")
    need(sha(before_raw) == "2278b2177e9efb59f650757c99bda285431519093c1a5f578ca2375802695f81",
         "VAD_INPUT_RECEIPT", "input-pins-before receipt pin changed")
    need(before_raw == after_raw, "VAD_INPUT_RECEIPT", "before/after source pins differ")
    need(accepted.get("match") is True and accepted.get("changed") == {} and
         accepted.get("pinned_count") == 36 and before.get("accepted_source_pin_count") == 36 and
         before.get("firmware_image_generated") is False and before.get("composed") is False,
         "VAD_SOURCE_RECEIPT", "accepted source/link receipt does not match its expected offline profile")
    hashes = accepted.get("hashes")
    need(isinstance(hashes, dict) and len(hashes) == 36, "VAD_SOURCE_HASHES", "expected 36 accepted source pins")
    observed = []
    for raw_path, expected in hashes.items():
        path = Path(raw_path)
        if not path.is_absolute():
            path = REPO / path
        # The accepted receipt records WSL paths; translate only that known mount.
        if not path.exists() and raw_path.startswith("/mnt/g/Code/hidock-next-2/"):
            path = REPO / raw_path.removeprefix("/mnt/g/Code/hidock-next-2/")
        need(path.is_file(), "VAD_SOURCE_MISSING", raw_path)
        actual = sha(path.read_bytes())
        need(actual == expected, "VAD_SOURCE_CHANGED", f"{raw_path}: {actual} != {expected}")
        observed.append({"path": rel(path), "sha256": actual})
    return {"accepted_receipt": {"path": rel(accepted_path), "sha256": sha(accepted_raw), "pinned_count": 36},
            "before_receipt": {"path": rel(before_path), "sha256": sha(before_raw)},
            "after_receipt": {"path": rel(after_path), "sha256": sha(after_raw)},
            "current_source_hashes_rechecked": len(observed), "current_source_hashes": observed}


def main() -> int:
    out_dir = REVISION / "out-NOTINSTALL" / "compose-3"
    receipts = REVISION / "receipts" / "compose-3"
    need(not out_dir.exists(), "OUTPUT_EXISTS", str(out_dir))
    for name in ("layout-readback.json", "composition-readback.json", "container-readback.json", "final-receipt.json"):
        need(not (receipts / name).exists(), "RECEIPT_EXISTS", name)

    pinned_bytes = {key: read_pin(key) for key in PINNED}
    baseline_container = pinned_bytes["baseline_container"]
    baseline_boot = pinned_bytes["baseline_boot_decoded"]
    baseline_sys = pinned_bytes["baseline_system_decoded"]
    current_sys = pinned_bytes["current_slots_system"]
    router_elf = pinned_bytes["fixed_router_elf"]
    router_bin = pinned_bytes["fixed_router_bin"]
    console_elf = pinned_bytes["current_slots_console_elf"]
    console_bin = pinned_bytes["current_slots_console_bin"]
    old_layout = json.loads(pinned_bytes["prior_router_layout"])

    # Check the frozen producer inputs and exact LTO object set before reading ELF bytes.
    source_receipts = load_source_receipts()
    objects = {}
    for name, expected in OBJECT_PINS.items():
        path = BRIDGE_OBJECT if name == "h1e_vad_native_poll.o" else OBJECT_DIR / name
        need(path.is_file(), "LINK_OBJECT_MISSING", name)
        raw = path.read_bytes()
        need(sha(raw) == expected, "LINK_OBJECT_PIN", f"{name}: {sha(raw)}")
        objects[name] = {"path": rel(path), "bytes": len(raw), "sha256": sha(raw)}
    link_script = LINK_SCRIPT.read_bytes()
    prior_link_script = pinned_bytes["prior_link_script"]
    need(prior_link_script.count(b"PROVIDE(console630_response_current = 0x0112b800);") == 1 and
         link_script == prior_link_script.replace(b"PROVIDE(console630_response_current = 0x0112b800);",
                                                   b"PROVIDE(console630_response_current = 0x0112b81c);"),
         "LINKER_SCRIPT_DELTA", "only the slots response alias may differ from the accepted profile")
    need(b"PROVIDE(console630_parse_current = 0x0112b70c);" in link_script and
         b"PROVIDE(console630_response_current = 0x0112b81c);" in link_script and
         b"PROVIDE(console630_response_current = 0x0112b800);" not in link_script,
         "LINKER_ALIAS", "new link must bind only parser b70c and response b81c")
    elf = ELF.read_bytes()
    module_export = ELF_MODULE.read_bytes()
    sym_text = ELF_SYMBOLS.read_bytes()
    sections_text = ELF_SECTIONS.read_bytes()
    elf_sections, elf_symbols, undefined = parse_elf(elf)
    symbols = parse_symbols_text(sym_text)
    need(not undefined and not (LINK_OUT / "undefined.txt").read_bytes(), "ELF_UNDEFINED", "link has unresolved symbols")
    need(sha(elf) == "50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80",
         "ELF_PIN", f"unexpected linked ELF {sha(elf)}")

    # Cross-check live router and current slots-console code against the pinned SYS.
    router_sections, _router_symbols, router_undef = parse_elf(router_elf)
    need(not router_undef and ".text" in router_sections, "ROUTER_ELF", "missing fixed-router text")
    router_text = router_sections[".text"]
    need(router_text["address"] == ROUTER_LIVE[0] and router_text["size"] == ROUTER_LIVE[1],
         "ROUTER_EXTENT", str(router_text))
    need(get_section(router_elf, router_text) == router_bin == slice_va(current_sys, *ROUTER_LIVE),
         "ROUTER_LIVE", "current SYS router bytes do not match the fixed router ELF/BIN")
    live_router_end = ROUTER_LIVE[0] + ROUTER_LIVE[1]
    candidate_start, candidate_window_len = ROUTER_WINDOW
    candidate_window = slice_va(current_sys, candidate_start, candidate_window_len)
    need(live_router_end <= candidate_start and set(candidate_window) == {0xFF} and
         sha(candidate_window) == "d681b2309c3b48684ac24e27fafa6f215a294dc75bcbbf5fbfb4bbaacaed0e07",
         "ROUTER_RESERVATION_PREIMAGE", "exact granted router-tail window preimage mismatch")
    console_slice = slice_va(current_sys, *CONSOLE_RANGE)
    console_sections, console_symbols, console_undefined = parse_elf(console_elf)
    need(not console_undefined and ".text" in console_sections, "CONSOLE_ELF", "console ELF missing .text or has undefineds")
    console_text = console_sections[".text"]
    need(console_text["address"] == CONSOLE_RANGE[0] and console_text["size"] == len(console_bin) == 3620,
         "CONSOLE_EXTENT", str(console_text))
    need(get_section(console_elf, console_text) == console_bin == console_slice[:len(console_bin)],
         "CONSOLE_LIVE", "console ELF/BIN differs from the current SYS")
    need(len(console_slice) == CONSOLE_RANGE[1] and console_slice[len(console_bin):] == bytes(CONSOLE_RANGE[1] - len(console_bin)),
         "CONSOLE_RESERVED_BASELINE", "current 4 KiB console reservation must retain its exact current tail")
    console_function_info = {}
    for symbol_name, alias_name, expected in (
        ("console630_parse", "console630_parse_current", 0x0112B70C),
        ("console630_response", "console630_response_current", 0x0112B81C),
    ):
        sym = console_symbols.get(symbol_name)
        need(sym is not None and sym["address"] == expected and sym["size"] > 0,
             "CONSOLE_SYMBOL", f"{symbol_name} expected at {expected:#x}, got {sym}")
        need(elf_symbols.get(alias_name, {}).get("address") == expected and symbols.get(alias_name) == expected,
             "CONSOLE_ALIAS", f"{alias_name} did not resolve to {expected:#x}")
        offset = expected - console_text["address"]
        function = get_section(console_elf, console_text)[offset:offset + sym["size"]]
        need(function == slice_va(current_sys, expected, sym["size"]), "CONSOLE_FUNCTION_LIVE", symbol_name)
        console_function_info[symbol_name] = {"address": f"0x{expected:08x}", "size": sym["size"],
                                             "sha256": sha(function), "alias": alias_name}
    for symbol_name, expected in (("console630_parser_hook", 0x0112BA58),
                                  ("console630_response_hook", 0x0112BAA0)):
        sym = console_symbols.get(symbol_name)
        need(sym is not None and sym["address"] == expected,
             "CONSOLE_HOOK_SYMBOL", f"{symbol_name} expected at {expected:#x}, got {sym}")
        offset = expected - console_text["address"]
        anchor_bytes = max(sym["size"], 4)
        hook_bytes = get_section(console_elf, console_text)[offset:offset + anchor_bytes]
        need(len(hook_bytes) == anchor_bytes and hook_bytes == slice_va(current_sys, expected, anchor_bytes),
             "CONSOLE_HOOK_LIVE", symbol_name)
        console_function_info[symbol_name] = {"address": f"0x{expected:08x}", "symbol_size": sym["size"],
                                             "readback_anchor_bytes": anchor_bytes,
                                             "sha256": sha(hook_bytes), "unchanged": True}

    # Verify new link profile, module range, actual aliases, roots and patch bytes.
    module_sec = elf_sections.get(".router_tail")
    need(module_sec is not None and module_sec["address"] == candidate_start and
         0 < module_sec["size"] <= candidate_window_len and get_section(elf, module_sec) == module_export,
         "ROUTER_MODULE", "actual linked module does not fit/export the granted window")
    need(module_sec["size"] == 1248 and sha(module_export) == "72c1fd09dfae86bbb4691b9b713c92e32685b1a5ccbb8f2e6b2406ec53115647",
         "ROUTER_MODULE_PIN", f"length={module_sec['size']} sha={sha(module_export)}")
    need(".console_tail" not in elf_sections and elf_sections.get(".data", {}).get("size", 0) == 0 and
         elf_sections.get(".bss", {}).get("size", 0) == 0, "ELF_SECTIONS", "unexpected console-tail or writable state")
    need(re.search(rb'Tag_CSKY_CPU_NAME:\s*"ck802"', sections_text) is not None,
         "ELF_CPU", "linked ELF is not CK802")
    need(len(sym_text) > 0 and all(symbols.get(name) == value for name, value in EXPECTED_ALIASES.items()),
         "ELF_ALIASES", repr({k: symbols.get(k) for k in EXPECTED_ALIASES}))
    for name, value in EXPECTED_ROOTS.items():
        need(elf_symbols.get(name, {}).get("address") == value and symbols.get(name) == value,
             "ELF_ROOT", f"{name}: expected {value:#x}, got {symbols.get(name)}")
        need(candidate_start <= value < candidate_start + module_sec["size"], "ELF_ROOT_RANGE", name)
    need(elf_sections.get(".constructor_edits", {}).get("size") == 140, "CONSTRUCTOR_SECTION", "size changed")

    old_patches = {int(p["address"], 16): p for p in old_layout.get("patches", [])}
    need(len(old_patches) == 10, "PRIOR_PATCH_SET", "accepted prior router-only manifest does not have 10 windows")
    patches = []
    written_ranges = [(candidate_start, candidate_start + module_sec["size"])]
    for address, width, section_name, role, target_symbol in PATCH_SPECS:
        section = elf_sections.get(section_name)
        need(section is not None and section["address"] <= address and address + width <= section["address"] + section["size"],
             "PATCH_SECTION", f"{role} not backed by {section_name}")
        relative = address - section["address"]
        replacement = get_section(elf, section)[relative:relative + width]
        before = slice_va(current_sys, address, width)
        prior = old_patches.get(address)
        need(prior is not None and before.hex() == prior["before_hex"], "PATCH_PREIMAGE", f"{role}: {before.hex()}")
        need(before != replacement, "PATCH_NOOP", role)
        if address in INSTRUCTION_REPLACEMENTS:
            need(replacement.hex() == INSTRUCTION_REPLACEMENTS[address], "CONSTRUCTOR_OPCODE", f"{role}: {replacement.hex()}")
        row = {"address": f"0x{address:08x}", "width": width, "role": role,
               "before_hex": before.hex(), "before_sha256": sha(before),
               "replacement_hex": replacement.hex(), "replacement_sha256": sha(replacement),
               "source_elf_section": section_name, "elf_section_offset": relative,
               "elf_file_offset": section["offset"] + relative,
               "matches_393990_patch_preimage": before.hex() == prior["before_hex"]}
        if target_symbol:
            target = decode_bsr(replacement, address)
            expected = EXPECTED_ROOTS[target_symbol]
            need(target == expected and elf_symbols[target_symbol]["address"] == target,
                 "PATCH_BRANCH_TARGET", f"{role}: decoded {target:#x}, symbol {target_symbol}={expected:#x}")
            row.update({"target_symbol": target_symbol, "target_address": f"0x{target:08x}",
                        "decoded_bsr_target_from_raw_bytes": f"0x{target:08x}", "branch_readback_passed": True})
        written_ranges.append((address, address + width))
        patches.append(row)
    need(len(patches) == 10 and sum(p["width"] for p in patches) == 28, "PATCH_SET", "expected 10 windows / 28 bytes")
    need(all(a[1] <= b[0] for a, b in zip(sorted(written_ranges), sorted(written_ranges)[1:])),
         "WRITE_OVERLAP", "candidate module and patch windows overlap")
    need(all(not (a < CONSOLE_RANGE[0] + CONSOLE_RANGE[1] and b > CONSOLE_RANGE[0]) for a, b in written_ranges),
         "CONSOLE_WRITE_DISJOINT", "write set overlaps current 4 KiB console reservation")
    for address, before in [(0x01020B62, "ffe303f8"), (0x01021054, None), (0x0102105C, None),
                            (0x0102106A, None), (0x01021070, None), (0x0102109E, None),
                            (0x010210A8, None), (0x010210DE, None), (0x0103907A, "07e01395"),
                            (0x0103A996, "07e06188")]:
        if before:
            need(next(p for p in patches if int(p["address"], 16) == address)["before_hex"] == before,
                 "CURRENT_HOOK_PREIMAGE", f"{address:#x}")

    # Compose only the measured module and the ten exact source-section windows.
    candidate = bytearray(current_sys)
    module_pre = slice_va(current_sys, candidate_start, module_sec["size"])
    need(set(module_pre) == {0xFF}, "MODULE_PREIMAGE", "module-size range not uniform FF")
    candidate[candidate_start - BASE_VA:candidate_start - BASE_VA + module_sec["size"]] = module_export
    for patch in patches:
        address, width = int(patch["address"], 16), patch["width"]
        off = address - BASE_VA
        before = bytes(candidate[off:off + width])
        need(before.hex() == patch["before_hex"], "PATCH_WRITE_PREIMAGE", patch["role"])
        candidate[off:off + width] = bytes.fromhex(patch["replacement_hex"])
    candidate = bytes(candidate)
    need(len(candidate) == len(current_sys) == SYS_BYTES, "SYS_LENGTH", str(len(candidate)))
    need(candidate[:SYSTEM_HEADER_BYTES] == current_sys[:SYSTEM_HEADER_BYTES], "SYS_HEADER", "inner header changed")
    need(slice_va(candidate, *CONSOLE_RANGE) == console_slice, "CONSOLE_PRESERVED", "4096-byte console range changed")
    need(slice_va(candidate, *ROUTER_LIVE) == router_bin, "ROUTER_LIVE_PRESERVED", "live router changed")
    changed, runs = diff_runs(current_sys, candidate)
    allowed = written_ranges
    need(changed and all(any(a <= BASE_VA + i < b for a, b in allowed) for i in changed),
         "SYS_WRITE_SET", "actual SYS changes escaped the module + ten patch windows")
    inverse = bytearray(candidate)
    inverse[candidate_start - BASE_VA:candidate_start - BASE_VA + module_sec["size"]] = module_pre
    for patch in patches:
        address, width = int(patch["address"], 16), patch["width"]
        inverse[address - BASE_VA:address - BASE_VA + width] = bytes.fromhex(patch["before_hex"])
    need(bytes(inverse) == current_sys and sha(bytes(inverse)) == PINNED["current_slots_system"][1],
         "SYS_INVERSE", "patch inverse does not reconstruct exact slots SYS")

    # Parse the original installed-identity container and derive the requested
    # 393992 / 6.3.8_vad001 identity. No baseline control repack is performed.
    decoder = load_pinned_module("combined_slots_decoder", DECODER, DECODER_SHA)
    parser = load_pinned_module("combined_slots_parser", PARSER, PARSER_SHA)
    parsed = parser.parse(baseline_container)
    base_entries = raw_parse_container(baseline_container)
    need([e["name"] for e in base_entries] == PARTITION_ORDER, "BASE_PARTITIONS", repr(base_entries))
    need(parsed["version"] == OLD_NAME and parsed["board"] == BOARD, "BASE_IDENTITY", "wrong original container identity")
    by_name = {e["name"]: e for e in base_entries}
    payloads = {e["name"]: baseline_container[e["offset"]:e["offset"] + e["size"]] for e in base_entries}
    old_boot = decoder.transform(payloads["mbrec.bin"], SEED)
    old_sys = decoder.transform(payloads["zephyr.bin"], SEED)
    need(old_boot == baseline_boot and old_sys == baseline_sys, "BASE_DECODE", "pinned original decoded bytes mismatch")
    need(decoder.image_header(candidate, True) == decoder.image_header(old_sys, True),
         "SYS_INNER_HEADER", "candidate no longer carries baseline inner header")
    need(old_boot[0xF80:0xF84] == b"FVER" and struct.unpack_from("<I", old_boot, 0xF84)[0] == OLD_CODE and
         old_boot[0xF8C:0xFCC] == OLD_NAME.encode().ljust(64, b"\0"), "BASE_BOOT_IDENTITY", "baseline identity mismatch")
    new_boot = boot_identity(old_boot, NAME, CODE, decoder.image_header, decoder.sum16)
    new_system_partition = decoder.transform(candidate, SEED, decrypt=False)
    new_boot_partition = decoder.transform(new_boot, SEED, decrypt=False)
    new_xml = build_xml(payloads["ota.xml"], CODE, NAME,
                        {"zephyr.bin": (len(new_system_partition), zlib.crc32(new_system_partition)),
                         "mbrec.bin": (len(new_boot_partition), zlib.crc32(new_boot_partition))})
    old_xml_summary, new_xml_summary = xml_summary(payloads["ota.xml"]), xml_summary(new_xml)
    need(old_xml_summary["version_name"] == OLD_NAME and int(old_xml_summary["version_code"], 0) == OLD_CODE,
         "BASE_XML_IDENTITY", "baseline XML identity mismatch")
    need(new_xml_summary["version_name"] == NAME and int(new_xml_summary["version_code"], 0) == 0x60308 and
         new_xml_summary["board"] == BOARD, "NEW_XML_IDENTITY", repr(new_xml_summary))
    need(old_xml_summary["board"] == new_xml_summary["board"] and
         old_xml_summary["ota_version_check"] == new_xml_summary["ota_version_check"] and
         old_xml_summary["partitionsNum"] == new_xml_summary["partitionsNum"] and
         set(old_xml_summary["partitions"]) == set(new_xml_summary["partitions"]),
         "XML_METADATA", "unrequested metadata changed")
    for name in old_xml_summary["partitions"]:
        if name not in ("zephyr.bin", "mbrec.bin"):
            for key in ("type", "name", "file_id", "file_size", "checksum"):
                need(old_xml_summary["partitions"][name][key] == new_xml_summary["partitions"][name][key],
                     "XML_UNCHANGED_PARTITION", f"{name}/{key}")
    for name in ("zephyr.bin", "mbrec.bin"):
        for key in ("type", "name", "file_id", "file_size"):
            need(old_xml_summary["partitions"][name][key] == new_xml_summary["partitions"][name][key],
                 "XML_PARTITION_METADATA", f"{name}/{key}")
    need(len(new_xml) == len(payloads["ota.xml"]), "XML_PARTITION_SIZE", "must preserve ACTTEST directory size")

    new_payloads = dict(payloads)
    new_payloads["zephyr.bin"] = new_system_partition
    new_payloads["mbrec.bin"] = new_boot_partition
    new_payloads["ota.xml"] = new_xml
    need(decoder.transform(new_payloads["zephyr.bin"], SEED) == candidate and
         decoder.transform(new_payloads["mbrec.bin"], SEED) == new_boot,
         "PARTITION_ROUNDTRIP", "encoded partition did not decode to staged bytes")

    # Record a fully bound source layout before pack, including complete console bytes.
    source_hashes = {name: {"path": rel(path), "sha256": sha(raw), "bytes": len(raw)}
                     for name, (path, _expected) in PINNED.items()
                     for raw in (pinned_bytes[name],)}
    layout = {
        "schema": "h1e-vad-combined-slots-393992-layout-v1",
        "status": "offline_candidate_layout_verified_NOTINSTALL",
        "baseline": {"path": rel(SLOT_SYS), "sha256": sha(current_sys), "bytes": len(current_sys), "load_base": "0x01000000"},
        "router_allocation": {"reservation_start": "0x01128000", "reservation_end": "0x01129000",
                              "candidate_start": "0x01128a40", "candidate_end": "0x01129000",
                              "candidate_window_bytes": 1472, "ownership_granted_for_offline_candidate": True,
                              "grant_evidence_refs": [
                                  "research/rea/completion630-lab/application/SHARED-MODULE-RESERVATIONS.md",
                                  "research/rea/completion630-lab/application/shared-module-reservations.json"],
                              "baseline_full_window_sha256": sha(candidate_window), "baseline_fill": "ff"},
        "link": {"elf_path": rel(ELF), "elf_sha256": sha(elf), "elf_bytes": len(elf),
                 "module_path": rel(ELF_MODULE), "module_sha256": sha(module_export), "module_bytes": len(module_export),
                 "linker_script_path": rel(LINK_SCRIPT), "linker_script_sha256": sha(link_script),
                 "map_path": rel(ELF_MAP), "map_sha256": sha(ELF_MAP.read_bytes()),
                 "symbols_path": rel(ELF_SYMBOLS), "symbols_sha256": sha(sym_text),
                 "profile": {"compiler_family": "T-HEAD C-SKY V3.10.29 / GCC 6.3.0",
                             "target": "csky-elfabiv2", "cpu": "CK802", "sdk_c_flags": ["-mcpu=ck802", "-Os",
                             "-fshort-enums", "-fsigned-char", "-fno-common", "-fno-delete-null-pointer-checks"],
                             "lto_flags": ["-ffunction-sections", "-fdata-sections", "-flto"],
                             "link_flags": ["-fuse-linker-plugin", "-nostdlib", "-Wl,--gc-sections"],
                             "input_objects": objects, "source_recompile_in_this_task": True,
                             "poll_bridge_translation_unit": {"object_path": rel(BRIDGE_OBJECT),
                                 "object_sha256": sha(BRIDGE_OBJECT.read_bytes()),
                                 "compile_override": ["-ffunction-sections", "-fdata-sections", "-fno-lto"],
                                 "reason": "The retained LTO object produced an empty bridge function; the exact non-LTO wrapper has a 24-byte body and its undefined binding reference retains the LTO call graph."}}},
        "current_console": {"elf_path": rel(CONSOLE_ELF), "elf_sha256": sha(console_elf),
                            "module_path": rel(CONSOLE_BIN), "module_sha256": sha(console_bin),
                            "reservation_start": "0x0112b000", "reservation_length": 4096,
                            "reservation_sha256": sha(console_slice), "reservation_bytes_hex": console_slice.hex(),
                            "preserved_after_composition": True, "symbols": console_function_info,
                            "aliases": {name: f"0x{address:08x}" for name, address in EXPECTED_ALIASES.items()}},
        "fixed_router_live": {"address": f"0x{ROUTER_LIVE[0]:08x}", "bytes": ROUTER_LIVE[1],
                              "sha256": sha(router_bin), "preserved_after_composition": True},
        "module_segment": {"name": ".router_tail", "address": f"0x{module_sec['address']:08x}",
                           "length": module_sec["size"], "elf_file_offset": module_sec["offset"],
                           "sha256": sha(module_export), "baseline_preimage_hex": module_pre.hex(),
                           "baseline_preimage_sha256": sha(module_pre), "preimage_fill": "ff"},
        "roots": {name: f"0x{symbols[name]:08x}" for name in EXPECTED_ROOTS},
        "patches": patches,
        "checks": {"all_targets_decoded_from_actual_elf_bytes": True, "patch_count": len(patches),
                   "patch_bytes": sum(p["width"] for p in patches), "no_console_tail": True,
                   "undefined_symbols": len(undefined), "data_bytes": elf_sections.get(".data", {}).get("size", 0),
                   "bss_bytes": elf_sections.get(".bss", {}).get("size", 0),
                   "full_console_write_set_disjoint": True, "composition_readback_pending": True,
                   "ownership_is_install_authorization": False, "install_authorized": False,
                   "installed": False, "hardware_tested": False},
        "source_receipts": source_receipts,
        "pinned_inputs": source_hashes,
        "limits": "Parent-granted router reservation is used for this offline candidate. It does not imply target qualification, physical VAD semantics, install authorization, release or hardware acceptance.",
    }

    # One fresh decoded SYS plus exact inverse/readback.
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir()
    system_path = out_dir / "system-decoded-NOTINSTALL.bin"
    system_path.write_bytes(candidate)
    need(system_path.read_bytes() == candidate and sha(system_path.read_bytes()) == sha(candidate), "SYS_DISK_READBACK", str(system_path))
    need(slice_va(system_path.read_bytes(), *CONSOLE_RANGE) == console_slice, "CONSOLE_DISK_READBACK", "current 4 KiB changed")
    layout["checks"]["composition_readback_pending"] = False
    layout["checks"]["full_console_post_composition_verified"] = True
    layout_path = receipts / "layout-readback.json"
    layout_path.parent.mkdir(parents=True, exist_ok=True)
    layout_path.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")

    diff_records = [{"start_offset": f"0x{a:x}", "end_offset_exclusive": f"0x{b:x}",
                     "length": b - a, "baseline_sha256": sha(current_sys[a:b]), "candidate_sha256": sha(candidate[a:b])}
                    for a, b in runs]
    composition = {
        "schema": "h1e-vad-combined-slots-393992-system-readback-v1",
        "status": "offline_decoded_system_composed_readback_verified_NOTINSTALL",
        "baseline": {"path": rel(SLOT_SYS), "sha256": sha(current_sys), "bytes": len(current_sys)},
        "candidate": {"path": rel(system_path), "sha256": sha(candidate), "bytes": len(candidate)},
        "module_write": {"address": "0x01128a40", "bytes": len(module_export), "sha256": sha(module_export)},
        "patches": patches,
        "actual_changed_byte_count": len(changed), "actual_changed_runs": diff_records,
        "actual_changes_confined_to_module_and_ten_windows": True,
        "inverse_reconstructs_exact_current_slots_system": True,
        "console_reserved_range": {"address": "0x0112b000", "bytes": len(console_slice),
                                    "sha256": sha(console_slice), "before_after_equal": True},
        "router_live_range": {"address": "0x01128000", "bytes": len(router_bin), "sha256": sha(router_bin),
                              "before_after_equal": True},
        "no_system_growth": True, "no_header_change": True,
    }
    comp_path = receipts / "composition-readback.json"
    comp_path.write_text(json.dumps(composition, indent=2) + "\n", encoding="utf-8")

    if "--system-only" in sys.argv[1:]:
        print(f"ELF {sha(elf)}; module {sha(module_export)} ({len(module_export)} bytes)")
        print(f"SYS {sha(candidate)} ({len(candidate)} bytes); changed={len(changed)}; inverse=exact; console4096=preserved")
        print(f"layout {rel(layout_path)} sha256={sha(layout_path.read_bytes())}")
        print(f"composition {rel(comp_path)} sha256={sha(comp_path.read_bytes())}")
        return 0

    # Build the ACTTEST0 once using the pinned SDK. Repack only requested payloads.
    artifact_name = f"H1E-{NAME}-EXPERIMENTAL-NOT-INSTALL.bin"
    with tempfile.TemporaryDirectory(prefix="sdk-pack-", dir=out_dir) as temp_name:
        work = Path(temp_name)
        parts_dir = work / "parts"
        parts_dir.mkdir()
        for part_name in PARTITION_ORDER:
            (parts_dir / part_name).write_bytes(new_payloads[part_name])
        cfg = work / "empty.cfg"
        cfg.write_bytes(b"")
        staged = work / artifact_name
        run = subprocess.run([sys.executable, "-I", str(SDK), "-cf", str(cfg), "-o", str(staged),
                              *[str(parts_dir / name) for name in PARTITION_ORDER]],
                             capture_output=True, text=True, timeout=90)
        need(run.returncode == 0 and staged.is_file(), "SDK_PACK", (run.stdout + run.stderr)[-3000:])
        packed = staged.read_bytes()
        sdk_log = run.stdout + run.stderr
    # Independently verify the final on-disk files and all identity/CRC invariants.
    final_container = out_dir / artifact_name
    final_container.write_bytes(packed)
    readback = raw_parse_container(final_container.read_bytes())
    need(final_container.read_bytes() == packed and len(packed) == len(baseline_container),
         "CONTAINER_DISK_READBACK", "packed output length or disk readback differs")
    need([e["name"] for e in readback] == PARTITION_ORDER, "CONTAINER_ORDER", repr([e["name"] for e in readback]))
    new_entries = {e["name"]: e for e in readback}
    for name in PARTITION_ORDER:
        old_entry, new_entry = by_name[name], new_entries[name]
        need(new_entry["offset"] == old_entry["offset"] and new_entry["load"] == old_entry["load"] == 0 and
             new_entry["run"] == old_entry["run"] == 0, "CONTAINER_OFFSETS", name)
        need(new_entry["size"] == old_entry["size"], "CONTAINER_PARTITION_SIZE", name)
        actual_payload = final_container.read_bytes()[new_entry["offset"]:new_entry["offset"] + new_entry["size"]]
        need(actual_payload == new_payloads[name], "CONTAINER_PAYLOAD_READBACK", name)
        if name not in CHANGED_PARTS:
            need(actual_payload == payloads[name] and new_entry["sha256"] == old_entry["sha256"],
                 "CONTAINER_UNCHANGED_PAYLOAD", name)
    decoded_boot = decoder.transform(final_container.read_bytes()[new_entries["mbrec.bin"]["offset"]:
                                                                   new_entries["mbrec.bin"]["offset"] + new_entries["mbrec.bin"]["size"]], SEED)
    decoded_system = decoder.transform(final_container.read_bytes()[new_entries["zephyr.bin"]["offset"]:
                                                                     new_entries["zephyr.bin"]["offset"] + new_entries["zephyr.bin"]["size"]], SEED)
    need(decoded_boot == new_boot and decoded_system == candidate, "CONTAINER_DECODE_READBACK", "decoded payload differs")
    final_xml_payload = final_container.read_bytes()[new_entries["ota.xml"]["offset"]:
                                                     new_entries["ota.xml"]["offset"] + new_entries["ota.xml"]["size"]]
    final_xml_summary = xml_summary(final_xml_payload)
    for part_name, metadata in final_xml_summary["partitions"].items():
        need(part_name in new_entries, "XML_DIRECTORY_ENTRY", part_name)
        entry = new_entries[part_name]
        actual_payload = final_container.read_bytes()[entry["offset"]:entry["offset"] + entry["size"]]
        need(int(metadata["file_size"], 0) == entry["size"], "XML_DIRECTORY_SIZE", part_name)
        need(int(metadata["checksum"], 0) == entry["crc32"] == zlib.crc32(actual_payload),
             "XML_DIRECTORY_CRC", f"{part_name}: XML {metadata['checksum']} != directory 0x{entry['crc32']:08x}")
    need(struct.unpack_from("<I", decoded_boot, 0xF84)[0] == CODE and
         decoded_boot[0xF8C:0xFCC] == NAME.encode().ljust(64, b"\0") and
         zlib.crc32(decoded_boot[0xF80:0xFFC]) == struct.unpack_from("<I", decoded_boot, 0xFFC)[0],
         "CONTAINER_BOOT_IDENTITY", "FVER identity or CRC wrong")
    need(new_xml_summary["version_name"] == NAME and int(new_xml_summary["version_code"], 0) == 0x60308,
         "CONTAINER_XML_IDENTITY", "version metadata wrong")
    need(slice_va(decoded_system, *CONSOLE_RANGE) == console_slice, "CONTAINER_CONSOLE", "console reservation changed")

    boot_diff, boot_runs = diff_runs(old_boot, new_boot)
    need(all(a in ALLOWED_BOOT for a in boot_diff), "BOOT_CHANGE_SCOPE", "instruction or other boot bytes changed")
    boot_inverse = bytearray(new_boot)
    for start, end in boot_runs:
        boot_inverse[start:end] = old_boot[start:end]
    need(bytes(boot_inverse) == old_boot, "BOOT_INVERSE", "boot identity inverse failed")
    container_diff, container_runs = diff_runs(baseline_container, packed)
    allowed_container = [(0, 512)]
    for name in CHANGED_PARTS:
        e = by_name[name]
        end = e["offset"] + e["size"] + 512 - e["size"] % 512
        allowed_container.append((e["offset"], end))
    need(all(any(a <= pos < b for a, b in allowed_container) for pos in container_diff),
         "CONTAINER_CHANGE_SCOPE", "container change escaped header or changed payload regions")

    need(SDK_PARSER_HELPER.is_file() and sha(SDK_PARSER_HELPER.read_bytes()) == SDK_PARSER_HELPER_SHA,
         "SDK_PARSER_HELPER_PIN", "existing parseFirmwareImage helper changed")
    parser_receipt_path = receipts / "sdk-parser.json"
    parser_run = subprocess.run(["node", str(SDK_PARSER_HELPER), str(final_container), str(parser_receipt_path)],
                                capture_output=True, text=True, timeout=90)
    need(parser_run.returncode == 0 and parser_receipt_path.is_file(), "SDK_PARSE_FIRMWARE_IMAGE",
         (parser_run.stdout + parser_run.stderr)[-3000:])
    parser_receipt = json.loads(parser_receipt_path.read_text(encoding="utf-8"))
    parsed_sdk = parser_receipt.get("parsed")
    need(parser_receipt.get("accepted") is True and isinstance(parsed_sdk, dict) and
         parsed_sdk.get("versionNumber") == CODE and parsed_sdk.get("versionName") == NAME and
         parsed_sdk.get("board") == BOARD and parsed_sdk.get("bytes") == len(packed) and
         parser_receipt.get("container", {}).get("sha256") == sha(packed),
         "SDK_PARSE_FIRMWARE_IMAGE_READBACK", repr(parsed_sdk))

    container_info = {
        "schema": "h1e-vad-combined-slots-393992-container-readback-v1",
        "status": "offline_container_composed_readback_verified_EXPERIMENTAL_NOTINSTALL",
        "identity": {"numeric": CODE, "version_name": NAME, "ota_version_code": "0x60308", "board": BOARD},
        "baseline_container": {"path": rel(BASE_CONTAINER), "sha256": sha(baseline_container), "bytes": len(baseline_container),
                               "identity": {"numeric": OLD_CODE, "version_name": OLD_NAME}},
        "output_container": {"path": rel(final_container), "sha256": sha(packed), "bytes": len(packed)},
        "decoded_system": {"path": rel(system_path), "sha256": sha(candidate), "bytes": len(candidate),
                           "baseline_slots_sha256": sha(current_sys), "inverse_reconstructs_slots_baseline": True},
        "decoded_boot": {"sha256": sha(new_boot), "baseline_sha256": sha(old_boot),
                         "instruction_bytes_unchanged": True, "identity_and_crc_windows_only": True,
                         "allowed_ranges": ["0x14..0x17", "0xf84..0xf87", "0xf8c..0xfcb", "0xffc..0xfff"]},
        "partitions": [{"name": e["name"], "old_offset": by_name[e["name"]]["offset"], "offset": e["offset"],
                        "old_size": by_name[e["name"]]["size"], "size": e["size"], "crc32": f"0x{e['crc32']:08x}",
                        "sha256": e["sha256"], "unchanged_payload": e["name"] not in CHANGED_PARTS}
                       for e in readback],
        "directory_offsets_and_all_partition_sizes_unchanged": True,
        "unchanged_other_payloads_preserved": True,
        "zephyr_decodes_to_exact_combined_system": True,
        "console_4096_preserved_in_decoded_container": True,
        "xml": {"old_sha256": sha(payloads["ota.xml"]), "new_sha256": sha(new_xml), "old_bytes": len(payloads["ota.xml"]),
                "new_bytes": len(new_xml), "size_preserved": True,
                "semantic_changes": ["firmware_version/version_code", "firmware_version/version_name",
                                     "zephyr.bin/checksum", "mbrec.bin/checksum"],
                "padded_with_xml_trailing_whitespace_to_keep_directory_size": True},
        "all_xml_partition_sizes_and_checksums_match_actual_directory": True,
        "sdk_parse_firmware_image": {"accepted": True, "receipt_path": rel(parser_receipt_path),
                                      "receipt_sha256": sha(parser_receipt_path.read_bytes()),
                                      "sdk_index_sha256": parser_receipt["sdkIndexSha256"], "parsed": parsed_sdk},
        "container_changed_bytes": len(container_diff),
        "container_changed_runs": [{"start": f"0x{a:x}", "end_exclusive": f"0x{b:x}", "length": b - a}
                                    for a, b in container_runs],
        "container_changes_confined_to_header_and_three_changed_payloads": True,
        "sdk_packer_sha256": SDK_SHA,
        "sdk_output_log": sdk_log[-4000:],
        "control_repack_performed": False,
        "hardware_or_install_tested": False,
    }
    container_path = receipts / "container-readback.json"
    container_path.write_text(json.dumps(container_info, indent=2) + "\n", encoding="utf-8")

    source_path = SCRIPT_PATH
    final = {
        "schema": "h1e-vad-combined-slots-393992-final-receipt-v1",
        "status": "offline_combined_candidate_complete_EXPERIMENTAL_NOTINSTALL",
        "identity": {"numeric": CODE, "version_name": NAME, "ota_version_code": "0x60308", "board": BOARD},
        "linked_elf": {"path": rel(ELF), "sha256": sha(elf), "bytes": len(elf), "module_sha256": sha(module_export),
                       "module_bytes": len(module_export), "response_alias": "0x0112b81c"},
        "combined_system": {"path": rel(system_path), "sha256": sha(candidate), "bytes": len(candidate)},
        "combined_container": {"path": rel(final_container), "sha256": sha(packed), "bytes": len(packed)},
        "readback_receipts": {"layout": {"path": rel(layout_path), "sha256": sha(layout_path.read_bytes())},
                              "composition": {"path": rel(comp_path), "sha256": sha(comp_path.read_bytes())},
                              "container": {"path": rel(container_path), "sha256": sha(container_path.read_bytes())},
                              "sdk_parser": {"path": rel(parser_receipt_path), "sha256": sha(parser_receipt_path.read_bytes())}},
        "composer": {"path": rel(source_path), "sha256": sha(source_path.read_bytes())},
        "limits": "Offline structural/readback candidate only. No flash, device action, public release, host installer qualification, physical boot, DSP VAD signal qualification, or device behavior claim.",
    }
    final_path = receipts / "final-receipt.json"
    final_path.write_text(json.dumps(final, indent=2) + "\n", encoding="utf-8")
    print(f"ELF {sha(elf)}; module {sha(module_export)} ({len(module_export)} bytes)")
    print(f"SYS {sha(candidate)} ({len(candidate)} bytes); changed={len(changed)}; inverse=exact; console4096=preserved")
    print(f"container {sha(packed)} ({len(packed)} bytes); identity={CODE}/{NAME}; offsets and sizes unchanged")
    print(f"receipt {rel(final_path)} sha256={sha(final_path.read_bytes())}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
