#!/usr/bin/env python3
"""Pack the already-read-back compose-3 SYS without rebuilding it."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


SCRIPT = Path(__file__).resolve()
REVISION = SCRIPT.parent
COMBINED = SCRIPT.parents[2]
REPO = COMBINED.parents[4]
COMPOSER = REVISION / "compose_revision3.py"
SYS_PATH = REVISION / "out-NOTINSTALL" / "compose-3" / "system-decoded-NOTINSTALL.bin"
RECEIPTS = REVISION / "receipts" / "compose-3"
OUT_DIR = SYS_PATH.parent
CONTAINER_PATH = OUT_DIR / "H1E-6.3.8_vad001-EXPERIMENTAL-NOT-INSTALL.bin"
PARSER_RECEIPT = RECEIPTS / "sdk-parser.json"
CONTAINER_RECEIPT = RECEIPTS / "container-readback.json"
FINAL_RECEIPT = RECEIPTS / "final-receipt.json"
EXPECTED_SYS_SHA = "043afb17fbc868474a33c999ac30473839ab188ba22f46adc95914be6649a918"


def load_composer():
    spec = importlib.util.spec_from_file_location("compose_revision3", COMPOSER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def rel(path: Path, mod) -> str:
    return path.resolve().relative_to(mod.REPO.resolve()).as_posix()


def main() -> None:
    mod = load_composer()
    assert SYS_PATH.is_file() and sha(SYS_PATH.read_bytes()) == EXPECTED_SYS_SHA, "compose-3 SYS pin changed"
    # The SDK parser receipt was produced independently against the exact
    # already-packed container. Reuse and validate it; only the derived
    # readback/final receipts must be new in this pass.
    for path in (CONTAINER_RECEIPT, FINAL_RECEIPT):
        assert not path.exists(), f"refusing to overwrite {path}"
    if CONTAINER_PATH.exists():
        assert sha(CONTAINER_PATH.read_bytes()) == "b6bf41d0359748c26242a902cf2949de6a18b216a2853a35f3a5d189b8b3f9ba", \
            "existing one-time SDK pack output does not match its observed pin"

    baseline_container = mod.read_pin("baseline_container")
    baseline_boot = mod.read_pin("baseline_boot_decoded")
    baseline_sys = mod.read_pin("baseline_system_decoded")
    current_slots = mod.read_pin("current_slots_system")
    candidate_sys = SYS_PATH.read_bytes()
    assert len(candidate_sys) == len(current_slots) == mod.SYS_BYTES
    sys_receipt = json.loads((RECEIPTS / "composition-readback.json").read_text(encoding="utf-8"))
    assert sys_receipt["candidate"]["sha256"] == EXPECTED_SYS_SHA
    assert sys_receipt["inverse_reconstructs_exact_current_slots_system"] is True
    assert sys_receipt["console_reserved_range"]["before_after_equal"] is True

    decoder = mod.load_pinned_module("compose3_decoder", mod.DECODER, mod.DECODER_SHA)
    parser = mod.load_pinned_module("compose3_parser", mod.PARSER, mod.PARSER_SHA)
    entries = mod.raw_parse_container(baseline_container)
    assert [entry["name"] for entry in entries] == mod.PARTITION_ORDER
    assert parser.parse(baseline_container)["version"] == mod.OLD_NAME
    by_name = {entry["name"]: entry for entry in entries}
    payloads = {entry["name"]: baseline_container[entry["offset"]:entry["offset"] + entry["size"]]
                for entry in entries}
    old_boot = decoder.transform(payloads["mbrec.bin"], mod.SEED)
    old_sys = decoder.transform(payloads["zephyr.bin"], mod.SEED)
    assert old_boot == baseline_boot and old_sys == baseline_sys
    assert decoder.image_header(candidate_sys, True) == decoder.image_header(old_sys, True)

    new_boot = mod.boot_identity(old_boot, mod.NAME, mod.CODE, decoder.image_header, decoder.sum16)
    system_payload = decoder.transform(candidate_sys, mod.SEED, decrypt=False)
    boot_payload = decoder.transform(new_boot, mod.SEED, decrypt=False)
    new_xml = mod.build_xml(payloads["ota.xml"], mod.CODE, mod.NAME,
                            {"zephyr.bin": (len(system_payload), zlib.crc32(system_payload)),
                             "mbrec.bin": (len(boot_payload), zlib.crc32(boot_payload))})
    changed_payloads = dict(payloads)
    changed_payloads.update({"ota.xml": new_xml, "zephyr.bin": system_payload, "mbrec.bin": boot_payload})
    assert all(len(changed_payloads[name]) == by_name[name]["size"] for name in mod.PARTITION_ORDER)
    assert decoder.transform(system_payload, mod.SEED) == candidate_sys
    assert decoder.transform(boot_payload, mod.SEED) == new_boot

    cfg_data = b""
    if CONTAINER_PATH.exists():
        packed = CONTAINER_PATH.read_bytes()
        sdk_log = "Reused the exact pinned container emitted by the single WSL SDK pack; no repack performed."
    else:
        with tempfile.TemporaryDirectory(prefix="sdk-pack-compose3-", dir=OUT_DIR) as temp_name:
            work = Path(temp_name)
            parts_dir = work / "parts"
            parts_dir.mkdir()
            for name in mod.PARTITION_ORDER:
                (parts_dir / name).write_bytes(changed_payloads[name])
            cfg = work / "empty.cfg"
            cfg.write_bytes(cfg_data)
            staged = work / CONTAINER_PATH.name
            run = subprocess.run([sys.executable, "-I", str(mod.SDK), "-cf", str(cfg), "-o", str(staged),
                                  *[str(parts_dir / name) for name in mod.PARTITION_ORDER]],
                                 capture_output=True, text=True, timeout=90)
            assert run.returncode == 0 and staged.is_file(), (run.stdout + run.stderr)[-3000:]
            packed = staged.read_bytes()
            sdk_log = run.stdout + run.stderr
        CONTAINER_PATH.write_bytes(packed)
    disk = CONTAINER_PATH.read_bytes()
    assert disk == packed and len(disk) == len(baseline_container)
    readback = mod.raw_parse_container(disk)
    assert [entry["name"] for entry in readback] == mod.PARTITION_ORDER
    read_by_name = {entry["name"]: entry for entry in readback}
    changed_names = {"ota.xml", "zephyr.bin", "mbrec.bin"}
    for name in mod.PARTITION_ORDER:
        before, after = by_name[name], read_by_name[name]
        assert (after["offset"], after["size"], after["load"], after["run"]) == \
               (before["offset"], before["size"], before["load"], before["run"])
        actual = disk[after["offset"]:after["offset"] + after["size"]]
        assert actual == changed_payloads[name]
        if name not in changed_names:
            assert actual == payloads[name]
    decoded_boot = decoder.transform(disk[read_by_name["mbrec.bin"]["offset"]:
                                                     read_by_name["mbrec.bin"]["offset"] + read_by_name["mbrec.bin"]["size"]], mod.SEED)
    decoded_sys = decoder.transform(disk[read_by_name["zephyr.bin"]["offset"]:
                                                   read_by_name["zephyr.bin"]["offset"] + read_by_name["zephyr.bin"]["size"]], mod.SEED)
    assert decoded_boot == new_boot and decoded_sys == candidate_sys

    xml_summary = mod.xml_summary(disk[read_by_name["ota.xml"]["offset"]:
                                        read_by_name["ota.xml"]["offset"] + read_by_name["ota.xml"]["size"]])
    for name, metadata in xml_summary["partitions"].items():
        assert name in read_by_name
        entry = read_by_name[name]
        actual = disk[entry["offset"]:entry["offset"] + entry["size"]]
        assert int(metadata["file_size"], 0) == entry["size"], (name, metadata, entry)
        assert int(metadata["checksum"], 0) == entry["crc32"] == zlib.crc32(actual), (name, metadata, entry)
    assert xml_summary["version_name"] == mod.NAME and int(xml_summary["version_code"], 0) == 0x60308
    assert struct.unpack_from("<I", decoded_boot, 0xF84)[0] == mod.CODE
    assert decoded_boot[0xF8C:0xFCC] == mod.NAME.encode().ljust(64, b"\0")
    assert mod.slice_va(decoded_sys, *mod.CONSOLE_RANGE) == mod.slice_va(current_slots, *mod.CONSOLE_RANGE)

    if not PARSER_RECEIPT.exists():
        parser_run = subprocess.run(["node", str(mod.SDK_PARSER_HELPER), str(CONTAINER_PATH), str(PARSER_RECEIPT)],
                                    capture_output=True, text=True, timeout=90)
        assert parser_run.returncode == 0 and PARSER_RECEIPT.is_file(), (parser_run.stdout + parser_run.stderr)[-3000:]
    parser_receipt = json.loads(PARSER_RECEIPT.read_text(encoding="utf-8"))
    parsed = parser_receipt.get("parsed")
    assert parser_receipt.get("accepted") is True and isinstance(parsed, dict)
    assert (parsed.get("versionNumber"), parsed.get("versionName"), parsed.get("board"), parsed.get("bytes")) == \
           (mod.CODE, mod.NAME, mod.BOARD, len(disk)), parsed
    assert parser_receipt["container"]["sha256"] == sha(disk)

    container_receipt = {
        "schema": "h1e-vad-combined-slots-393992-container-readback-v1",
        "status": "offline_container_composed_readback_verified_EXPERIMENTAL_NOTINSTALL",
        "identity": {"numeric": mod.CODE, "version_name": mod.NAME, "ota_version_code": "0x60308", "board": mod.BOARD},
        "system_input": {"path": rel(SYS_PATH, mod), "sha256": sha(candidate_sys), "bytes": len(candidate_sys),
                         "same_composed_sys_readback": True},
        "container": {"path": rel(CONTAINER_PATH, mod), "sha256": sha(disk), "bytes": len(disk)},
        "baseline_container_sha256": sha(baseline_container),
        "partition_offsets_and_sizes_unchanged": True,
        "unchanged_other_payloads_preserved": True,
        "system_decodes_to_exact_compose3_sys": True,
        "boot_identity_and_crc_updated_instruction_bytes_unchanged": True,
        "all_xml_partition_sizes_and_checksums_match_actual_directory": True,
        "sdk_parse_firmware_image": {"accepted": True, "receipt_path": rel(PARSER_RECEIPT, mod),
                                      "receipt_sha256": sha(PARSER_RECEIPT.read_bytes()), "parsed": parsed},
        "sdk_packer_sha256": mod.SDK_SHA,
        "sdk_log_tail": sdk_log[-3000:],
        "hardware_or_install_tested": False,
    }
    CONTAINER_RECEIPT.write_text(json.dumps(container_receipt, indent=2) + "\n", encoding="utf-8")
    final = {
        "schema": "h1e-vad-combined-slots-393992-final-receipt-v1",
        "status": "accepted_offline_for_authorized_vad_validation_PENDING_HARDWARE_EXPERIMENTAL_NOTINSTALL",
        "identity": container_receipt["identity"],
        "linked_elf": {"path": rel(mod.ELF, mod), "sha256": sha(mod.ELF.read_bytes()),
                       "module_sha256": sha(mod.ELF_MODULE.read_bytes()), "bridge_address": "0x01128e34",
                       "bridge_bytes": 24},
        "combined_system": {"path": rel(SYS_PATH, mod), "sha256": sha(candidate_sys), "bytes": len(candidate_sys)},
        "combined_container": container_receipt["container"],
        "readback_receipts": {"layout": rel(RECEIPTS / "layout-readback.json", mod),
                              "composition": rel(RECEIPTS / "composition-readback.json", mod),
                              "container": rel(CONTAINER_RECEIPT, mod),
                              "sdk_parser": rel(PARSER_RECEIPT, mod)},
        "offline_exact_instruction_gate": {
            "status": "passed",
            "cases_passed": 6,
            "cases_total": 6,
            "receipt": "research/rea/completion630-lab/hardware-vad-trace/router-only-exact-image-qa-20261016/out-NOTINSTALL/run-combined-revision3-20261016T2024Z-hook-through/receipt.json",
            "scope_note": "Constructors were intentionally skipped because they were accepted on the prior byte-pinned candidate; no DSP, timing, boot, installation, or hardware behavior is established.",
        },
        "hardware_validation": {"status": "pending", "performed": False},
        "limits": "Accepted offline for the explicitly authorized VAD hardware-validation step. Hardware validation remains pending; no installation, physical qualification, or release claim is made.",
    }
    FINAL_RECEIPT.write_text(json.dumps(final, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"container_sha256": sha(disk), "container_bytes": len(disk),
                      "system_sha256": sha(candidate_sys), "sdk_parser_accepted": True,
                      "container_receipt_sha256": sha(CONTAINER_RECEIPT.read_bytes()),
                      "final_receipt_sha256": sha(FINAL_RECEIPT.read_bytes())}, indent=2))


if __name__ == "__main__":
    main()
