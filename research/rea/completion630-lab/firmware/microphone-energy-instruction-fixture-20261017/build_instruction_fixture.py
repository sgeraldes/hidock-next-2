#!/usr/bin/env python3
"""Build a pinned, emulator-only instruction fixture from ELF sections.

This does not create a mapped/bootable SYS or OTA. It copies the pinned base
SYS, applies five manifest-pinned instruction sections, appends only the two
allowlisted module sections in the 2 KiB evaluation window, and records an
exact inverse recipe. Python standard library only.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[4]
OUT_DIR = HERE / "out-INSTRUCTION-FIXTURE-NOTINSTALL"
OUT_BIN = OUT_DIR / "instruction-fixture-393998-voice-energy-NOTINSTALL.bin"
OUT_RECEIPT = OUT_DIR / "fixture-receipt.json"

BASE_REL = Path(
    "research/rea/completion630-lab/firmware/producer-lifecycle-system-393998/"
    "out-NOTINSTALL/system-decoded-393998-lifecycle-NOTINSTALL.bin"
)
ELF_REL = Path(
    "research/rea/completion630-lab/firmware/microphone-energy-cache-20261017/"
    "out-provisional-link-20261017-r5-dispatch-fix5/voice-energy-provisional.elf"
)
MANIFEST_REL = Path(
    "research/rea/completion630-lab/firmware/microphone-energy-cache-20261017/"
    "out-provisional-link-20261017-r5-dispatch-fix5/integration-manifest.json"
)

BASE_SHA256 = "f2e391ca2c895c1d34e1a49639d00571a18418886a25d4200247875cf86a4c3e"
ELF_SHA256 = "fabcf97d7dc010f3ff8b1d007628ed2529e7aad6fc1988d72399fc4515586cd3"
MANIFEST_SHA256 = "6e7e8282a5b8cab91999665802be6797ce883e9311e9b28d79b3324b674b6687"
BASE_SIZE = 1_237_504
ELF_SIZE = 13_600
MANIFEST_SIZE = 11_710
BASE_ADDRESS = 0x01000000
HEADER_SIZE = 48
HEADER_HEX = (
    "4143544848544341000000017379730001003000000000000000000000000000"
    "6ce20601000000000000000000000000"
)
HEADER_SHA256 = "3ecd58a99a64a20f6ce169bd28753d5ae8954fc78313cff895267a1fae534fdd"
MODULE_START = 0x01137000
MODULE_WINDOW_END = 0x01137800
MANIFEST_LINK_END = 0x011374E8
SHF_ALLOC = 0x2
SHF_EXECINSTR = 0x4
SHT_NULL = 0
SHT_PROGBITS = 1
SHT_SYMTAB = 2
SHT_STRTAB = 3
SHT_NOBITS = 8


@dataclass(frozen=True)
class Section:
    index: int
    name: str
    section_type: int
    flags: int
    address: int
    offset: int
    size: int
    data: bytes


# The seven allocated section names, exact VMAs, lengths, and flags are pinned
# from the final r5-dispatch-fix5 ELF. All other sections must be ELF metadata.
ALLOC_SPECS: dict[str, tuple[int, int, int]] = {
    ".poll_dispatch_call": (0x01020B62, 4, SHF_ALLOC | SHF_EXECINSTR),
    ".constructor_allocate128": (0x01021054, 2, SHF_ALLOC | SHF_EXECINSTR),
    ".constructor_zero128": (0x0102109E, 2, SHF_ALLOC | SHF_EXECINSTR),
    ".parser_dispatch_call": (0x01128E68, 4, SHF_ALLOC | SHF_EXECINSTR),
    ".response_dispatch_call": (0x01128EA2, 4, SHF_ALLOC | SHF_EXECINSTR),
    ".voice_energy_text": (0x01137000, 1232, SHF_ALLOC | SHF_EXECINSTR),
    ".voice_energy_rodata": (0x011374D0, 21, SHF_ALLOC),
}
METADATA_SPECS = {"": SHT_NULL, ".shstrtab": SHT_STRTAB, ".symtab": SHT_SYMTAB, ".strtab": SHT_STRTAB}

# ELF section -> (manifest group, record kind, preimage field, postimage field).
PATCH_MANIFEST_KEYS = {
    ".constructor_allocate128": (
        "constructor",
        "allocate_128",
        "current_96_instruction_bytes_hex",
        "proposed_128_instruction_bytes_hex",
    ),
    ".constructor_zero128": (
        "constructor",
        "zero_128",
        "current_96_instruction_bytes_hex",
        "proposed_128_instruction_bytes_hex",
    ),
    ".poll_dispatch_call": (
        "calls",
        "poll",
        "current_393998_bytes_hex",
        "proposed_bytes_hex",
    ),
    ".parser_dispatch_call": (
        "calls",
        "parse",
        "current_393998_bytes_hex",
        "proposed_bytes_hex",
    ),
    ".response_dispatch_call": (
        "calls",
        "response",
        "current_393998_bytes_hex",
        "proposed_bytes_hex",
    ),
}


def fail(message: str) -> None:
    raise SystemExit(f"REFUSED: {message}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require_pin(path: Path, expected_size: int, expected_hash: str, label: str) -> bytes:
    if not path.is_file():
        fail(f"missing {label}: {path}")
    data = path.read_bytes()
    actual_hash = sha256(data)
    if len(data) != expected_size or actual_hash != expected_hash:
        fail(
            f"{label} pin mismatch: size={len(data)} sha256={actual_hash}; "
            f"expected size={expected_size} sha256={expected_hash}"
        )
    return data


def c_string(table: bytes, offset: int, label: str) -> str:
    if offset < 0 or offset >= len(table):
        fail(f"{label}: string offset outside string table")
    end = table.find(b"\0", offset)
    if end < 0:
        fail(f"{label}: unterminated section name")
    try:
        return table[offset:end].decode("ascii")
    except UnicodeDecodeError as exc:
        fail(f"{label}: non-ASCII section name ({exc})")


def parse_elf_sections(elf: bytes) -> list[Section]:
    """Read ELF32-LE section headers and section payloads; never flatten ELF."""
    if len(elf) < 52 or elf[:4] != b"\x7fELF":
        fail("ELF magic/header is missing")
    ident = elf[:16]
    if ident[4] != 1 or ident[5] != 1 or ident[6] != 1:
        fail("ELF must be ELF32, little-endian, current version")
    fields = struct.unpack_from("<16sHHIIIIIHHHHHH", elf, 0)
    e_type, e_machine, e_version = fields[1], fields[2], fields[3]
    e_shoff, e_ehsize, e_shentsize, e_shnum, e_shstrndx = (
        fields[6],
        fields[8],
        fields[11],
        fields[12],
        fields[13],
    )
    if e_type != 2 or e_version != 1 or e_ehsize != 52:
        fail("unexpected ELF type/version/header size")
    # C-SKY uses EM_CSKY (252); this input is pinned to the final CK802 link.
    if e_machine != 252:
        fail(f"unexpected ELF machine id {e_machine}; expected C-SKY (252)")
    if e_shentsize != 40 or e_shnum == 0 or e_shstrndx >= e_shnum:
        fail("unsupported or malformed ELF section table")
    sh_table_end = e_shoff + e_shentsize * e_shnum
    if e_shoff < e_ehsize or sh_table_end > len(elf):
        fail("ELF section table extends outside the pinned file")

    raw_headers = [
        struct.unpack_from("<IIIIIIIIII", elf, e_shoff + i * e_shentsize)
        for i in range(e_shnum)
    ]
    shstr_header = raw_headers[e_shstrndx]
    if shstr_header[1] != SHT_STRTAB or shstr_header[5] == 0:
        fail("invalid section-name string table")
    shstr_off, shstr_size = shstr_header[4], shstr_header[5]
    if shstr_off + shstr_size > e_shoff:
        fail("section-name string table overlaps ELF section headers")
    shstr = elf[shstr_off : shstr_off + shstr_size]

    sections: list[Section] = []
    file_ranges: list[tuple[int, int, str]] = []
    names_seen: set[str] = set()
    for index, header in enumerate(raw_headers):
        name_offset, section_type, flags, address, offset, size = header[:6]
        name = c_string(shstr, name_offset, f"section[{index}]")
        if name in names_seen:
            fail(f"duplicate ELF section name {name!r}")
        names_seen.add(name)
        if section_type == SHT_NOBITS and size != 0:
            fail(f"nonzero SHT_NOBITS rejected: {name!r} size={size}")
        if section_type == SHT_NOBITS:
            data = b""
        else:
            if size and (offset < e_ehsize or offset + size > e_shoff):
                fail(f"section payload outside ELF content area: {name!r}")
            data = elf[offset : offset + size] if size else b""
            if size:
                file_ranges.append((offset, offset + size, name))
        sections.append(
            Section(index, name, section_type, flags, address, offset, size, data)
        )

    file_ranges.sort()
    for previous, current in zip(file_ranges, file_ranges[1:]):
        if previous[1] > current[0]:
            fail(f"overlapping ELF file payloads: {previous[2]} and {current[2]}")

    if names_seen != set(ALLOC_SPECS) | set(METADATA_SPECS):
        unknown = sorted(names_seen - set(ALLOC_SPECS) - set(METADATA_SPECS))
        missing = sorted((set(ALLOC_SPECS) | set(METADATA_SPECS)) - names_seen)
        fail(f"ELF section allowlist mismatch; unknown={unknown}, missing={missing}")

    for section in sections:
        if section.name in ALLOC_SPECS:
            expected_addr, expected_size, expected_flags = ALLOC_SPECS[section.name]
            if section.section_type != SHT_PROGBITS:
                fail(f"allocated section must be PROGBITS: {section.name}")
            if (section.address, section.size, section.flags) != (
                expected_addr,
                expected_size,
                expected_flags,
            ):
                fail(f"allocated section spec mismatch: {section.name}")
        else:
            expected_type = METADATA_SPECS[section.name]
            if section.section_type != expected_type or section.flags & SHF_ALLOC:
                fail(f"unexpected non-ALLOC metadata section: {section.name!r}")

    allocated = sorted(
        (s.address, s.address + s.size, s.name)
        for s in sections
        if s.flags & SHF_ALLOC and s.size
    )
    for previous, current in zip(allocated, allocated[1:]):
        if previous[1] > current[0]:
            fail(f"overlapping allocated VMAs: {previous[2]} and {current[2]}")
    return sections


def parse_hex_field(record: dict[str, Any], key: str, label: str) -> bytes:
    value = record.get(key)
    if not isinstance(value, str):
        fail(f"manifest field missing: {label}.{key}")
    try:
        result = bytes.fromhex(value)
    except ValueError as exc:
        fail(f"invalid manifest hex at {label}.{key}: {exc}")
    if not result:
        fail(f"empty manifest byte sequence at {label}.{key}")
    return result


def collect_manifest_patches(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    lifecycle = manifest.get("required_lifecycle_recipe_not_applied", {}).get(
        "constructor_96_to_128", []
    )
    calls = manifest.get("external_call_proposal_not_applied", [])
    if len(lifecycle) != 2 or len(calls) != 3:
        fail("manifest must contain exactly two constructor and three BSR proposals")
    records: dict[tuple[str, str], dict[str, Any]] = {}
    for record in lifecycle:
        records[("constructor", record.get("kind"))] = record
    for record in calls:
        records[("calls", record.get("kind"))] = record
    result: dict[str, dict[str, Any]] = {}
    for section_name, (group, kind, before_key, after_key) in PATCH_MANIFEST_KEYS.items():
        record = records.get((group, kind))
        if record is None:
            fail(f"manifest missing {group}/{kind} patch for {section_name}")
        address, size, _flags = ALLOC_SPECS[section_name]
        if int(record.get("address", "-1"), 0) != address:
            fail(f"manifest address mismatch for {section_name}")
        before = parse_hex_field(record, before_key, f"{group}/{kind}")
        after = parse_hex_field(record, after_key, f"{group}/{kind}")
        if len(before) != size or len(after) != size or before == after:
            fail(f"manifest patch size/content mismatch for {section_name}")
        result[section_name] = {
            "kind": kind,
            "address": address,
            "preimage": before,
            "postimage": after,
            "manifest_source": (
                "required_lifecycle_recipe_not_applied.constructor_96_to_128"
                if group == "constructor"
                else "external_call_proposal_not_applied"
            ),
        }
    return result


def coalesce_padding_ranges(
    coverage: bytearray, start_address: int
) -> list[dict[str, Any]]:
    ranges: list[dict[str, Any]] = []
    index = 0
    while index < len(coverage):
        if coverage[index]:
            index += 1
            continue
        start = index
        while index < len(coverage) and not coverage[index]:
            index += 1
        ranges.append(
            {
                "start": f"0x{start_address + start:08x}",
                "end_exclusive": f"0x{start_address + index:08x}",
                "size_bytes": index - start,
                "fill_hex": "ff",
            }
        )
    return ranges


def write_same_or_new(path: Path, data: bytes) -> None:
    if path.exists():
        if not path.is_file() or path.read_bytes() != data:
            fail(f"refusing to overwrite existing nonmatching output: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def build() -> dict[str, Any]:
    base_path = REPO_ROOT / BASE_REL
    elf_path = REPO_ROOT / ELF_REL
    manifest_path = REPO_ROOT / MANIFEST_REL
    base = require_pin(base_path, BASE_SIZE, BASE_SHA256, "base SYS")
    elf = require_pin(elf_path, ELF_SIZE, ELF_SHA256, "r5 ELF")
    manifest_raw = require_pin(
        manifest_path, MANIFEST_SIZE, MANIFEST_SHA256, "r5 integration manifest"
    )
    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"invalid pinned manifest JSON: {exc}")

    if manifest.get("identity", {}).get("load_base") != "0x01000000":
        fail("manifest load base mismatch")
    if manifest.get("identity", {}).get("installed_current_system", {}).get(
        "sha256"
    ) != BASE_SHA256:
        fail("manifest base SYS pin mismatch")
    if manifest.get("provisional_link", {}).get("elf_sha256") != ELF_SHA256:
        fail("manifest ELF pin mismatch")
    if manifest.get("provisional_link", {}).get("start") != f"0x{MODULE_START:08x}":
        fail("manifest module start mismatch")
    if manifest.get("provisional_link", {}).get("end_exclusive") != (
        f"0x{MANIFEST_LINK_END:08x}"
    ):
        fail("manifest linked end mismatch")
    if manifest.get("provisional_link", {}).get("window_end_exclusive") != (
        f"0x{MODULE_WINDOW_END:08x}"
    ):
        fail("manifest module window mismatch")
    if manifest.get("provisional_link", {}).get("vma_reservation_accepted") is not False:
        fail("manifest unexpectedly claims the proposed VMA is reserved")
    if manifest.get("provisional_link", {}).get("sys_or_container_composed") is not False:
        fail("manifest unexpectedly claims SYS/container composition")
    if manifest.get("status") != "offline_source_and_link_proposal_NOT_COMPOSED_NOT_INSTALLABLE":
        fail("manifest status is not the pinned offline proposal state")

    if base[:HEADER_SIZE].hex() != HEADER_HEX or sha256(base[:HEADER_SIZE]) != HEADER_SHA256:
        fail("pinned base SYS 48-byte header/version prefix mismatch")
    patches = collect_manifest_patches(manifest)
    sections = parse_elf_sections(elf)
    by_name = {section.name: section for section in sections}
    if set(by_name) != set(ALLOC_SPECS) | set(METADATA_SPECS):
        fail("unexpected section set after ELF parse")

    # The five patch sections must match both the manifest proposal and the
    # pinned base preimage. This is the only permitted change within base bytes.
    for name, patch in patches.items():
        section = by_name[name]
        if section.data != patch["postimage"]:
            fail(f"ELF section bytes do not match manifest postimage: {name}")
        offset = patch["address"] - BASE_ADDRESS
        if offset < 0 or offset + len(patch["preimage"]) > len(base):
            fail(f"patch outside base SYS: {name}")
        if base[offset : offset + len(patch["preimage"])] != patch["preimage"]:
            fail(f"base SYS preimage mismatch at {name} / 0x{patch['address']:08x}")

    module_names = {".voice_energy_text", ".voice_energy_rodata"}
    module_sections = [by_name[name] for name in sorted(module_names)]
    base_end_address = BASE_ADDRESS + len(base)
    if MODULE_START < base_end_address:
        fail("module window overlaps the pinned base SYS; refusing overwrite")
    for section in module_sections:
        end = section.address + section.size
        if section.address < MODULE_START or end > MODULE_WINDOW_END:
            fail(f"module section outside the 2 KiB evaluation window: {section.name}")
        if section.address < base_end_address:
            fail(f"module section would overwrite pinned base bytes: {section.name}")
    if not module_sections or min(s.address for s in module_sections) != MODULE_START:
        fail("module sections do not begin at the pinned evaluation address")
    module_used_end = max(s.address + s.size for s in module_sections)
    if module_used_end > MODULE_WINDOW_END:
        fail("module sections exceed the evaluation window")

    output_size = MODULE_WINDOW_END - BASE_ADDRESS
    if output_size < len(base):
        fail("fixture window would truncate the pinned base SYS")
    output = bytearray(base)
    output.extend(b"\xff" * (output_size - len(output)))
    for section in sections:
        if not (section.flags & SHF_ALLOC):
            continue
        if section.name not in ALLOC_SPECS:
            fail(f"unallowlisted allocated section: {section.name}")
        offset = section.address - BASE_ADDRESS
        end_offset = offset + section.size
        if offset < 0 or end_offset > len(output):
            fail(f"allocated section outside fixture output: {section.name}")
        if section.name not in patches and section.name not in module_names:
            fail(f"allocated section has no permitted fixture role: {section.name}")
        output[offset:end_offset] = section.data

    # Fail if any byte in the original base changed outside the five patches.
    allowed_base_offsets: set[int] = set()
    for patch in patches.values():
        offset = patch["address"] - BASE_ADDRESS
        allowed_base_offsets.update(range(offset, offset + len(patch["postimage"])))
    for offset, (before, after) in enumerate(zip(base, output[: len(base)])):
        if before != after and offset not in allowed_base_offsets:
            fail(f"unexpected base difference at 0x{BASE_ADDRESS + offset:08x}")
    if output[:HEADER_SIZE] != base[:HEADER_SIZE]:
        fail("fixture changed the original 48-byte header/version prefix")

    appended_coverage = bytearray(output_size - len(base))
    for section in module_sections:
        start = section.address - (BASE_ADDRESS + len(base))
        end = start + section.size
        if start < 0 or end > len(appended_coverage):
            fail(f"module coverage outside appended area: {section.name}")
        if any(appended_coverage[start:end]):
            fail(f"overlapping appended coverage: {section.name}")
        appended_coverage[start:end] = b"\x01" * section.size
    padding_ranges = coalesce_padding_ranges(
        appended_coverage, BASE_ADDRESS + len(base)
    )
    for padding in padding_ranges:
        start = int(padding["start"], 16) - BASE_ADDRESS
        end = int(padding["end_exclusive"], 16) - BASE_ADDRESS
        if output[start:end] != b"\xff" * (end - start):
            fail("appended padding is not explicitly 0xff")

    # Reconstruct the exact input by truncating appended material and restoring
    # the five pinned preimages. This is checked before any output is written.
    reconstructed = bytearray(output[: len(base)])
    patch_receipts: list[dict[str, Any]] = []
    for name, patch in patches.items():
        offset = patch["address"] - BASE_ADDRESS
        postimage = bytes(output[offset : offset + len(patch["postimage"])])
        if postimage != patch["postimage"]:
            fail(f"output patch bytes do not match expected ELF bytes: {name}")
        reconstructed[offset : offset + len(patch["preimage"])] = patch["preimage"]
        patch_receipts.append(
            {
                "section": name,
                "kind": patch["kind"],
                "address": f"0x{patch['address']:08x}",
                "size_bytes": len(postimage),
                "preimage_hex": patch["preimage"].hex(),
                "postimage_hex": postimage.hex(),
                "changed_byte_count": sum(a != b for a, b in zip(patch["preimage"], postimage)),
                "manifest_source": patch["manifest_source"],
            }
        )
    if bytes(reconstructed) != base:
        fail("inverse reconstruction did not reproduce exact pinned base SYS")

    section_receipts = []
    for section in sorted(
        (s for s in sections if s.flags & SHF_ALLOC), key=lambda s: s.address
    ):
        section_receipts.append(
            {
                "name": section.name,
                "address": f"0x{section.address:08x}",
                "end_exclusive": f"0x{section.address + section.size:08x}",
                "size_bytes": section.size,
                "flags": f"0x{section.flags:x}",
                "sha256": sha256(section.data),
                "role": "manifest-pinned instruction patch"
                if section.name in patches
                else "module section in evaluation window",
            }
        )

    output_bytes = bytes(output)
    receipt: dict[str, Any] = {
        "schema": "h1e-microphone-energy-instruction-fixture-v1",
        "status": "EMULATOR_IMPORT_ONLY_NOTINSTALL",
        "installable": False,
        "ota_or_container_built": False,
        "crc_recomputed": False,
        "header_or_version_rewritten": False,
        "base_address": f"0x{BASE_ADDRESS:08x}",
        "inputs": {
            "base_sys": {
                "path": BASE_REL.as_posix(),
                "size_bytes": len(base),
                "sha256": sha256(base),
            },
            "elf": {
                "path": ELF_REL.as_posix(),
                "size_bytes": len(elf),
                "sha256": sha256(elf),
                "manifest_path": MANIFEST_REL.as_posix(),
                "manifest_size_bytes": len(manifest_raw),
                "manifest_sha256": sha256(manifest_raw),
            },
        },
        "preserved_header_version_prefix": {
            "size_bytes": HEADER_SIZE,
            "hex": HEADER_HEX,
            "sha256": HEADER_SHA256,
            "byte_identical": output_bytes[:HEADER_SIZE] == base[:HEADER_SIZE],
        },
        "output": {
            "path": OUT_BIN.relative_to(REPO_ROOT).as_posix(),
            "size_bytes": len(output_bytes),
            "sha256": sha256(output_bytes),
            "module_window": {
                "start": f"0x{MODULE_START:08x}",
                "end_exclusive": f"0x{MODULE_WINDOW_END:08x}",
                "linked_end_exclusive": f"0x{MANIFEST_LINK_END:08x}",
                "used_end_exclusive": f"0x{module_used_end:08x}",
            },
        },
        "allocated_sections_applied": section_receipts,
        "manifest_pinned_instruction_byte_changes": patch_receipts,
        "appended_padding_ranges": padding_ranges,
        "inverse_reconstruction": {
            "recipe": "truncate output to original base SYS size, then restore each listed preimage_hex at its address",
            "truncate_to_size_bytes": len(base),
            "restore_ranges": [
                {
                    "address": patch["address"],
                    "preimage_hex": patch["preimage"].hex(),
                }
                for patch in patches.values()
            ],
            "verified_byte_identical_to_input": True,
            "reconstructed_sha256": sha256(bytes(reconstructed)),
        },
        "limits": [
            "The module VMA is an emulator fixture coordinate, not a reserved firmware VMA.",
            "Mapper/boot integration, installability, OTA/container format, header sizing, and CRC remain unresolved.",
            "No target execution or hardware behavior is established by this byte fixture.",
        ],
    }
    receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    write_same_or_new(OUT_BIN, output_bytes)
    write_same_or_new(OUT_RECEIPT, receipt_bytes)
    return receipt


if __name__ == "__main__":
    try:
        result = build()
    except (OSError, KeyError, TypeError, ValueError, struct.error) as exc:
        fail(str(exc))
    print(
        json.dumps(
            {
                "status": result["status"],
                "output": result["output"],
                "receipt": OUT_RECEIPT.relative_to(REPO_ROOT).as_posix(),
                "inverse_verified": result["inverse_reconstruction"][
                    "verified_byte_identical_to_input"
                ],
            },
            sort_keys=True,
        )
    )
