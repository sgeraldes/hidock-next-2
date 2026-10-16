import hashlib
import json
import pathlib
import re
import sys

image, image_sha, elf_sha, symbols_path, symbols_sha, layout_path, layout_sha, output = sys.argv[1:]

def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

for label, path, expected in (
    ("image", image, image_sha),
    ("symbols", symbols_path, symbols_sha),
    ("layout", layout_path, layout_sha),
):
    actual = sha(path)
    if actual != expected:
        raise SystemExit(f"{label} SHA mismatch: expected {expected}, got {actual}")

layout = json.loads(pathlib.Path(layout_path).read_text(encoding="utf-8"))
link = layout.get("link", {})
layout_elf_sha = link.get("elf_sha256")
if layout_elf_sha != elf_sha:
    raise SystemExit("layout ELF SHA does not match pinned ELF")
if link.get("symbols_sha256") != symbols_sha:
    raise SystemExit("layout symbol-file SHA does not match pinned symbols")

symbols = {}
for line in pathlib.Path(symbols_path).read_text(encoding="utf-8", errors="strict").splitlines():
    match = re.match(r"^\s*([0-9a-fA-F]{8,16})\s+\S\s+(.+?)\s*$", line)
    if match:
        symbols[match.group(2)] = int(match.group(1), 16)

aliases = layout.get("aliases", {})
def addr(name, alias=None):
    if name in symbols:
        return symbols[name]
    if alias:
        value = aliases.get(alias)
        if isinstance(value, dict):
            value = value.get("address")
        if value:
            return int(value, 16)
    raise SystemExit(f"required exact-image symbol is absent: {name}")

required = {
    "console_parse": addr("console630_parse"),
    "console_response": addr("console630_response"),
    "poll_bridge": addr("h1e_vad_native_poll_bridge"),
    "publication_stub": addr("late_publication_stub"),
    "current_parse": addr("console630_parse_current", "console630_parse_current"),
    "current_response": addr("console630_response_current", "console630_response_current"),
}

expected_bytes = pathlib.Path(image).stat().st_size
baseline_bytes = layout.get("baseline", {}).get("bytes")
if baseline_bytes is not None and expected_bytes != baseline_bytes:
    raise SystemExit(f"image byte count mismatch: layout baseline={baseline_bytes}, actual={expected_bytes}")
response_alias = aliases.get("console630_response_current")
if response_alias is None:
    response_alias = layout.get("current_console", {}).get("aliases", {}).get("console630_response_current")
if isinstance(response_alias, dict):
    response_alias = response_alias.get("address")
if response_alias != "0x0112b81c":
    raise SystemExit(f"combined slots response alias mismatch: expected 0x0112b81c, got {response_alias}")
record = {
    "image": str(pathlib.Path(image).resolve()),
    "image_sha256": image_sha,
    "image_bytes": expected_bytes,
    "elf_sha256": elf_sha,
    "symbols_path": str(pathlib.Path(symbols_path).resolve()),
    "symbols_sha256": symbols_sha,
    "layout_path": str(pathlib.Path(layout_path).resolve()),
    "layout_sha256": layout_sha,
    "addresses": {key: f"0x{value:08x}" for key, value in required.items()},
    "fixed_contract": {
        "image_base": "0x01000000",
        "slot": "0x000852c0",
        "pending_command": "0x000855dc",
        "native_getter_model": "0x0101fb68",
        "constructor_success_continuation": "0x01021038",
        "constructor_failure_continuation": "0x01021074",
    },
}
pathlib.Path(output).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": "pins_verified", "image_sha256": image_sha, "elf_sha256": elf_sha, "addresses": record["addresses"]}, sort_keys=True))
