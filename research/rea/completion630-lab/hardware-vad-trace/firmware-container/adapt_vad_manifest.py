#!/usr/bin/env python3
"""Adapt pinned VAD readback evidence to the container packer's NOTINSTALL contract.

This script reads the accepted integration evidence. It does not build or alter a decoded system
image. The emitted manifest is created with exclusive-create and is placed beside the decoded
candidate so package_vad_container.py can consume it.
"""
import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
VAD = HERE.parent
LAB = HERE.parents[1]
REPO = HERE.parents[4]
INTEGRATION = VAD / "firmware-integration"
OUTPUT = INTEGRATION / "output"

ACCEPTANCE_PATH = OUTPUT / "acceptance-readback.json"
CANDIDATE_PATH = OUTPUT / "system-decoded-vad-ck802-NOTINSTALL.bin"
READBACK_LISTINGS_PATH = OUTPUT / "readback-listings.txt"
BASELINE_PATH = LAB / "firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin"
SPARSE_PATH = VAD / "native-ck802-candidate/sdk-profile/output/sparse-source-hunks.json"
ELF_PATH = VAD / "native-ck802-candidate/sdk-profile/output/conditional-source-ck802-sdk-NOTINSTALL.elf"
LINK_RECEIPT_PATH = VAD / "native-ck802-candidate/sdk-profile/output/link-receipt.json"
MANIFEST_PATH = OUTPUT / "container-packing-input-manifest.json"

SCHEMA = "h1e-vad-candidate-manifest-v1"
BASE_VA = 0x01000000
MODULE_VA = 0x0112F000

PINS = {
    "acceptance_readback": "551da1308d6791bd92d1d143f16494015e53efe18a2fbde1708c03722d41c84b",
    "baseline_system": "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f",
    "candidate_system": "ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0",
    "sdk_elf": "576d7ac2b30755e41c6e23ba1a5cb3e6b7e65afb1c7c115b6f0be3a3b1844366",
    "sparse_hunks": "73ce3d0889955701b2a7874e91cd653f30439054a5b3f1e273b4327aeed3ed35",
    "sdk_link_receipt": "7458d9c8c9e755753e252274f23cf5649a949515f71d98ab40fc0dd8d9e77a86",
    "readback_listings": "73e58af2a614cd01a1c259542b0f5e9c2c5907e0fe86321036623ac9e4710fae",
    "root_packing_manifest": "d69bce4ce171ba8f71da0659ea39b83a1204a050b8aa4328d5136229f55d43ab",
    "decoder": "3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5",
    "objdump": "e6aad5acbaf952d53ed470878b95acfcffeca7c4e001fe7bbf1c0dce4fd07cdd",
    "libgcc_archive": "f0f80000e86c05cc3b7120762bad7b899f22ab1b3469eb83f8025520d31f40f3",
}

EXPECTED_INPUTS = {
    "frozen": ("firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin", PINS["baseline_system"], 1237504),
    "frozen_symbols": ("firmware/restore-build393988/generation-restore4/symbols.txt", "a850bd25db4bab4c7e16b58c6ac5d5241c156a3fabde18aa187f167e09641e72", 4145),
    "frozen_ld": ("firmware/restore-build393988/generation-restore4/module.ld", "90d5bc9c11850b87d123fb5eb51589645feea4a15d5cccc5896a8f9fd245840f", 1490),
    "elf": ("hardware-vad-trace/native-ck802-candidate/sdk-profile/output/conditional-source-ck802-sdk-NOTINSTALL.elf", PINS["sdk_elf"], 24340),
    "manifest": ("hardware-vad-trace/native-ck802-candidate/sdk-profile/output/sparse-source-hunks.json", PINS["sparse_hunks"], 3122),
    "sdk_symbols": ("hardware-vad-trace/native-ck802-candidate/sdk-profile/output/symbols.txt", "9765956593197cbe01db81b88bdf00a7bf1e327027d4d9d53dd7d47ad501c90d", 1878),
    "link_receipt": ("hardware-vad-trace/native-ck802-candidate/sdk-profile/output/link-receipt.json", PINS["sdk_link_receipt"], 3653),
}

EXPECTED_HUNKS = [
    ("01020b62", 4, "existing_native_getter_bridge", "ffe303f8", "08e01575"),
    ("01021054", 2, "allocate_96", "4030", "6030"),
    ("0102105c", 2, "retain_private_pointer", "00b5", "c36d"),
    ("0102106a", 2, "private_failure_pointer", "0095", "1f6c"),
    ("01021070", 4, "final_publication_decision", "403ce30f", "08e0c274"),
    ("0102109e", 2, "zero_96", "4032", "6032"),
    ("010210a8", 2, "retain_private_pointer_after_zero", "e095", "df6d"),
    ("010210de", 2, "private_gpio_object", "6095", "df6c"),
    ("0103907a", 4, "native_response_dispatch", "07e08194", "07e04fb4"),
    ("0103a996", 4, "native_parser_dispatch", "07e0cf87", "07e09da7"),
]

EXPECTED_DIFFS_PER_HUNK = {
    "existing_native_getter_bridge": 4,
    "allocate_96": 1,
    "retain_private_pointer": 2,
    "private_failure_pointer": 2,
    "final_publication_decision": 4,
    "zero_96": 1,
    "retain_private_pointer_after_zero": 2,
    "private_gpio_object": 2,
    "native_response_dispatch": 2,
    "native_parser_dispatch": 2,
}


class AdapterError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AdapterError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_json(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError(f"cannot read JSON {path}: {exc}") from exc


def pinned_bytes(label, path, expected_sha):
    require(path.is_file(), f"missing pinned input {label}: {path}")
    data = path.read_bytes()
    require(sha256(data) == expected_sha, f"PIN_MISMATCH:{label}")
    return data


def validate_declared_inputs(acceptance):
    inputs = acceptance.get("inputs")
    require(isinstance(inputs, dict) and set(inputs) == set(EXPECTED_INPUTS), "acceptance input set differs from pinned CK802 inputs")
    for name, (relpath, digest, size) in EXPECTED_INPUTS.items():
        entry = inputs[name]
        require(entry == {"path": relpath, "sha256": digest, "bytes": size}, f"acceptance pin declaration differs for {name}")
        data = pinned_bytes(name, LAB / relpath, digest)
        require(len(data) == size, f"acceptance input size mismatch for {name}")

    tools = acceptance.get("tools")
    require(isinstance(tools, dict), "acceptance tool pins missing")
    require(tools.get("decode_randomizer_sha256") == PINS["decoder"], "decoder pin declaration mismatch")
    require(tools.get("objdump_sha256") == PINS["objdump"], "objdump pin declaration mismatch")
    require(tools.get("gcc_libgcc_archive_sha256") == PINS["libgcc_archive"], "libgcc pin declaration mismatch")
    decoder = pinned_bytes("decoder", REPO / "research/rea/decode_randomizer.py", PINS["decoder"])
    require(bool(decoder), "pinned decoder is empty")


def elf_sections(elf):
    require(elf[:7] == b"\x7fELF\x01\x01\x01", "SDK module is not little-endian ELF32")
    (_type, machine, _version, _entry, _phoff, shoff, _flags, _ehsize, _phentsize,
     _phnum, shentsize, shnum, shstrndx) = struct.unpack_from("<HHIIIIIHHHHHH", elf, 16)
    require(machine == 252, "SDK ELF is not C-SKY")
    require(shentsize == 40 and shnum > 0 and shstrndx < shnum, "unexpected SDK ELF section table")
    headers = [struct.unpack_from("<10I", elf, shoff + i * shentsize) for i in range(shnum)]
    strings_header = headers[shstrndx]
    strings = elf[strings_header[4]:strings_header[4] + strings_header[5]]
    result = {}
    for name_off, kind, flags, address, offset, size, _link, _info, alignment, _entsize in headers:
        require(name_off < len(strings), "ELF section name offset out of bounds")
        name = strings[name_off:].split(b"\0", 1)[0].decode("ascii")
        if name:
            require(offset + size <= len(elf), f"ELF section {name} is out of file bounds")
            result[name] = {"kind": kind, "flags": flags, "address": address,
                            "offset": offset, "size": size, "alignment": alignment,
                            "data": elf[offset:offset + size]}
    return result


def validate_reference_manifest(reference, candidate_bytes):
    require(reference.get("schema") == SCHEMA and reference.get("accepted") is True, "root reference manifest is not accepted under the packer schema")
    require(reference.get("acceptance_scope") == "decoded_structural_readback_only_NOTINSTALL", "root reference acceptance scope changed")
    require(reference.get("installable") is False, "root reference manifest claims installable")
    require(reference.get("baseline_system_sha256") == PINS["baseline_system"], "root reference baseline pin changed")
    require(reference.get("candidate_system", {}).get("sha256") == sha256(candidate_bytes), "root reference candidate hash differs")
    require(reference.get("candidate_system", {}).get("bytes") == len(candidate_bytes), "root reference candidate length differs")
    require(reference.get("readback", {}).get("verified") is True, "root reference does not claim structural readback")
    require(reference.get("readback", {}).get("candidate_sha256") == sha256(candidate_bytes), "root reference readback hash differs")
    for gate in ("hardware_qualified", "production_lifetime_qualified", "combined_pipeline_layout_qualified"):
        require(reference.get(gate) is False, f"root reference safety gate {gate} is not closed")


def construct_changes(sparse, baseline, candidate, elf, acceptance):
    require(sparse.get("status") == "sparse_source_hunks_only_not_installable", "sparse manifest status changed")
    require(sparse.get("firmware_image_generated") is False and sparse.get("applied") is False, "sparse source hunks are not unapplied evidence")
    require(sparse.get("source_sha256") == PINS["baseline_system"] and sparse.get("elf_sha256") == PINS["sdk_elf"], "sparse source/ELF pins changed")
    require(sparse.get("profile") == "ck802-sdk-flags", "sparse profile is not the pinned CK802 SDK profile")
    require(sparse.get("constructor_section_bytes") == 140, "constructor section size differs")
    require(sparse.get("constructor_instruction_bytes") == 16, "constructor instruction byte count differs")
    require(sparse.get("excluded_constructor_padding_bytes") == 124, "constructor padding exclusion differs")
    require(sparse.get("total_instruction_bytes") == 28, "approved hunk byte total differs")
    require(acceptance.get("hunks") == {
        "count": 10,
        "declared_bytes": 28,
        "constructor_padding_bytes_excluded": 124,
    }, "acceptance hunk summary differs")

    hunks = sparse.get("hunks")
    require(isinstance(hunks, list) and len(hunks) == len(EXPECTED_HUNKS), "approved hunk count differs")
    changes = []
    allowed = bytearray(len(candidate))
    actual_per_hunk = {}
    for hunk, expected in zip(hunks, EXPECTED_HUNKS):
        address, width, role, before_hex, after_hex = expected
        require(hunk.get("address") == address and hunk.get("width") == width and hunk.get("role") == role,
                f"approved hunk identity changed at {address}")
        require(hunk.get("before_hex") == before_hex and hunk.get("after_hex") == after_hex,
                f"approved raw bytes changed at {address}")
        offset = int(address, 16) - BASE_VA
        before = bytes.fromhex(before_hex)
        after = bytes.fromhex(after_hex)
        require(len(before) == width and len(after) == width, f"approved hunk width mismatch at {address}")
        require(0 <= offset <= len(baseline) - width, f"approved hunk out of baseline bounds at {address}")
        require(baseline[offset:offset + width] == before, f"baseline hunk preimage mismatch at {address}")
        require(candidate[offset:offset + width] == after, f"candidate hunk readback mismatch at {address}")
        actual_per_hunk[role] = sum(a != b for a, b in zip(before, after))
        allowed[offset:offset + width] = b"\x01" * width
        changes.append({"offset": offset, "length": width, "new_sha256": sha256(after), "role": role})

    require(actual_per_hunk == EXPECTED_DIFFS_PER_HUNK, "per-hunk changed-byte counts differ")
    readback = acceptance.get("readback", {})
    require(readback.get("differing_bytes_per_hunk") == EXPECTED_DIFFS_PER_HUNK, "acceptance per-hunk readback differs")
    require(sparse.get("hunks") and sum(h[1] for h in EXPECTED_HUNKS) == 28, "approved hunk total is not 28 bytes")

    sections = elf_sections(elf)
    module = sections.get(".vad_text")
    constructor = sections.get(".constructor_edits")
    module_record = acceptance.get("module", {})
    require(module_record.get("base") == "0112f000" and module_record.get("bytes") == 2684
            and module_record.get("end") == "0112fa7c" and module_record.get("capacity_limit_bytes") == 16384
            and module_record.get("source_section") == ".vad_text"
            and module_record.get("baseline_image_end") == "0112e200", "accepted module placement/capacity evidence differs")
    require(module_record.get("frozen_reservations") == {
        "parser": ["0112b000", "0112c000"],
        "upload": ["0112c000", "0112d000"],
        "restore": ["0112d000", "0112f000"],
    }, "accepted frozen reservation metadata differs")
    require(module is not None and module["address"] == MODULE_VA and module["size"] == 2684 and module["alignment"] >= 4,
            "SDK .vad_text address/size/alignment differs from accepted readback")
    require(module["size"] <= module_record["capacity_limit_bytes"], "SDK .vad_text exceeds accepted example capacity")
    require(constructor is not None and constructor["size"] == 140, "SDK constructor section differs from accepted readback")
    constructor_start = int("01021054", 16)
    constructor_expected = bytearray(constructor["size"])
    constructor_covered = bytearray(constructor["size"])
    for address, width, _role, _before_hex, after_hex in EXPECTED_HUNKS:
        offset = int(address, 16) - constructor_start
        if 0 <= offset and offset + width <= constructor["size"]:
            raw = bytes.fromhex(after_hex)
            constructor_expected[offset:offset + width] = raw
            constructor_covered[offset:offset + width] = b"\x01" * width
    require(constructor["address"] == constructor_start, "SDK constructor section address differs")
    require(sum(constructor_covered) == 16, "constructor instruction coverage is not 16 bytes")
    require(constructor["data"] == bytes(constructor_expected), "SDK constructor section contains bytes outside approved instructions")
    require(all(value == 0 for value, covered in zip(constructor["data"], constructor_covered) if not covered),
            "excluded constructor padding is not all zero")
    require(sparse.get("excluded_constructor_padding_bytes") == 124, "excluded constructor padding total differs")
    require(len(candidate) == len(baseline) + 6272, "candidate growth differs from accepted readback")
    module_offset = MODULE_VA - BASE_VA
    gap_length = module_offset - len(baseline)
    require(gap_length == 3584 and candidate[len(baseline):module_offset] == bytes(gap_length), "candidate zero gap differs")
    module_end = module_offset + module["size"]
    require(candidate[module_offset:module_end] == module["data"], "candidate module bytes differ from SDK ELF .vad_text")
    pad_length = len(candidate) - module_end
    require(pad_length == 4 and candidate[module_end:] == bytes(pad_length), "candidate alignment padding differs")

    appended = [
        (len(baseline), gap_length, "zero_gap"),
        (module_offset, module["size"], "VAD_text"),
        (module_end, pad_length, "alignment_pad"),
    ]
    for offset, length, role in appended:
        block = candidate[offset:offset + length]
        require(length > 0 and len(block) == length, f"empty or short appended range {role}")
        allowed[offset:offset + length] = b"\x01" * length
        changes.append({"offset": offset, "length": length, "new_sha256": sha256(block), "role": role})

    differences = [i for i, (old, new) in enumerate(zip(baseline, candidate)) if old != new]
    require(len(differences) == 22, "candidate baseline-span changed-byte count differs")
    require(all(allowed[i] for i in differences), "candidate readback has changed bytes outside approved hunks")
    require(candidate[:48] == baseline[:48], "candidate system header differs from frozen baseline")
    require(readback.get("sha256") == PINS["candidate_system"] and readback.get("bytes") == len(candidate), "acceptance candidate readback pin differs")
    require(readback.get("differing_bytes_in_baseline_region") == 22, "acceptance changed-byte count differs")
    require(readback.get("differing_bytes_inside_approved_hunks") == 22 and readback.get("differing_bytes_outside_hunks") == 0,
            "acceptance hunk containment readback differs")
    require(readback.get("appended") == {"zero_gap_bytes": 3584, "module_bytes": 2684, "alignment_pad_bytes": 4},
            "acceptance appended-region layout differs")
    require(readback.get("header", {}).get("bytes_0_47_identical") is True, "acceptance header readback does not preserve bytes 0..47")
    require(readback.get("header", {}).get("inner_length_or_checksum_update_required") is False, "unexpected inner-header update claim")

    # The adapter must cover the complete append because the downstream packer requires every
    # grown byte to be allowlisted. These three ranges are independently tied to actual readback.
    require(all(allowed[len(baseline):]), "candidate append is not fully covered by derived evidence")
    return changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-out", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--compare-root-manifest", type=Path,
                        help="optional private root-assembly cross-check; never used as adapter evidence")
    args = parser.parse_args(argv)
    output_path = args.manifest_out.resolve()
    reference_path = args.compare_root_manifest.resolve() if args.compare_root_manifest else None

    require(INTEGRATION.resolve().is_dir(), f"missing firmware integration root: {INTEGRATION}")
    require(output_path.parent == OUTPUT.resolve(), "--manifest-out must be inside firmware-integration/output")
    require(not output_path.exists(), f"OUTPUT_EXISTS: refusing to overwrite {output_path}")

    acceptance_bytes = pinned_bytes("acceptance-readback", ACCEPTANCE_PATH, PINS["acceptance_readback"])
    readback_listings = pinned_bytes("readback-listings", READBACK_LISTINGS_PATH, PINS["readback_listings"])
    acceptance = load_json(ACCEPTANCE_PATH)
    require(acceptance.get("schema") == 1, "acceptance readback schema changed")
    validate_declared_inputs(acceptance)

    candidate_bytes = pinned_bytes("candidate-system", CANDIDATE_PATH, PINS["candidate_system"])
    baseline = pinned_bytes("baseline-system", BASELINE_PATH, PINS["baseline_system"])
    sparse_bytes = pinned_bytes("sparse-source-hunks", SPARSE_PATH, PINS["sparse_hunks"])
    elf = pinned_bytes("sdk-elf", ELF_PATH, PINS["sdk_elf"])
    pinned_bytes("sdk-link-receipt", LINK_RECEIPT_PATH, PINS["sdk_link_receipt"])
    sparse = load_json(SPARSE_PATH)

    output_record = acceptance.get("output", {})
    require(output_record == {
        "path": "hardware-vad-trace/firmware-integration/output/system-decoded-vad-ck802-NOTINSTALL.bin",
        "sha256": PINS["candidate_system"],
        "bytes": len(candidate_bytes),
        "baseline_bytes": len(baseline),
    }, "acceptance output path/hash/length differs")
    require(acceptance.get("production_gates") and any("geometry" in gate.lower() for gate in acceptance["production_gates"]),
            "known geometry gate is missing")
    require(any("lifetime" in gate.lower() for gate in acceptance["production_gates"]), "known lifetime gate is missing")
    require(any("execution" in gate.lower() or "device" in gate.lower() for gate in acceptance["production_gates"]),
            "known hardware/execution gate is missing")

    link_receipt = load_json(LINK_RECEIPT_PATH)
    require(link_receipt.get("status") == "conditional_offline_source_link_only", "SDK link receipt status changed")
    require(link_receipt.get("hardware_tested") is False and link_receipt.get("firmware_image_generated") is False,
            "SDK link receipt claims hardware or firmware generation")
    require(link_receipt.get("installed") is False and link_receipt.get("release_approved") is False,
            "SDK link receipt claims install or release approval")
    require(link_receipt.get("libgcc_archive", {}).get("sha256") == PINS["libgcc_archive"], "SDK libgcc pin differs")

    changes = construct_changes(sparse, baseline, candidate_bytes, elf, acceptance)
    if reference_path is not None:
        reference_bytes = pinned_bytes("optional-root-packing-manifest", reference_path, PINS["root_packing_manifest"])
        reference = load_json(reference_path)
        validate_reference_manifest(reference, candidate_bytes)
        reference_changes = reference.get("changes")
        require(isinstance(reference_changes, list), "root reference changes missing")
        normalized_reference = [{k: c[k] for k in ("offset", "length", "new_sha256", "role")} for c in reference_changes]
        require(changes == normalized_reference, "derived ranges differ from the optional root assembly cross-check")
    else:
        reference_bytes = None

    manifest = {
        "schema": SCHEMA,
        "accepted": True,
        "acceptance_scope": "decoded_structural_readback_only_NOTINSTALL",
        "installable": False,
        "baseline_system_sha256": PINS["baseline_system"],
        "candidate_system": {
            "path": CANDIDATE_PATH.name,
            "sha256": PINS["candidate_system"],
            "bytes": len(candidate_bytes),
        },
        "readback": {"verified": True, "candidate_sha256": PINS["candidate_system"]},
        "changes": changes,
        "hardware_qualified": False,
        "production_lifetime_qualified": False,
        "combined_pipeline_layout_qualified": False,
    }
    encoded = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        with output_path.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as exc:
        raise AdapterError(f"OUTPUT_EXISTS: refusing to overwrite {output_path}") from exc
    except OSError as exc:
        raise AdapterError(f"exclusive manifest write failed: {exc}") from exc

    print(json.dumps({
        "manifest": str(output_path),
        "manifest_sha256": sha256(encoded),
        "candidate_sha256": PINS["candidate_system"],
        "candidate_bytes": len(candidate_bytes),
        "approved_hunks": len(EXPECTED_HUNKS),
        "derived_ranges": len(changes),
        "changed_baseline_bytes": 22,
        "appended_bytes": len(candidate_bytes) - len(baseline),
        "installable": False,
        "hardware_qualified": False,
        "production_lifetime_qualified": False,
        "combined_pipeline_layout_qualified": False,
        "source_pins": {
            "acceptance_readback_sha256": sha256(acceptance_bytes),
            "readback_listings_sha256": sha256(readback_listings),
            "sparse_hunks_sha256": PINS["sparse_hunks"],
            "sdk_elf_sha256": PINS["sdk_elf"],
            "optional_root_manifest_sha256": sha256(reference_bytes) if reference_bytes is not None else None,
        },
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AdapterError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
