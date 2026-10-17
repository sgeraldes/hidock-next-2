import hashlib
import json
import pathlib
import re
import sys

(image_path, image_sha, reference_elf_path, reference_elf_sha,
 symbols_path, symbols_sha, layout_path, layout_sha,
 compatibility_path, compatibility_sha,
 manifest_path, manifest_sha, output_path) = sys.argv[1:]

def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

for label, path, expected in (
    ("candidate SYS", image_path, image_sha),
    ("reference-only ELF", reference_elf_path, reference_elf_sha),
    ("reference symbols", symbols_path, symbols_sha),
    ("reference layout", layout_path, layout_sha),
    ("compatibility report", compatibility_path, compatibility_sha),
    ("composition manifest", manifest_path, manifest_sha),
):
    actual = sha(path)
    if actual != expected:
        raise SystemExit(f"{label} SHA mismatch: expected {expected}, got {actual}")

image = pathlib.Path(image_path).read_bytes()
if len(image) != 1237504:
    raise SystemExit(f"candidate SYS byte count mismatch: {len(image)}")
if image_sha != "05d7d9e2d725b4624b4746b09cea58eed9aded63b1fc377255ac2c5fc41dec8b":
    raise SystemExit("candidate SYS SHA is not the reviewed 393993 pin")

layout = json.loads(pathlib.Path(layout_path).read_text(encoding="utf-8"))
if layout.get("schema") != "h1e-vad-combined-slots-393992-layout-v1":
    raise SystemExit("reference layout is not the pinned 393992 symbol layout")
link = layout.get("link", {})
if link.get("elf_sha256") != reference_elf_sha:
    raise SystemExit("reference layout ELF SHA mismatch")
if link.get("symbols_sha256") != symbols_sha:
    raise SystemExit("reference layout symbols SHA mismatch")
baseline = layout.get("baseline", {})
if baseline.get("sha256") != "ebee46c51239a4ad971c54cf4b4c12e2a29d516aebd15065ec258de099168771":
    raise SystemExit("reference layout baseline SYS pin mismatch")
if baseline.get("load_base") != "0x01000000":
    raise SystemExit("reference layout load base mismatch")

symbols = {}
for line in pathlib.Path(symbols_path).read_text(encoding="utf-8", errors="strict").splitlines():
    match = re.match(r"^\s*([0-9a-fA-F]{8,16})\s+\S\s+(.+?)\s*$", line)
    if match:
        symbols[match.group(2)] = int(match.group(1), 16)

required_symbols = {
    "console630_response": 0x01128bf4,
    "h1e_vad_native_poll_bridge": 0x01128e34,
}
for name, expected in required_symbols.items():
    actual = symbols.get(name)
    if actual != expected:
        raise SystemExit(f"reference-only symbol {name} mismatch: expected 0x{expected:08x}, got {actual}")

manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
candidate = manifest.get("candidateSystem", {})
if candidate.get("sha256") != image_sha or candidate.get("bytes") != len(image):
    raise SystemExit("composition manifest does not pin the requested candidate SYS")
expected_patches = {
    0x01128cfc: ("00e0fe18", "0x0112bef8"),
    0x01128db4: ("00e04218", "0x0112be38"),
}
manifest_patches = {}
for patch in manifest.get("allowedInstructionChanges", []):
    try:
        address = int(patch["address"], 16)
        replacement = patch["replacementHex"].lower()
        target = patch["targetAfter"].lower()
    except (KeyError, TypeError, ValueError):
        continue
    manifest_patches[address] = (replacement, target)
for address, expected in expected_patches.items():
    if manifest_patches.get(address) != expected:
        raise SystemExit(f"manifest wrapper patch mismatch at 0x{address:08x}: {manifest_patches.get(address)}")

exact_sites = {
    0x01020b62: "08e06941",
    0x0103907a: "07e00d7f",
    0x0103a996: "07e05b72",
    0x01128cfc: "00e0fe18",
    0x01128db4: "00e04218",
}
for address, expected_hex in exact_sites.items():
    offset = address - 0x01000000
    actual_hex = image[offset:offset + len(expected_hex) // 2].hex()
    if actual_hex != expected_hex:
        raise SystemExit(f"candidate SYS bytes mismatch at 0x{address:08x}: expected {expected_hex}, got {actual_hex}")

compatibility_text = pathlib.Path(compatibility_path).read_text(encoding="utf-8")
for required_text in ("05d7d9e2d725b4624b4746b09cea58eed9aded63b1fc377255ac2c5fc41dec8b", "0x01128e34", "0x0112be38", "0x0112bef8"):
    if required_text not in compatibility_text:
        raise SystemExit(f"compatibility report missing required pin/reference: {required_text}")

reference_artifacts = {
    "role": "address/symbol reference only for unchanged 393992 entrypoints; not the candidate ELF and not proof of 393993 link identity",
    "firmware": "393992",
    "elf_path": str(pathlib.Path(reference_elf_path).resolve()),
    "elf_sha256": reference_elf_sha,
    "symbols_path": str(pathlib.Path(symbols_path).resolve()),
    "symbols_sha256": symbols_sha,
    "layout_path": str(pathlib.Path(layout_path).resolve()),
    "layout_sha256": layout_sha,
    "layout_baseline_system_sha256": baseline["sha256"],
    "resolved_addresses": {name: f"0x{value:08x}" for name, value in required_symbols.items()},
}
record = {
    "image": str(pathlib.Path(image_path).resolve()),
    "image_sha256": image_sha,
    "image_bytes": len(image),
    "candidate_elf_sha256": None,
    "candidate_elf_available": False,
    "reference_artifacts": reference_artifacts,
    "compatibility_report_path": str(pathlib.Path(compatibility_path).resolve()),
    "compatibility_report_sha256": compatibility_sha,
    "composition_manifest_path": str(pathlib.Path(manifest_path).resolve()),
    "composition_manifest_sha256": manifest_sha,
    "manifest_predecessor_system_sha256": manifest.get("sourceSystem", {}).get("sha256"),
    "addresses": {
        "console_response": "0x01128bf4",
        "poll_bridge": "0x01128e34",
        "poll_hook": "0x01020b62",
        "poll_continuation": "0x01020b66",
        "native_getter_model": "0x0101fb68",
    },
    "exact_candidate_site_bytes": {f"0x{address:08x}": value for address, value in exact_sites.items()},
    "fixture_contract": {
        "image_base": "0x01000000",
        "slot": "0x000852c0",
        "pending_command": "0x000855dc",
        "native_getter_output_pointer": "0x0038e100",
        "native_getter_output_interval": "[0x0038e000,0x00390000)",
        "poll_hook_entry": "0x01020b62",
        "poll_stop": "0x01020b66",
    },
}
pathlib.Path(output_path).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": "four_case_pins_verified", "image_sha256": image_sha, "image_bytes": len(image), "reference_elf_role": reference_artifacts["role"], "addresses": record["addresses"]}, sort_keys=True))
