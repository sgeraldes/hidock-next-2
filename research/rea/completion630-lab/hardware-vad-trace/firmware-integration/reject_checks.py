"""Representative fail-closed checks for build_candidate.construct().

Each case tampers one input in memory, recomputes the pins and the manifest bindings so that
the pin and binding checks pass, and expects the NAMED later check to be the one that rejects.
Nothing is written except rejection-checks.json (created with 'x'). Run in WSL after the build:
    python3 reject_checks.py
"""
import sys

sys.dont_write_bytecode = True

import copy
import json
import struct
from pathlib import Path

import build_candidate as b

HERE = Path(__file__).resolve().parent


def consistent(inputs, manifest=None):
    """Return inputs whose manifest, pins and hashes agree with each other (so only the later check can fire)."""
    inputs = dict(inputs)
    doc = json.loads(inputs["manifest"]) if manifest is None else manifest
    doc["source_sha256"] = b.sha(inputs["frozen"])
    doc["elf_sha256"] = b.sha(inputs["elf"])
    inputs["manifest"] = json.dumps(doc, indent=2).encode()
    return inputs, {k: b.sha(v) for k, v in inputs.items() if k in b.PINS}


def run(label, expect, mutate, **kwargs):
    inputs = {key: b.PATHS[key].read_bytes() for key in b.PINS}
    inputs = mutate(inputs)
    inputs, pins = consistent(inputs)
    try:
        b.construct(inputs, pins=pins, decoder=DECODER, **kwargs)
    except b.BuildRejected as error:
        ok = error.code.split(":")[0] in expect
        return dict(case=label, expected_codes=sorted(expect), rejected=True, code=error.code, reason=str(error), as_expected=ok)
    return dict(case=label, expected_codes=sorted(expect), rejected=False, as_expected=False)


def flip_frozen(inputs):
    data = bytearray(inputs["frozen"])
    data[0x0102105C - b.BASE_VA] ^= 0x01
    inputs["frozen"] = bytes(data)
    return inputs


def move_module(inputs):
    sections, _, _ = b.elf_sections(inputs["elf"])
    header = next(s for s in sections if s["name"] == ".vad_text")["hdr_off"]
    data = bytearray(inputs["elf"])
    struct.pack_into("<I", data, header + 12, 0x0112E000)
    inputs["elf"] = bytes(data)
    return inputs


def smuggle_hunk(inputs):
    doc = json.loads(inputs["manifest"])
    doc["hunks"].append(dict(address="01021058", width=2, role="padding_smuggle", before_hex="0000", after_hex="1111"))
    inputs["manifest"] = json.dumps(doc).encode()
    return inputs


def edit_elf_instruction(inputs):
    sections, _, _ = b.elf_sections(inputs["elf"])
    section = next(s for s in sections if s["name"] == ".constructor_edits")
    data = bytearray(inputs["elf"])
    data[section["off"] + (0x01021054 - section["addr"])] ^= 0x01
    inputs["elf"] = bytes(data)
    return inputs


def dirty_padding(inputs):
    sections, _, _ = b.elf_sections(inputs["elf"])
    section = next(s for s in sections if s["name"] == ".constructor_edits")
    data = bytearray(inputs["elf"])
    data[section["off"] + 4] = 0xAA
    inputs["elf"] = bytes(data)
    return inputs


def same(inputs):
    return inputs


DECODER = b.load_decoder()
cases = [
    run("baseline byte at a hunk preimage differs", {"PREIMAGE_MISMATCH"}, flip_frozen),
    run("module linked inside the baseline image and frozen restore reservation", {"OVERLAP_IMAGE", "OVERLAP_RESERVATION"}, move_module, module_base=0x0112E000),
    run("module larger than the capacity limit", {"CAPACITY"}, same, capacity=0x100),
    run("manifest carries an extra hunk inside the constructor padding", {"HUNK_SET_NOT_APPROVED"}, smuggle_hunk),
    run("ELF instruction differs from the approved hunk", {"ELF_HUNK_MISMATCH"}, edit_elf_instruction),
    run("constructor padding is not zero", {"CONSTRUCTOR_PADDING_NONZERO"}, dirty_padding),
]
final = b.OUT / b.OUTPUT_NAME
try:
    b.write_new(final, b"must not be written")
    refusal = dict(case="output file already exists", rejected=False, as_expected=False)
except FileExistsError as error:
    refusal = dict(case="output file already exists", rejected=True, code="FileExistsError", reason=str(error), as_expected=True)
cases.append(refusal)
report = dict(status="all_rejected_as_expected" if all(c["as_expected"] for c in cases) else "UNEXPECTED_RESULT", cases=cases)
with open(HERE / "rejection-checks.json", "x") as handle:
    handle.write(json.dumps(report, indent=2) + "\n")
print(json.dumps(dict(status=report["status"], cases=[(c["case"], c.get("code")) for c in cases])))
sys.exit(0 if report["status"] == "all_rejected_as_expected" else 1)
