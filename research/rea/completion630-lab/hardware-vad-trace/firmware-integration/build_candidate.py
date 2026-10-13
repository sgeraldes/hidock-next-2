"""Fail-closed offline builder: frozen decoded 393988 system image + accepted VAD module.

Writes ONE new decoded candidate named ...-NOTINSTALL.bin. It never overwrites a file, never
edits an input, builds no container or OTA, changes no version and makes no flashability claim.

Pure construction lives in construct(). main() reads the pinned inputs, builds, writes the
result to a .partial file, reads that file back from disk (readback()), and only then publishes
it through an exclusive hard link. A failed readback quarantines it as .REJECTED without
replacing an existing destination; a publication collision preserves the .partial file.

Run in WSL (the toolchain objdump used for the readback listing lives there):
    python3 build_candidate.py
"""
import sys

sys.dont_write_bytecode = True

import hashlib
import importlib.util
import json
import os
import re
import struct
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAD = HERE.parent
LAB = VAD.parent
REA = LAB.parent

BASE_VA = 0x01000000
MODULE_BASE = 0x0112F000
MODULE_CAPACITY = 0x4000  # ASSERT(SIZEOF(.vad_text) <= 16384) in native-link-candidate/module.ld
IMAGE_LIMIT = 0x200000  # carried from verify_containers.py (len(system) < 0x200000); not flash geometry
ALIGN = 32  # patch_system.py pads the decoded image to a multiple of 32

FROZEN_DIR = LAB / "firmware/restore-build393988/generation-restore4"
SDK = VAD / "native-ck802-candidate/sdk-profile/output"
PATHS = {
    "frozen": FROZEN_DIR / "system-decoded-NOTINSTALL.bin",
    "frozen_symbols": FROZEN_DIR / "symbols.txt",
    "frozen_ld": FROZEN_DIR / "module.ld",
    "elf": SDK / "conditional-source-ck802-sdk-NOTINSTALL.elf",
    "manifest": SDK / "sparse-source-hunks.json",
    "sdk_symbols": SDK / "symbols.txt",
    "link_receipt": SDK / "link-receipt.json",
}
PINS = {
    "frozen": "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f",
    "frozen_symbols": "a850bd25db4bab4c7e16b58c6ac5d5241c156a3fabde18aa187f167e09641e72",
    "frozen_ld": "90d5bc9c11850b87d123fb5eb51589645feea4a15d5cccc5896a8f9fd245840f",
    "elf": "576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366",
    "manifest": "73ce3d0889955701b2a7874e91cd653f30439054a5b3f1e273b4327aeed3ed35",
    "sdk_symbols": "9765956593197cbe01db81b88bdf00a7bf1e327027d4d9d53dd7d47ad501c90d",
    "link_receipt": "7458d9c8c9e755753e252274f23cf5649a949515f71d98ab40fc0dd8d9e77a86",
}
DECODER = REA / "decode_randomizer.py"
PIN_DECODER = "3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5"
OBJDUMP = "/home/sebastian/.local/share/rea/tools/csky-20210423/bin/csky-abiv2-elf-objdump"
PIN_OBJDUMP = "e6aad5acbaf952d53ed470878b95acfcffeca7c4e001fe7bbf1c0dce4fd07cdd"

OUT = HERE / "output"
OUTPUT_NAME = "system-decoded-vad-ck802-NOTINSTALL.bin"

# The only edits this builder may make: ten instruction hunks, 28 bytes, raw little-endian file bytes.
HUNKS = [
    dict(address=0x01020B62, width=4, role="existing_native_getter_bridge", section=".poll_hook",
         before="ffe303f8", after="08e01575", symbol="h1e_vad_native_poll_bridge"),
    dict(address=0x01021054, width=2, role="allocate_96", section=".constructor_edits", before="4030", after="6030", symbol=None),
    dict(address=0x0102105C, width=2, role="retain_private_pointer", section=".constructor_edits", before="00b5", after="c36d", symbol=None),
    dict(address=0x0102106A, width=2, role="private_failure_pointer", section=".constructor_edits", before="0095", after="1f6c", symbol=None),
    dict(address=0x01021070, width=4, role="final_publication_decision", section=".constructor_edits",
         before="403ce30f", after="08e0c274", symbol="late_publication_stub"),
    dict(address=0x0102109E, width=2, role="zero_96", section=".constructor_edits", before="4032", after="6032", symbol=None),
    dict(address=0x010210A8, width=2, role="retain_private_pointer_after_zero", section=".constructor_edits", before="e095", after="df6d", symbol=None),
    dict(address=0x010210DE, width=2, role="private_gpio_object", section=".constructor_edits", before="6095", after="df6c", symbol=None),
    dict(address=0x0103907A, width=4, role="native_response_dispatch", section=".response_hook",
         before="07e08194", after="07e04fb4", symbol="console630_response_hook"),
    dict(address=0x0103A996, width=4, role="native_parser_dispatch", section=".parser_hook",
         before="07e0cf87", after="07e09da7", symbol="console630_parser_hook"),
]
ALLOCATABLE = [".vad_text", ".constructor_edits", ".poll_hook", ".parser_hook", ".response_hook"]
IMPORTED_ALIASES = ["upload630_parse", "upload630_response", "restore630_parse", "restore630_response"]


class BuildRejected(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code


def need(condition, code, message):
    if not condition:
        raise BuildRejected(code, message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_decoder():
    data = DECODER.read_bytes()
    need(sha(data) == PIN_DECODER, "PIN_MISMATCH:decoder", "decode_randomizer.py changed")
    spec = importlib.util.spec_from_file_location("decode_randomizer", DECODER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def elf_sections(elf):
    need(elf[:7] == b"\x7fELF\x01\x01\x01", "ELF_STRUCTURE", "ELF32 little-endian required")
    (e_type, e_machine, _v, _entry, _phoff, shoff, e_flags, _eh, _phes, _phn, shentsize, shnum, shstrndx) = \
        struct.unpack_from("<HHIIIIIHHHHHH", elf, 16)
    need(shentsize == 40 and shnum > shstrndx, "ELF_STRUCTURE", "unexpected section header table")
    raw = [struct.unpack_from("<10I", elf, shoff + i * 40) for i in range(shnum)]
    names = elf[raw[shstrndx][4]:raw[shstrndx][4] + raw[shstrndx][5]]
    sections = []
    for i, (name, kind, flags, addr, off, size, link, _info, align, _ent) in enumerate(raw):
        sections.append(dict(index=i, name=names[name:].split(b"\0", 1)[0].decode(), type=kind, flags=flags,
                             addr=addr, off=off, size=size, link=link, align=align, hdr_off=shoff + i * 40))
    return sections, e_machine, e_flags


def elf_symbols(elf, sections):
    table = next((s for s in sections if s["type"] == 2), None)
    need(table is not None, "ELF_STRUCTURE", "no symbol table")
    strtab = sections[table["link"]]
    strings = elf[strtab["off"]:strtab["off"] + strtab["size"]]
    found = {}
    for i in range(table["size"] // 16):
        name, value, _size, _info, _other, _shndx = struct.unpack_from("<IIIBBH", elf, table["off"] + 16 * i)
        text = strings[name:].split(b"\0", 1)[0].decode()
        if text:
            found.setdefault(text, []).append(value)
    return found


def parse_symbols_txt(text):
    return {p[2]: int(p[0], 16) for line in text.splitlines() if len(p := line.split()) == 3}


def decode_bsr(raw, address):
    """32-bit bsr: two little-endian halfwords, high half first; top six bits 0b111000; 26-bit signed halfword offset."""
    need(len(raw) == 4, "NOT_BSR", "bsr is four bytes")
    word = (int.from_bytes(raw[:2], "little") << 16) | int.from_bytes(raw[2:], "little")
    need(word >> 26 == 0x38, "NOT_BSR", f"{raw.hex()} is not a 32-bit bsr")
    displacement = word & 0x3FFFFFF
    if displacement & 0x2000000:
        displacement -= 0x4000000
    return address + displacement * 2


def decode_movi(raw):
    """16-bit movi rz,imm8: halfword 0b00110 rrr iiiiiiii."""
    half = int.from_bytes(raw, "little")
    need(half & 0xF800 == 0x3000, "NOT_MOVI", f"{raw.hex()} is not a 16-bit movi")
    return (half >> 8) & 7, half & 0xFF


def frozen_reservations(ld_text):
    starts = {}
    for key, pattern in (("parser", r"\s\.text\s+0x([0-9a-f]+)"), ("upload", r"\s\.upload_text\s+0x([0-9a-f]+)"),
                         ("restore", r"\s\.restore_text\s+0x([0-9a-f]+)")):
        m = re.search(pattern, ld_text)
        need(m is not None, "LD_PARSE", f"cannot read {key} start from module.ld")
        starts[key] = int(m.group(1), 16)
    sizes = {}
    for key, pattern in (("parser", r"SIZEOF\(\.text\)<=(\d+)"), ("upload", r"SIZEOF\(\.upload_text\)<=(\d+)"),
                         ("restore", r"SIZEOF\(\.restore_text\)<=(\d+)")):
        m = re.search(pattern, ld_text)
        need(m is not None, "LD_PARSE", f"cannot read {key} size from module.ld")
        sizes[key] = int(m.group(1))
    return {k: (starts[k], starts[k] + sizes[k]) for k in starts}


def construct(inputs, *, pins=PINS, module_base=MODULE_BASE, capacity=MODULE_CAPACITY, decoder=None):
    """Validate every pinned input and every precondition, then build the candidate in memory."""
    for key, expected in pins.items():
        need(key in inputs, "PIN_MISSING_INPUT", key)
        need(sha(inputs[key]) == expected, f"PIN_MISMATCH:{key}", f"{key} hash {sha(inputs[key])} is not the pinned {expected}")
    frozen, elf = inputs["frozen"], inputs["elf"]

    manifest = json.loads(inputs["manifest"])
    need(manifest.get("status") == "sparse_source_hunks_only_not_installable" and manifest.get("profile") == "ck802-sdk-flags"
         and manifest.get("applied") is False and manifest.get("firmware_image_generated") is False,
         "MANIFEST_STATUS", "manifest is not the unapplied ck802 sparse manifest")
    need(manifest.get("source_sha256") == sha(frozen) and manifest.get("elf_sha256") == sha(elf),
         "MANIFEST_BINDING", "manifest is bound to a different image or ELF")
    got = [(h["address"], h["width"], h["role"], h["before_hex"], h["after_hex"], h.get("linked_target_symbol")) for h in manifest["hunks"]]
    want = [(f"{h['address']:08x}", h["width"], h["role"], h["before"], h["after"], h["symbol"]) for h in HUNKS]
    need(got == want, "HUNK_SET_NOT_APPROVED", "manifest hunks differ from the builder's approved ten")
    need(manifest.get("total_instruction_bytes") == 28 and manifest.get("excluded_constructor_padding_bytes") == 124,
         "HUNK_SET_NOT_APPROVED", "hunk byte totals differ from 28 and 124")

    sections, machine, e_flags = elf_sections(elf)
    by = {s["name"]: s for s in sections}
    need(sorted(s["name"] for s in sections if s["flags"] & 2) == sorted(ALLOCATABLE), "ELF_SECTIONS",
         "allocatable sections differ from the approved five (no .data or .bss allowed)")
    need(machine == 252, "ELF_PROFILE", f"e_machine {machine} is not C-SKY")
    attributes = by[".csky.attributes"]
    need(b"ck802" in elf[attributes["off"]:attributes["off"] + attributes["size"]], "ELF_PROFILE", "ELF is not tagged ck802")
    vad = by[".vad_text"]
    need(vad["type"] == 1 and vad["flags"] == 6 and vad["align"] == 4 and vad["size"] % 2 == 0, "ELF_SECTIONS", ".vad_text is not 4-aligned PROGBITS AX")
    need(vad["addr"] == module_base, "MODULE_BASE_MISMATCH", f".vad_text is linked at {vad['addr']:08x}, not {module_base:08x}")
    module = elf[vad["off"]:vad["off"] + vad["size"]]
    need(len(module) == vad["size"], "ELF_STRUCTURE", ".vad_text runs past the file")

    image_end = BASE_VA + len(frozen)
    reservations = frozen_reservations(inputs["frozen_ld"].decode())
    module_end = module_base + len(module)
    need(module_base % 4 == 0, "MODULE_ALIGNMENT", "module base is not 4-byte aligned")
    need(module_base >= image_end, "OVERLAP_IMAGE", f"module {module_base:08x}.. overlaps the baseline image ending {image_end:08x}")
    for name, (start, end) in reservations.items():
        need(module_end <= start or module_base >= end, "OVERLAP_RESERVATION", f"module overlaps the frozen {name} reservation {start:08x}..{end:08x}")
    need(len(module) <= capacity, "CAPACITY", f"module is {len(module)} bytes, capacity {capacity}")
    out_len = -(-((module_base - BASE_VA) + len(module)) // ALIGN) * ALIGN
    need(out_len < IMAGE_LIMIT, "IMAGE_TOO_LARGE", f"result {out_len} bytes reaches {IMAGE_LIMIT}")

    header = decoder.image_header(frozen, True)
    fields = struct.unpack_from("<I4sHHHHIIII", frozen, 8)
    need(fields[4] == fields[5] == fields[6] == fields[7] == 0, "HEADER_CHECKSUMMED",
         "inner header carries checksums or sizes; this builder does not know how to update them")

    symbols_by_name = elf_symbols(elf, sections)
    symbols = {}
    for h in HUNKS:
        if h["symbol"]:
            need(len(symbols_by_name.get(h["symbol"], [])) == 1, "SYMBOL_UNIQUE", f"{h['symbol']} is not defined exactly once")
            symbols[h["symbol"]] = symbols_by_name[h["symbol"]][0]
    frozen_symbols = parse_symbols_txt(inputs["frozen_symbols"].decode())
    sdk_symbols = parse_symbols_txt(inputs["sdk_symbols"].decode())
    for name in IMPORTED_ALIASES:
        need(symbols_by_name[name] == [frozen_symbols[name]], "ALIAS_MISMATCH", f"{name} differs from the frozen address")
    for name, value in symbols.items():
        need(sdk_symbols.get(name) == value, "SYMBOL_MISMATCH", f"{name}: ELF symtab and nm output disagree")

    hunk_ranges = sorted((h["address"], h["address"] + h["width"]) for h in HUNKS)
    for (a0, a1), (b0, b1) in zip(hunk_ranges, hunk_ranges[1:]):
        need(a1 <= b0, "HUNK_OVERLAP", "approved hunks overlap each other")
    for h in HUNKS:
        start, end = h["address"], h["address"] + h["width"]
        need(BASE_VA <= start and end <= image_end, "HUNK_OUTSIDE_IMAGE", h["role"])
        need(end <= module_base or start >= module_end, "OVERLAP_IMAGE", f"hunk {h['role']} lies inside the module")
        for name, (r0, r1) in reservations.items():
            need(end <= r0 or start >= r1, "OVERLAP_RESERVATION", f"hunk {h['role']} lies inside the frozen {name} reservation")

    edits = []
    for h in HUNKS:
        off = h["address"] - BASE_VA
        need(frozen[off:off + h["width"]].hex() == h["before"], f"PREIMAGE_MISMATCH:{h['role']}",
             f"baseline bytes at {h['address']:08x} are {frozen[off:off + h['width']].hex()}, expected {h['before']}")
        section = by[h["section"]]
        rel = h["address"] - section["addr"]
        need(0 <= rel and rel + h["width"] <= section["size"], "HUNK_OUTSIDE_SECTION", h["role"])
        after = elf[section["off"] + rel:section["off"] + rel + h["width"]]
        need(after.hex() == h["after"], f"ELF_HUNK_MISMATCH:{h['role']}", f"ELF bytes {after.hex()} differ from approved {h['after']}")
        edits.append((off, after))
    constructor = by[".constructor_edits"]
    taken = {(h["address"] - constructor["addr"], h["address"] - constructor["addr"] + h["width"]) for h in HUNKS if h["section"] == ".constructor_edits"}
    padding = [b for i, b in enumerate(elf[constructor["off"]:constructor["off"] + constructor["size"]])
               if not any(a <= i < z for a, z in taken)]
    need(len(padding) == 124 and not any(padding), "CONSTRUCTOR_PADDING_NONZERO", "constructor padding is not 124 zero bytes")

    branches = {}
    for h in HUNKS:
        if h["symbol"]:
            target = decode_bsr(bytes.fromhex(h["after"]), h["address"])
            need(target == symbols[h["symbol"]], "BRANCH_TARGET_MISMATCH", f"{h['role']} decodes to {target:08x}, symbol is {symbols[h['symbol']]:08x}")
            # The constructor decision site held "cmpnei r4,0; bf 0x1021038" (not a bsr); the other three held a bsr.
            replaced_bsr = h["role"] != "final_publication_decision"
            branches[h["role"]] = dict(site=h["address"], symbol=h["symbol"], target=target,
                                       old_target=decode_bsr(bytes.fromhex(h["before"]), h["address"]) if replaced_bsr else None)

    result = bytearray(frozen)
    result += bytearray((module_base - BASE_VA) - len(frozen))
    result += module
    result += bytearray(out_len - len(result))
    for off, after in edits:
        result[off:off + len(after)] = after
    plan = dict(module=bytes(module), module_base=module_base, out_len=out_len, symbols=symbols, branches=branches,
                frozen_symbols=frozen_symbols, reservations=reservations, image_end=image_end, header=header,
                constructor_padding=len(padding), elf_flags=e_flags)
    return result, plan


def listing(path, start, stop):
    run = subprocess.run([OBJDUMP, "-D", "-b", "binary", "-m", "csky", "--adjust-vma=0x01000000",
                          f"--start-address=0x{start:08x}", f"--stop-address=0x{stop:08x}", str(path)],
                         capture_output=True, text=True, timeout=120)
    need(run.returncode == 0, "OBJDUMP_FAILED", run.stderr)
    rows = {}
    for line in run.stdout.splitlines():
        parts = line.split("\t")
        m = re.match(r"^\s*([0-9a-f]+):$", parts[0])
        if m and len(parts) >= 3:
            rows[int(m.group(1), 16)] = (parts[2].strip(), parts[3].strip() if len(parts) > 3 else "", parts[4].strip() if len(parts) > 4 else "")
    return rows, run.stdout


def word_at(data, va):
    return struct.unpack_from("<I", data, va - BASE_VA)[0]


def readback(path, frozen, plan, decoder):
    """Everything below is derived from the bytes on disk, not from construct()'s buffer."""
    need(sha(Path(OBJDUMP).read_bytes()) == PIN_OBJDUMP, "PIN_MISMATCH:objdump", "toolchain objdump changed")
    data = Path(path).read_bytes()
    n, base, module = len(frozen), plan["module_base"], plan["module"]
    need(len(data) == plan["out_len"] and len(data) % ALIGN == 0, "READBACK_LENGTH", f"{len(data)} bytes")

    ranges = [(h["address"] - BASE_VA, h["width"], h["role"]) for h in HUNKS]
    diffs = [i for i in range(n) if data[i] != frozen[i]]
    inside = {role: 0 for _, _, role in ranges}
    outside = []
    for i in diffs:
        owner = next((role for a, w, role in ranges if a <= i < a + w), None)
        if owner:
            inside[owner] += 1
        else:
            outside.append(i)
    need(not outside, "DIFF_OUTSIDE_HUNKS", f"unapproved changed bytes at {[hex(i) for i in outside[:8]]}")
    reverted = bytearray(data[:n])
    for a, w, _ in ranges:
        reverted[a:a + w] = frozen[a:a + w]
    need(sha(bytes(reverted)) == sha(frozen), "REVERT_MISMATCH", "reverting the approved hunks does not restore the baseline")
    mod_off = base - BASE_VA
    need(data[n:mod_off] == bytes(mod_off - n), "GAP_NOT_ZERO", "bytes between the baseline and the module are not zero")
    need(data[mod_off:mod_off + len(module)] == module, "MODULE_MISMATCH", "module bytes differ from the ELF .vad_text")
    need(data[mod_off + len(module):] == bytes(len(data) - mod_off - len(module)), "PAD_NOT_ZERO", "alignment padding is not zero")

    header_before, header_after = decoder.image_header(frozen, True), decoder.image_header(data, True)
    need(header_before == header_after and data[:48] == frozen[:48], "HEADER_CHANGED", "inner header changed")
    scan = {name: frozen.count(struct.pack("<I", value)) for name, value in
            (("baseline_length", n), ("baseline_end_va", BASE_VA + n), ("restore_module_end_offset", 0x12E1F4), ("restore_module_end_va", 0x0112E1F4))}

    rows, text = listing(path, 0x01021024, 0x010210F0)
    stub = plan["symbols"]["late_publication_stub"]
    wrapper = plan["symbols"]["h1e_vad_native_poll_bridge"]
    stub_rows, stub_text = listing(path, stub, stub + 0x1C)
    wrapper_rows, wrapper_text = listing(path, wrapper, wrapper + 0x14)
    site_rows = {}
    site_text = ""
    for h in HUNKS:
        if h["symbol"] and h["section"] != ".constructor_edits":
            r, t = listing(path, h["address"], h["address"] + 4)
            site_rows[h["address"]] = r[h["address"]]
            site_text += t

    branches = []
    for role, b in plan["branches"].items():
        raw = data[b["site"] - BASE_VA:b["site"] - BASE_VA + 4]
        py_target = decode_bsr(raw, b["site"])
        row = rows.get(b["site"]) or site_rows.get(b["site"])
        need(row is not None and row[0] == "bsr", "OBJDUMP_BSR", f"{role}: objdump shows no bsr at {b['site']:08x}")
        objdump_target = int(row[1].split()[0], 16)
        need(py_target == objdump_target == b["target"] == plan["symbols"][b["symbol"]], "BRANCH_TARGET_MISMATCH", role)
        branches.append(dict(role=role, site=f"{b['site']:08x}", raw_file_bytes=raw.hex(), link_register=f"{b['site'] + 4:08x}",
                             symbol=b["symbol"], target_python=f"{py_target:08x}", target_objdump=f"{objdump_target:08x}",
                             target_elf_symbol=f"{plan['symbols'][b['symbol']]:08x}",
                             baseline_target=None if b["old_target"] is None else f"{b['old_target']:08x}"))
    by_role = {b["role"]: b for b in branches}
    need(int(by_role["native_parser_dispatch"]["baseline_target"], 16) == plan["frozen_symbols"]["console630_parser_hook"] and
         int(by_role["native_response_dispatch"]["baseline_target"], 16) == plan["frozen_symbols"]["console630_response_hook"],
         "BASELINE_HOOK_TARGET", "replaced hook targets are not the frozen baseline hook functions")
    base_rows, _ = listing(Path(PATHS["frozen"]), 0x01021070, 0x01021074)
    need(base_rows[0x01021070][:2] == ("cmpnei", "r4, 0") and base_rows[0x01021072][0] == "bf"
         and int(base_rows[0x01021072][1].split()[0], 16) == 0x01021038, "BASELINE_DECISION",
         "baseline 0x01021070 is not 'cmpnei r4,0; bf 0x01021038'")
    getter = int(by_role["existing_native_getter_bridge"]["baseline_target"], 16)
    lrw = [(a, r) for a, r in wrapper_rows.items() if r[0] == "lrw" and r[1].startswith("r1, ")]
    need(len(lrw) == 1, "WRAPPER_GETTER", "poll bridge does not load exactly one getter literal in r1")
    literal = int(lrw[0][1][1].split(",")[1].strip(), 16)
    pool = int(lrw[0][1][2].split("//")[1].strip().replace("0x", ""), 16)
    need(literal == getter == word_at(data, pool), "WRAPPER_GETTER", f"wrapper loads {literal:08x}, baseline call went to {getter:08x}")

    expect = {0x01021054: ("movi", "r0, 96"), 0x0102105C: ("mov", "r7, r0"), 0x0102106A: ("mov", "r0, r7"),
              0x0102109E: ("movi", "r2, 96"), 0x010210A8: ("mov", "r7, r7"), 0x010210DE: ("mov", "r3, r7")}
    for va, want in expect.items():
        need(rows[va][:2] == want, f"CONSTRUCTOR_INSN:{va:08x}", f"{rows[va][:2]} is not {want}")
    need(rows[0x01021070][0] == "bsr" and int(rows[0x01021070][1].split()[0], 16) == stub, "CONSTRUCTOR_INSN:01021070", "decision hook is not a bsr to the stub")
    alloc = decode_movi(data[0x01021054 - BASE_VA:0x01021054 - BASE_VA + 2])
    clear = decode_movi(data[0x0102109E - BASE_VA:0x0102109E - BASE_VA + 2])
    old_alloc = decode_movi(frozen[0x01021054 - BASE_VA:0x01021054 - BASE_VA + 2])
    old_clear = decode_movi(frozen[0x0102109E - BASE_VA:0x0102109E - BASE_VA + 2])
    tail_offset, tail_bytes = 0x40, 32
    need(alloc == (0, 0x60) and clear == (2, 0x60) and old_alloc == (0, 0x40) and old_clear == (2, 0x40), "TAIL_SIZE", "allocation and clear immediates are not 0x40 to 0x60")
    need(tail_offset + tail_bytes == alloc[1] and tail_offset % 4 == 0 and tail_bytes % 4 == 0, "TAIL_SIZE", "tail does not fit exactly in the new allocation")

    shape = [(0, "cmpnei", "r4, 0"), (2, "bt", f"0x{stub + 0xc:x}"), (4, "st.w", "r7, (r5, 0x0)"), (6, "lrw", "r15, 0x1021038"),
             (10, "jmp", "r15"), (12, "lrw", "r15, 0x1021074"), (16, "jmp", "r15")]
    for rel, mnemonic, operands in shape:
        need(stub_rows[stub + rel][:2] == (mnemonic, operands), f"STUB_INSN:{rel}", f"{stub_rows[stub + rel][:2]} is not {(mnemonic, operands)}")
    for rel, target in ((6, 0x01021038), (12, 0x01021074)):
        pool_va = int(stub_rows[stub + rel][2].split("//")[1].strip().replace("0x", ""), 16)
        need(word_at(data, pool_va) == target, "STUB_LITERAL", f"literal at {pool_va:08x} is not {target:08x}")
    unchanged = {va: data[va - BASE_VA:va - BASE_VA + 2] == frozen[va - BASE_VA:va - BASE_VA + 2] for va in (0x01021038, 0x01021074, 0x0102105A, 0x0102105E)}
    need(all(unchanged.values()), "CONSTRUCTOR_TARGETS_CHANGED", "success return or free sequence bytes changed")
    need(rows[0x01021074][0] == "bsr" and rows[0x01021038][0] == "movi", "CONSTRUCTOR_TARGETS", "free sequence or success return not where the stub jumps")

    return dict(
        sha256=sha(data), bytes=len(data),
        differing_bytes_in_baseline_region=len(diffs), differing_bytes_inside_approved_hunks=len(diffs) - len(outside),
        differing_bytes_outside_hunks=len(outside), differing_bytes_per_hunk=inside,
        appended=dict(zero_gap_bytes=mod_off - n, module_bytes=len(module), alignment_pad_bytes=len(data) - mod_off - len(module)),
        header=dict(before=header_before, after=header_after, bytes_0_47_identical=True,
                    inner_length_or_checksum_update_required=False,
                    reason="header_sum, body_sum, body_size and tail_size are all zero in the baseline: the image is unchecksummed"),
        length_literal_scan_in_baseline=scan,
        branches=branches,
        constructor=dict(
            allocation=dict(before_movi=dict(register=f"r{old_alloc[0]}", imm=old_alloc[1]), after_movi=dict(register=f"r{alloc[0]}", imm=alloc[1])),
            clear=dict(before_movi=dict(register=f"r{old_clear[0]}", imm=old_clear[1]), after_movi=dict(register=f"r{clear[0]}", imm=clear[1])),
            telemetry_tail=dict(object_offset=tail_offset, bytes=tail_bytes, ends_at=tail_offset + tail_bytes, allocation_bytes=alloc[1],
                                offset_four_byte_aligned=True, base_alignment="allocator behavior, not verified"),
            stub_address=f"{stub:08x}",
            stub_flow=dict(
                success="r4 == 0: falls through, st.w r7,(r5,0) publishes the private pointer, then lrw r15,0x01021038 / jmp r15 to the unchanged success return",
                failure="r4 != 0: bt to the second lrw, then lrw r15,0x01021074 / jmp r15 to the unchanged free sequence; r0 is not written by the stub and holds the private pointer",
                allocation_null="r7 == 0: the unchanged null check at 0x0102106c exits before the stub, no free and no publication"),
            unchanged_sites=dict((f"{k:08x}", v) for k, v in unchanged.items())),
        listings=dict(constructor_and_hooks=text, stub=stub_text, poll_bridge=wrapper_text, hook_sites=site_text),
    )


def write_new(path, data):
    with open(path, "xb") as handle:  # 'x' refuses to overwrite
        handle.write(data)


def publish_no_clobber(partial, destination):
    """Atomically publish a same-directory file without replacing a destination."""
    # link(2) fails atomically if destination already exists. Both paths are in OUT,
    # so they share a filesystem; unlink only after the destination link succeeds.
    os.link(partial, destination)
    os.unlink(partial)


def main():
    OUT.mkdir(exist_ok=True)
    final = OUT / OUTPUT_NAME
    manifest_path = OUT / "acceptance-readback.json"
    listing_path = OUT / "readback-listings.txt"
    for target in (final, manifest_path, listing_path, final.with_name(OUTPUT_NAME + ".partial"), final.with_name(OUTPUT_NAME + ".REJECTED")):
        need(not target.exists(), "OUTPUT_EXISTS", f"{target} exists; this builder never overwrites")
    decoder = load_decoder()
    inputs = {key: PATHS[key].read_bytes() for key in PINS}
    result, plan = construct(inputs, decoder=decoder)

    partial = final.with_name(OUTPUT_NAME + ".partial")
    write_new(partial, bytes(result))
    try:
        evidence = readback(partial, inputs["frozen"], plan, decoder)
        need(evidence["sha256"] == sha(bytes(result)), "READBACK_HASH", "file on disk differs from the in-memory result")
    except BaseException as readback_error:
        try:
            publish_no_clobber(partial, final.with_name(OUTPUT_NAME + ".REJECTED"))
        except OSError as publication_error:
            raise readback_error from publication_error
        raise
    need(not final.exists(), "OUTPUT_EXISTS", str(final))
    publish_no_clobber(partial, final)
    need(sha(final.read_bytes()) == evidence["sha256"], "READBACK_HASH", "final file differs after rename")

    listings = evidence.pop("listings")
    write_new(listing_path, "\n".join(f"===== {k}\n{v}" for k, v in listings.items()).encode())
    receipt = json.loads(inputs["link_receipt"])
    manifest = dict(
        status="offline_experimental_candidate_NOT_INSTALL_blocked",
        schema=1,
        statement="Decoded system image candidate only. No container, OTA, version change, flash, hardware run or flashability claim.",
        inputs={k: dict(path=str(PATHS[k].relative_to(LAB)), sha256=sha(v), bytes=len(v)) for k, v in inputs.items()},
        tools=dict(python=sys.version.split()[0], decode_randomizer_sha256=PIN_DECODER, objdump_sha256=PIN_OBJDUMP,
                   gcc_libgcc_archive_sha256=receipt["libgcc_archive"]["sha256"], compile_flags=receipt["compile_flags"]),
        output=dict(path=str(final.relative_to(LAB)), sha256=evidence["sha256"], bytes=evidence["bytes"], baseline_bytes=len(inputs["frozen"])),
        module=dict(base=f"{plan['module_base']:08x}", bytes=len(plan["module"]), end=f"{plan['module_base'] + len(plan['module']):08x}",
                    capacity_limit_bytes=MODULE_CAPACITY, source_section=".vad_text",
                    baseline_image_end=f"{plan['image_end']:08x}",
                    frozen_reservations={k: [f"{a:08x}", f"{b:08x}"] for k, (a, b) in plan["reservations"].items()},
                    symbols={k: f"{v:08x}" for k, v in plan["symbols"].items()},
                    note="0x0112f000 is the frozen-baseline placement only, not a reservation in any other pipeline"),
        hunks=dict(count=len(HUNKS), declared_bytes=sum(h["width"] for h in HUNKS), constructor_padding_bytes_excluded=plan["constructor_padding"]),
        readback=evidence,
        rejection_checks="rejection-checks.json (separate run of reject_checks.py)",
        assumptions=[
            "Normal C-SKY callee-save ABI: r4 to r7 survive the zeroing wrapper at 0x0008009e, the GPIO lookup at 0x0108e250 and the indirect GPIO method; their bodies are not read",
            "The delayed-publication prerequisites asserted by H1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1 hold on the target",
            "The single startup order of early-reader-order/REPORT.md holds, and no free of a published object occurs",
            "The 0x60-byte allocation succeeds and is 4-byte aligned on the target",
            "console630_f11a.c behaves like the replaced console630 for 0xf117 to 0xf119; this rests on earlier host checks, not on this builder",
        ],
        production_gates=[
            "BLOCKED container: zephyr.bin size and CRC32 in ota.xml, container CRCs, FVER and version are not rebuilt here, and build_containers.py pins the old system hash",
            "BLOCKED flash geometry: system partition capacity for the larger image and the 0x0112f000 placement against the other pipeline's layout are not reconciled",
            "BLOCKED lifetime: no proof that a published object is never freed or replaced; teardown, ROM and interrupt users are unaudited",
            "BLOCKED callee-save: r4 to r7 preservation across unread ROM and indirect callees is an assumption",
            "BLOCKED ordering: compiler barriers only; the PSR guard masks same-core interrupts only; no exclusion of another core or the DSP",
            "BLOCKED execution: nothing ran on a CK802 or a device; no f11a response was observed; runtime framing inputs (halfword 0x867d6) unbound",
            "BLOCKED semantics: the recorded word has no established speech or VAD meaning",
            "NOT DONE: delivery-gate and adversarial review of this builder",
        ],
    )
    write_new(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    print(json.dumps(dict(status=manifest["status"], output=str(final), sha256=evidence["sha256"], bytes=evidence["bytes"],
                          differing_bytes_inside_hunks=evidence["differing_bytes_inside_approved_hunks"],
                          differing_bytes_outside_hunks=evidence["differing_bytes_outside_hunks"],
                          appended=evidence["appended"])))


if __name__ == "__main__":
    try:
        main()
    except BuildRejected as error:
        print(f"REJECTED {error}", file=sys.stderr)
        sys.exit(3)
